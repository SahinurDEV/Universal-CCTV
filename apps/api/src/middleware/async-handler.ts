import type { NextFunction, Request, RequestHandler, Response } from "express";

/**
 * Express 4 does not forward a rejected promise from an async handler to
 * `next()` — it becomes an unhandled promise rejection, which crashes the
 * whole process by default in modern Node. A single transient DB/Redis
 * blip inside any un-try/caught route would otherwise take down every
 * tenant's traffic, not just the one request. This was confirmed for real
 * against the running dev server (stopping Postgres mid-request killed the
 * process), not assumed — see docs/security.md's failure-recovery section.
 */
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
