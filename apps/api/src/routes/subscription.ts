import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant, requireRole } from "../middleware/auth.js";
import { getActiveSubscription, getCameraCount, getStorageBytesUsed } from "../lib/quota.js";
import { getBillingProvider } from "../billing/provider.js";
import { writeAuditLog } from "../lib/audit.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const subscriptionRouter = Router();

subscriptionRouter.get("/plans", asyncHandler(async (_req, res) => {
  const plans = await prisma.subscriptionPlan.findMany({
    where: { isActive: true },
    orderBy: { priceCentsMonthly: "asc" },
  });
  res.json({ plans });
}));

subscriptionRouter.get("/", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  const tenantId = req.authTenant!.id;
  const subscription = await getActiveSubscription(tenantId);
  if (!subscription) {
    // Genuinely possible if prisma/seed.ts hadn't run yet when this tenant
    // registered — not an error on the caller's part, just "nothing to show."
    return res.json({ subscription: null, usage: null });
  }

  const [cameraCount, storageBytesUsed] = await Promise.all([
    getCameraCount(tenantId),
    getStorageBytesUsed(tenantId),
  ]);

  res.json({
    subscription: {
      id: subscription.id,
      status: subscription.status,
      billingProvider: subscription.billingProvider,
      currentPeriodEnd: subscription.currentPeriodEnd,
      plan: subscription.plan,
    },
    usage: {
      cameraCount,
      cameraLimit: subscription.plan.cameraLimit,
      storageBytesUsed: storageBytesUsed.toString(),
      storageQuotaBytes: (BigInt(subscription.plan.storageQuotaGb) * 1024n * 1024n * 1024n).toString(),
    },
  });
}));

const changePlanSchema = z.object({ planKey: z.string().min(1) });

subscriptionRouter.post("/change", requireAuth, requireTenant, requireRole("OWNER", "ADMIN"), asyncHandler(async (req, res) => {
  const tenantId = req.authTenant!.id;
  const parsed = changePlanSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: "invalid_request", details: parsed.error.issues });
  }

  const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
  if (!subscription) {
    return res.status(404).json({ error: "no_subscription" });
  }

  const newPlan = await prisma.subscriptionPlan.findFirst({
    where: { key: parsed.data.planKey, isActive: true },
  });
  if (!newPlan) {
    return res.status(400).json({ error: "invalid_plan" });
  }

  // Downgrading below the current camera count is allowed (matches "do not
  // delete/disable anything automatically on downgrade" — nothing here
  // deletes a camera), but new cameras will be blocked by the camera-limit
  // check until the tenant is back under the new limit. Surfacing that
  // clearly up front rather than letting it be a silent surprise later.
  const cameraCount = await getCameraCount(tenantId);
  const overCameraLimit = cameraCount > newPlan.cameraLimit;

  const billingProvider = getBillingProvider();
  const result = await billingProvider.changePlan({ subscription, newPlan });

  const updated = await prisma.subscription.update({
    where: { tenantId },
    data: {
      planId: newPlan.id,
      status: result.status,
      currentPeriodEnd: result.currentPeriodEnd,
      billingProvider: billingProvider.name,
      externalCustomerId: result.externalCustomerId,
    },
    include: { plan: true },
  });

  await writeAuditLog({
    tenantId,
    actorUserId: req.authUser!.id,
    action: "subscription.change_plan",
    targetType: "Subscription",
    targetId: updated.id,
    metadata: { newPlanKey: newPlan.key, billingProvider: billingProvider.name },
  });

  res.json({ subscription: updated, overCameraLimit });
}));

subscriptionRouter.post("/cancel", requireAuth, requireTenant, requireRole("OWNER"), asyncHandler(async (req, res) => {
  const tenantId = req.authTenant!.id;
  const subscription = await prisma.subscription.findUnique({ where: { tenantId } });
  if (!subscription) {
    return res.status(404).json({ error: "no_subscription" });
  }

  const billingProvider = getBillingProvider();
  const result = await billingProvider.cancel({ subscription });

  const updated = await prisma.subscription.update({
    where: { tenantId },
    data: { status: result.status, currentPeriodEnd: result.currentPeriodEnd },
    include: { plan: true },
  });

  await writeAuditLog({
    tenantId,
    actorUserId: req.authUser!.id,
    action: "subscription.cancel",
    targetType: "Subscription",
    targetId: updated.id,
  });

  res.json({ subscription: updated });
}));
