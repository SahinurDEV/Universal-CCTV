import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireRole, requireTenant } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { writeAuditLog } from "../lib/audit.js";
import { isValidTimeZone } from "../lib/schedule.js";

/** Workspace-level settings: GET /workspace, PUT /workspace/timezone. */
export const workspaceRouter = Router();
workspaceRouter.use(requireAuth, requireTenant);

workspaceRouter.get("/", asyncHandler(async (req, res) => {
  const t = await prisma.tenant.findUniqueOrThrow({ where: { id: req.authTenant!.id }, select: { id: true, name: true, timezone: true } });
  res.json({ ...t, role: req.authTenant!.role });
}));

const tzSchema = z.object({ timezone: z.string().trim().min(1).max(64).refine(isValidTimeZone, "unknown timezone") });

workspaceRouter.put("/timezone", requireRole("OWNER", "ADMIN"), asyncHandler(async (req, res) => {
  const parsed = tzSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  const t = await prisma.tenant.update({ where: { id: req.authTenant!.id }, data: { timezone: parsed.data.timezone }, select: { id: true, name: true, timezone: true } });
  await writeAuditLog({
    tenantId: t.id,
    actorUserId: req.authUser!.id,
    action: "workspace.timezone.update",
    targetType: "Tenant",
    targetId: t.id,
    metadata: { timezone: t.timezone },
  });
  res.json(t);
}));
