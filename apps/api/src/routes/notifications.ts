import { Router } from "express";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { mutedTypesFrom } from "../lib/notification-prefs.js";

async function mutedTypesFor(tenantId: string, userId: string) {
  const membership = await prisma.membership.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { notificationPreferences: true },
  });
  return mutedTypesFrom(membership?.notificationPreferences);
}

export const notificationsRouter = Router();

notificationsRouter.get("/", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  // Alert types this member muted in Settings are hidden from their list
  // and badge (other members still see them).
  const muted = await mutedTypesFor(req.authTenant!.id, req.authUser!.id);
  const typeFilter = muted.length ? { type: { notIn: muted } } : {};
  const notifications = await prisma.notification.findMany({
    where: { tenantId: req.authTenant!.id, ...typeFilter },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  const unreadCount = await prisma.notification.count({
    where: { tenantId: req.authTenant!.id, readAt: null, ...typeFilter },
  });

  res.json({ notifications, unreadCount });
}));

notificationsRouter.post("/:id/read", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  const notification = await prisma.notification.findFirst({
    where: { id: req.params.id, tenantId: req.authTenant!.id },
  });
  if (!notification) {
    return res.status(404).json({ error: "not_found" });
  }

  const updated = await prisma.notification.update({
    where: { id: notification.id },
    data: { readAt: notification.readAt ?? new Date() },
  });
  res.json(updated);
}));

notificationsRouter.post("/read-all", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  await prisma.notification.updateMany({
    where: { tenantId: req.authTenant!.id, readAt: null },
    data: { readAt: new Date() },
  });
  res.status(204).send();
}));
