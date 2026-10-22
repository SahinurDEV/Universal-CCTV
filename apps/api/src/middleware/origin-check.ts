import type { Request, Response, NextFunction } from "express";

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * CSRF defense-in-depth on top of SameSite=lax cookies: for state-changing
 * requests, if the browser sent an Origin header it must be one of the
 * allowed web origins. SameSite=lax alone does not protect against other
 * apps on the same *site* (e.g. another port on localhost, or a sibling
 * subdomain), and several endpoints (logout, read-all, cancel subscription,
 * stop recording) take no body, so JSON-only parsing doesn't help them.
 * Requests with no Origin (curl, server-to-server, tests) are allowed — they
 * can't carry a victim's cookies from a browser.
 */
export function originCheck(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  return (req: Request, res: Response, next: NextFunction) => {
    if (SAFE_METHODS.has(req.method)) return next();
    const origin = req.headers.origin;
    if (!origin || allowed.has(origin)) return next();
    return res.status(403).json({ error: "forbidden_origin" });
  };
}
