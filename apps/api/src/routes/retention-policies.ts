import { Router } from "express";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const retentionPoliciesRouter = Router();

retentionPoliciesRouter.get("/", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  const policies = await prisma.retentionPolicy.findMany({
    where: { tenantId: req.authTenant!.id },
    orderBy: { retentionDays: "asc" },
  });
  res.json({ policies });
}));
