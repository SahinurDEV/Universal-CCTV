import pino from "pino";
import { loadEnv } from "../env.js";

const env = loadEnv();

/**
 * Structured logger. Any field that could contain an RTSP URL or credential
 * must be redacted by the caller before logging — this logger does not attempt
 * to scrub free-text messages.
 */
export const logger = pino({
  level: env.NODE_ENV === "test" ? "silent" : "info",
  redact: {
    paths: ["req.headers.authorization", "*.rtspUrl", "*.password", "*.credentialRef"],
    censor: "[redacted]",
  },
});
