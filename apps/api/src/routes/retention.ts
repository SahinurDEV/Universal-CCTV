import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { writeAuditLog } from "../lib/audit.js";
import { getActiveSubscription, getStorageBytesUsed } from "../lib/quota.js";
import { effectiveRetentionDays } from "../recording/retention.js";

/**
 * Day-based recording retention.
 *   GET /retention                 workspace days, per-camera overrides,
 *                                  effective values and storage used (any role)
 *   PUT /retention                 { retentionDays: 1..3650 | null } (OWNER/ADMIN)
 *   PUT /retention/cameras/:id     { retentionDays: 1..3650 | null } (OWNER/ADMIN)
 * Values above the plan's maxRetentionDays are rejected (402).
 */
export const retentionRouter = Router();
retentionRouter.use(requireAuth, requireTenant);

const daysSchema = z.object({ retentionDays: z.number().int().min(1).max(3650).nullable() });

async function planLimit(tenantId: string): Promise<{ limit: number; planName: string } | null> {
  const sub = await getActiveSubscription(tenantId);
  return sub ? { limit: sub.plan.maxRetentionDays, planName: sub.plan.name } : null;
}

retentionRouter.get("/", asyncHandler(async (req, res) => {
  const tenantId = req.authTenant!.id;
  const [tenant, cameras, usage, bytesUsed, plan] = await Promise.all([
    prisma.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { retentionDays: true } }),
    prisma.camera.findMany({ where: { tenantId }, select: { id: true, name: true, retentionDaysOverride: true }, orderBy: { name: "asc" } }),
    prisma.recordingSegment.groupBy({
      by: ["cameraId"],
      where: { tenantId, status: { in: ["COMPLETE", "EXPIRED"] } },
      _sum: { fileSizeBytes: true },
      _count: { _all: true },
      _min: { startedAt: true },
    }),
    getStorageBytesUsed(tenantId),
    planLimit(tenantId),
  ]);
  const byCam = new Map(usage.map((u) => [u.cameraId, u]));
  res.json({
    workspaceRetentionDays: tenant.retentionDays,
    planMaxRetentionDays: plan?.limit ?? null,
    totalBytes: bytesUsed.toString(),
    canEdit: ["OWNER", "ADMIN"].includes(req.authTenant!.role),
    cameras: cameras.map((c) => {
      const u = byCam.get(c.id);
      return {
        cameraId: c.id,
        cameraName: c.name,
        overrideDays: c.retentionDaysOverride,
        effectiveDays: effectiveRetentionDays(c.retentionDaysOverride, tenant.retentionDays),
        bytes: (u?._sum.fileSizeBytes ?? 0n).toString(),
        segmentCount: u?._count._all ?? 0,
        oldestRecordingAt: u?._min.startedAt ?? null,
      };
    }),
  });
}));

async function checkPlan(tenantId: string, days: number | null) {
  if (days === null) return null;
  const plan = await planLimit(tenantId);
  if (plan && days > plan.limit) {
    return { error: "retention_exceeds_plan", message: `Your ${plan.planName} plan allows up to ${plan.limit} days of retention.`, limit: plan.limit };
  }
  return null;
}

retentionRouter.put("/", requireRole("OWNER", "ADMIN"), asyncHandler(async (req, res) => {
  const parsed = daysSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  const tenantId = req.authTenant!.id;
  const over = await checkPlan(tenantId, parsed.data.retentionDays);
  if (over) return res.status(402).json(over);
  const t = await prisma.tenant.update({ where: { id: tenantId }, data: { retentionDays: parsed.data.retentionDays } });
  await writeAuditLog({ tenantId, actorUserId: req.authUser!.id, action: "retention.workspace_update", targetType: "Tenant", targetId: tenantId, metadata: { retentionDays: t.retentionDays ?? "unset" } });
  res.json({ workspaceRetentionDays: t.retentionDays });
}));

retentionRouter.put("/cameras/:id", requireRole("OWNER", "ADMIN"), asyncHandler(async (req, res) => {
  const id = z.string().uuid().safeParse(req.params.id);
  if (!id.success) return res.status(404).json({ error: "not_found" });
  const tenantId = req.authTenant!.id;
  const camera = await prisma.camera.findFirst({ where: { id: id.data, tenantId } });
  if (!camera) return res.status(404).json({ error: "not_found" });
  const parsed = daysSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  const over = await checkPlan(tenantId, parsed.data.retentionDays);
  if (over) return res.status(402).json(over);
  const c = await prisma.camera.update({ where: { id: camera.id }, data: { retentionDaysOverride: parsed.data.retentionDays } });
  await writeAuditLog({ tenantId, actorUserId: req.authUser!.id, action: "retention.camera_update", targetType: "Camera", targetId: camera.id, metadata: { retentionDays: c.retentionDaysOverride ?? "workspace default" } });
  res.json({ cameraId: c.id, overrideDays: c.retentionDaysOverride });
}));
