import { Router } from "express";
import { prisma } from "../lib/db.js";
import { redis } from "../lib/redis.js";
import { logger } from "../lib/logger.js";
import { asyncHandler } from "../middleware/async-handler.js";

export const healthRouter = Router();

const READINESS_CHECK_TIMEOUT_MS = 3000;

/**
 * Bounds how long a single dependency check can take. A real bug was found
 * and fixed here: without this, stopping Redis made `/ready` take ~28
 * seconds to respond (ioredis's own connection-close detection, not an
 * infinite hang, but still far slower than any real load balancer/k8s
 * readiness-probe timeout would tolerate) — confirmed by timing an actual
 * request against a running server with Redis stopped. A readiness probe
 * that's itself slow to answer is as operationally bad as one that lies.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} check timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/** Liveness: process is up and able to respond. No dependency checks. */
healthRouter.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

/**
 * Readiness: process can actually serve traffic — checks the dependencies the
 * API needs on the request path (DB, Redis). Returns 503 if any check fails,
 * with per-dependency detail so an operator can tell what's down.
 */
healthRouter.get("/ready", asyncHandler(async (_req, res) => {
  const checks: Record<string, "ok" | "failed"> = {};
  let allOk = true;

  try {
    await withTimeout(prisma.$queryRaw`SELECT 1`, READINESS_CHECK_TIMEOUT_MS, "database");
    checks.database = "ok";
  } catch (err) {
    checks.database = "failed";
    allOk = false;
    logger.error({ err }, "readiness check: database failed");
  }

  try {
    await withTimeout(
      (async () => {
        if (redis.status === "end" || redis.status === "wait") {
          await redis.connect();
        }
        await redis.ping();
      })(),
      READINESS_CHECK_TIMEOUT_MS,
      "redis",
    );
    checks.redis = "ok";
  } catch (err) {
    checks.redis = "failed";
    allOk = false;
    logger.error({ err }, "readiness check: redis failed");
  }

  res.status(allOk ? 200 : 503).json({ status: allOk ? "ok" : "degraded", checks });
}));
