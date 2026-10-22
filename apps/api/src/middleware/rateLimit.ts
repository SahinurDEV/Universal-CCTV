import rateLimit from "express-rate-limit";

/** Applied to /auth/register and /auth/login to slow down credential
 * stuffing / brute force. Keyed by IP, which is what express-rate-limit
 * does by default. */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});

/** Password change / sensitive account actions — per IP. */
export const sensitiveActionRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});

/** Endpoints that make the SERVER dial out (camera probes, ONVIF discovery,
 * webhook tests). Limits how fast anyone can use the server as a port
 * scanner even with a valid account. */
export const probeRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});

/** Coarse global limit for the JSON API (live HLS proxy is excluded — a
 * single viewer of a 9-camera grid legitimately makes many requests). */
export const globalApiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 1000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
  skip: (req) => req.path.includes("/live/hls/"),
});

/** Live HLS proxy: playlists + 1s segments for many tiles. */
export const liveStreamRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});

/** Creating invites (each may send an email) — per IP. */
export const inviteCreateRateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});

/** Public invite-token lookups/accepts: slows down token guessing (tokens
 * are 256-bit random, so this is defense in depth). */
export const inviteTokenRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too_many_requests" },
});
