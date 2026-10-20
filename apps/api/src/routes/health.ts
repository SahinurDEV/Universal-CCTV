import { Router } from "express";
import { prisma } from "../lib/db.js";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";

export const healthRouter = Router();

/** Liveness: process is up and able to respond. No dependency checks. */
healthRouter.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

/**
 * Readiness: process can actually serve traffic — checks the dependencies the
 * API needs on the request path (DB, Redis). Returns 503 if any check fails,
 * with per-dependency detail so an operator can tell what's down.
 */
healthRouter.get("/ready", async (_req, res) => {
  const checks: Record<string, "ok" | "failed"> = {};
  let allOk = true;

  try {
    await prisma.$queryRaw`SELECT 1`;
    checks.database = "ok";
  } catch (err) {
    checks.database = "failed";
    allOk = false;
    logger.error({ err }, "readiness check: database failed");
  }

  try {
    if (redis.status === "end" || redis.status === "wait") {
      await redis.connect();
    }
    await redis.ping();
    checks.redis = "ok";
  } catch (err) {
    checks.redis = "failed";
    allOk = false;
    logger.error({ err }, "readiness check: redis failed");
  }

  res.status(allOk ? 200 : 503).json({ status: allOk ? "ok" : "degraded", checks });
});
