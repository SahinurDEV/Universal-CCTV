import { Redis } from "ioredis";
import { loadEnv } from "../env.js";
import { logger } from "./logger.js";

const env = loadEnv();

/**
 * `lazyConnect` + `maxRetriesPerRequest: null` is required for BullMQ-compatible
 * usage later; for plain health checks we connect eagerly via `.connect()` in
 * the health route so a dead Redis fails the readiness probe immediately
 * instead of silently queueing commands.
 */
export const redis = new Redis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  lazyConnect: true,
  retryStrategy: () => null, // let callers (e.g. /ready) observe failure instead of retrying forever
});

// ioredis emits 'error' as a plain EventEmitter event — without a listener,
// a connection failure (e.g. Redis down) surfaces as an unhandled-error crash
// risk instead of the readiness check's own try/catch. The readiness route
// still reports the failure; this just prevents a second, noisy path for it.
redis.on("error", (err: Error) => {
  logger.warn({ err }, "redis connection error");
});
