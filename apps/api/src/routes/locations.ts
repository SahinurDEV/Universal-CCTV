import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { writeAuditLog } from "../lib/audit.js";

/**
 * Locations (sites): a named place such as "Head office" or "Warehouse 2"
 * that groups cameras. Every query is scoped to the caller's active tenant;
 * another tenant's location id always behaves exactly like a missing one
 * (404), never 403, so ids can't be probed across tenants.
 */
export const locationsRouter = Router();
locationsRouter.use(requireAuth, requireTenant);

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const locationBody = {
  name: z.string().trim().min(1).max(200),
  address: z.string().trim().max(500).nullable().optional(),
  timezone: z.string().trim().max(64).refine(isValidTimezone, "Unknown time zone").optional(),
};
const createSchema = z.object(locationBody);
const updateSchema = z.object({
  name: locationBody.name.optional(),
  address: locationBody.address,
  timezone: locationBody.timezone,
});
const assignSchema = z.object({ cameraIds: z.array(z.string().uuid()).min(1).max(500) });

function serialize(loc: {
  id: string;
  name: string;
  address: string | null;
  timezone: string;
  createdAt: Date;
  _count?: { cameras: number };
}) {
  return {
    id: loc.id,
    name: loc.name,
    address: loc.address,
    timezone: loc.timezone,
    createdAt: loc.createdAt,
    cameraCount: loc._count?.cameras ?? 0,
  };
}

locationsRouter.get("/", asyncHandler(async (req, res) => {
  const locations = await prisma.location.findMany({
    where: { tenantId: req.authTenant!.id },
    include: { _count: { select: { cameras: true } } },
    orderBy: { name: "asc" },
  });
  res.json({ locations: locations.map(serialize) });
}));

locationsRouter.get("/:id", asyncHandler(async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  if (!parsedId.success) return res.status(404).json({ error: "not_found" });
  const location = await prisma.location.findFirst({
    where: { id: parsedId.data, tenantId: req.authTenant!.id },
    include: {
      _count: { select: { cameras: true } },
      cameras: { select: { id: true, name: true, connectorType: true }, orderBy: { name: "asc" } },
    },
  });
  if (!location) return res.status(404).json({ error: "not_found" });
  res.json({ ...serialize(location), cameras: location.cameras });
}));

locationsRouter.post("/", requireRole("OWNER", "ADMIN"), asyncHandler(async (req, res) => {
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  const location = await prisma.location.create({
    data: {
      tenantId: req.authTenant!.id,
      name: parsed.data.name,
      address: parsed.data.address ?? null,
      timezone: parsed.data.timezone ?? "UTC",
    },
  });
  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "location.create",
    targetType: "Location",
    targetId: location.id,
    metadata: { name: location.name },
  });
  res.status(201).json(serialize(location));
}));

locationsRouter.patch("/:id", requireRole("OWNER", "ADMIN"), asyncHandler(async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  if (!parsedId.success) return res.status(404).json({ error: "not_found" });
  const existing = await prisma.location.findFirst({ where: { id: parsedId.data, tenantId: req.authTenant!.id } });
  if (!existing) return res.status(404).json({ error: "not_found" });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  const location = await prisma.location.update({
    where: { id: existing.id },
    data: parsed.data,
    include: { _count: { select: { cameras: true } } },
  });
  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "location.update",
    targetType: "Location",
    targetId: location.id,
    metadata: { fields: Object.keys(parsed.data) },
  });
  res.json(serialize(location));
}));

/** Deleting a location never deletes cameras — they become "unassigned"
 * (schema: Camera.location onDelete SetNull). */
locationsRouter.delete("/:id", requireRole("OWNER", "ADMIN"), asyncHandler(async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  if (!parsedId.success) return res.status(404).json({ error: "not_found" });
  const existing = await prisma.location.findFirst({ where: { id: parsedId.data, tenantId: req.authTenant!.id } });
  if (!existing) return res.status(404).json({ error: "not_found" });
  await prisma.location.delete({ where: { id: existing.id } });
  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "location.delete",
    targetType: "Location",
    targetId: existing.id,
  });
  res.status(204).send();
}));

/** Bulk-assign cameras to this location. Every camera id must belong to the
 * caller's tenant, otherwise nothing is changed. */
locationsRouter.post("/:id/cameras", requireRole("OWNER", "ADMIN", "OPERATOR"), asyncHandler(async (req, res) => {
  const parsedId = z.string().uuid().safeParse(req.params.id);
  if (!parsedId.success) return res.status(404).json({ error: "not_found" });
  const location = await prisma.location.findFirst({ where: { id: parsedId.data, tenantId: req.authTenant!.id } });
  if (!location) return res.status(404).json({ error: "not_found" });

  const parsed = assignSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }
  const ids = [...new Set(parsed.data.cameraIds)];
  const owned = await prisma.camera.count({ where: { id: { in: ids }, tenantId: req.authTenant!.id } });
  if (owned !== ids.length) {
    return res.status(400).json({ error: "invalid_camera" });
  }
  await prisma.camera.updateMany({
    where: { id: { in: ids }, tenantId: req.authTenant!.id },
    data: { locationId: location.id },
  });
  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "location.assign_cameras",
    targetType: "Location",
    targetId: location.id,
    metadata: { cameraIds: ids },
  });
  res.json({ assigned: ids.length });
}));
