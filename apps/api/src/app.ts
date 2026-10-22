import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import { loadEnv } from "./env.js";
import { logger } from "./lib/logger.js";
import { healthRouter } from "./routes/health.js";
import { authRouter } from "./routes/auth.js";
import { camerasRouter } from "./routes/cameras.js";
import { recordingRouter } from "./routes/recording.js";
import { playbackRouter } from "./routes/playback.js";
import { retentionPoliciesRouter } from "./routes/retention-policies.js";
import { storageRouter } from "./routes/storage.js";
import { subscriptionRouter } from "./routes/subscription.js";
import { notificationsRouter } from "./routes/notifications.js";
import { liveRouter } from "./routes/live.js";
import { locationsRouter } from "./routes/locations.js";
import { integrationsRouter } from "./routes/integrations.js";
import { accountRouter } from "./routes/account.js";
import { cameraMotionRouter, motionEventsRouter } from "./routes/motion.js";
import { invitesRouter, membersRouter } from "./routes/invites.js";
import { pushRouter } from "./routes/push.js";
import { retentionRouter } from "./routes/retention.js";
import { ptzRouter } from "./routes/ptz.js";
import { workspaceRouter } from "./routes/workspace.js";
import { platformAdminRouter } from "./routes/platform-admin.js";
import { cameraShareRouter, publicShareRouter, shareAdminRouter } from "./routes/share.js";
import { originCheck } from "./middleware/origin-check.js";
import { globalApiRateLimiter } from "./middleware/rateLimit.js";

export function createApp() {
  const env = loadEnv();
  const app = express();
  const allowedOrigins = env.CORS_ORIGIN.split(",").map((o) => o.trim()).filter(Boolean);

  app.disable("x-powered-by");
  // Behind a reverse proxy / load balancer, set TRUST_PROXY (e.g. "1") so
  // rate limits key on the real client IP instead of the proxy's.
  if (process.env.TRUST_PROXY) {
    const v = process.env.TRUST_PROXY;
    app.set("trust proxy", /^\d+$/.test(v) ? Number(v) : v);
  }

  app.use(helmet());
  app.use(
    cors({
      origin: allowedOrigins,
      credentials: true,
    }),
  );
  app.use(originCheck(allowedOrigins));
  app.use(globalApiRateLimiter);
  app.use(express.json({ limit: "1mb" }));
  app.use(cookieParser());
  app.use(
    pinoHttp({
      logger,
      redact: ["req.headers.authorization", "req.headers.cookie", "res.headers['set-cookie']"],
    }),
  );

  app.use(healthRouter);
  app.use(authRouter);
  // Mounted before camerasRouter so the hot HLS path runs its own auth once
  // instead of camerasRouter's router-level auth plus its own.
  app.use("/cameras", liveRouter);
  app.use("/public/share", publicShareRouter);
  app.use("/cameras", cameraShareRouter);
  app.use("/shares", shareAdminRouter);
  app.use("/cameras", cameraMotionRouter);
  app.use("/cameras", ptzRouter);
  app.use("/cameras", camerasRouter);
  app.use("/cameras", recordingRouter);
  app.use("/cameras", playbackRouter);
  app.use("/locations", locationsRouter);
  app.use("/integrations", integrationsRouter);
  app.use("/account", accountRouter);
  app.use("/motion-events", motionEventsRouter);
  app.use("/invites", invitesRouter);
  app.use("/members", membersRouter);
  app.use("/push", pushRouter);
  app.use("/retention", retentionRouter);
  app.use("/workspace", workspaceRouter);
  app.use("/platform-admin", platformAdminRouter);
  app.use("/retention-policies", retentionPoliciesRouter);
  app.use("/storage", storageRouter);
  app.use("/subscription", subscriptionRouter);
  app.use("/notifications", notificationsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "not_found" });
  });

  // Last-resort handler for every error forwarded via next(err) — including
  // every route/middleware now wrapped in asyncHandler. Without this,
  // Express's own default error handler would apply, which is fine for
  // JSON clients but leaks stack traces in non-production and inconsistent
  // response shapes; this keeps the error response shape uniform and never
  // includes error internals in the body. Logging happens here, once, so
  // route handlers don't need their own catch-and-log boilerplate for
  // genuinely unexpected failures (DB/Redis blips, etc.) — only for cases
  // they want to turn into a specific 4xx.
   
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err, method: req.method, path: req.path }, "unhandled error in request handler");
    if (res.headersSent) {
      return;
    }
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
