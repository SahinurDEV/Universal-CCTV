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

export function createApp() {
  const env = loadEnv();
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGIN,
      credentials: true,
    }),
  );
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
  app.use("/cameras", camerasRouter);
  app.use("/cameras", recordingRouter);
  app.use("/cameras", playbackRouter);
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
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error({ err, method: req.method, path: req.path }, "unhandled error in request handler");
    if (res.headersSent) {
      return;
    }
    res.status(500).json({ error: "internal_error" });
  });

  return app;
}
