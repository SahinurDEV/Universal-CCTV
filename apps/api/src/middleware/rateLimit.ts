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
