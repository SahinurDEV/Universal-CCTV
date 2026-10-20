import "dotenv/config";
import { loadEnv } from "./env.js";
import { createApp } from "./app.js";
import { logger } from "./lib/logger.js";

const env = loadEnv();
const app = createApp();

app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, "api listening");
});

// Last-resort safety net, not the primary fix. Every request-path error
// should already be caught by asyncHandler + app.ts's error middleware —
// this exists for anything outside that path (e.g. a bug in a timer/callback
// that isn't itself a request). A confirmed real bug before this existed:
// stopping Postgres mid-request killed the whole process on an unhandled
// rejection from an un-try/caught async route handler; see
// docs/failure-recovery.md. Logged and process continues rather than
// exiting, since killing the process on every transient async error would
// still cause a full outage for every tenant, which is worse than logging
// and carrying on for something Express's error handler should have already
// caught.
process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "unhandled promise rejection — this should have been caught earlier; see docs/failure-recovery.md");
});

// An uncaught *synchronous* exception means something escaped every try/catch
// and every middleware layer — the process may be in a genuinely unknown
// state, so exit and let the process manager (Docker/systemd restart policy)
// bring up a clean instance rather than keep serving from possibly-corrupted
// state.
process.on("uncaughtException", (err) => {
  logger.error({ err }, "uncaught exception — exiting for a clean restart");
  process.exit(1);
});
