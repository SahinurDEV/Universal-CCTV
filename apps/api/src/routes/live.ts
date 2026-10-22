import { Router } from "express";
import { Readable } from "node:stream";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { resolveCameraRtspUrl } from "../lib/camera-source.js";
import { ensureLivePath, fetchHlsResource } from "../connectors/mediamtx-client.js";
import { liveStreamRateLimiter } from "../middleware/rateLimit.js";
import { writeAuditLog } from "../lib/audit.js";
import { logger } from "../lib/logger.js";

/**
 * Live view. Browsers never talk to MediaMTX directly (it is bound to
 * loopback and has no per-tenant auth). Instead:
 *   1. POST /cameras/:id/live/start  — checks the session + tenant owns the
 *      camera, runs the connect-time SSRF check, and makes sure MediaMTX has
 *      an (on-demand) path pulling the camera.
 *   2. GET  /cameras/:id/live/hls/<file> — an authenticated reverse proxy
 *      to MediaMTX's HLS server for that one camera's path. Every playlist
 *      and segment request re-checks the session and tenant ownership, so a
 *      revoked session or a camera from another tenant stops streaming
 *      immediately and a leaked URL is useless without the session cookie.
 * Any role (including VIEWER) may watch live video of its own workspace.
 */
export const liveRouter = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Only plain HLS file names — no slashes, no "..", no query injection.
const HLS_FILE_RE = /^[A-Za-z0-9_-]{1,100}\.(m3u8|ts|mp4|m4s)$/;
const CONTENT_TYPES: Record<string, string> = {
  m3u8: "application/vnd.apple.mpegurl",
  ts: "video/mp2t",
  mp4: "video/mp4",
  m4s: "video/iso.segment",
};

liveRouter.post("/:id/live/start", requireAuth, requireTenant, asyncHandler(async (req, res) => {
  if (!UUID_RE.test(req.params.id!)) return res.status(404).json({ error: "not_found" });
  const camera = await prisma.camera.findFirst({
    where: { id: req.params.id, tenantId: req.authTenant!.id },
    include: { credential: true },
  });
  if (!camera) return res.status(404).json({ error: "not_found" });

  const source = await resolveCameraRtspUrl(camera);
  if (!source.ok) {
    return res.status(source.status).json({ error: source.error, message: source.message });
  }

  try {
    await ensureLivePath(camera.id, source.rtspUrl);
  } catch (err) {
    logger.error({ err, cameraId: camera.id }, "failed to prepare live path");
    return res.status(502).json({ error: "live_unavailable", message: "The media server could not start this stream." });
  }

  await writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action: "live.start",
    targetType: "Camera",
    targetId: camera.id,
  });

  res.json({
    cameraId: camera.id,
    protocol: "hls",
    // Relative to the API base URL; the session cookie must accompany it.
    playlistUrl: `/cameras/${camera.id}/live/hls/index.m3u8`,
  });
}));

liveRouter.get(
  "/:id/live/hls/:file",
  liveStreamRateLimiter,
  requireAuth,
  requireTenant,
  asyncHandler(async (req, res) => {
    const { id, file } = req.params as { id: string; file: string };
    if (!UUID_RE.test(id) || !HLS_FILE_RE.test(file)) {
      return res.status(404).json({ error: "not_found" });
    }
    const camera = await prisma.camera.findFirst({
      where: { id, tenantId: req.authTenant!.id },
      select: { id: true },
    });
    if (!camera) return res.status(404).json({ error: "not_found" });

    // Only forward HLS's own query params, never arbitrary ones: MediaMTX's
    // reader session id (it appends ?session=<uuid> to child playlists and
    // segments) and the low-latency HLS params.
    const qs = new URLSearchParams();
    const session = req.query.session;
    if (typeof session === "string" && UUID_RE.test(session)) qs.set("session", session);
    for (const key of ["_HLS_msn", "_HLS_part", "_HLS_skip"]) {
      const v = req.query[key];
      if (typeof v === "string" && /^[A-Za-z0-9]{1,20}$/.test(v)) qs.set(key, v);
    }
    const search = qs.toString() ? `?${qs.toString()}` : "";

    let upstream: Response;
    try {
      upstream = await fetchHlsResource(camera.id, file, search);
    } catch (err) {
      logger.warn({ err, cameraId: camera.id }, "live HLS upstream unreachable");
      return res.status(502).json({ error: "live_unavailable" });
    }
    if (!upstream.ok || !upstream.body) {
      // 404 from MediaMTX = stream not ready yet (camera still connecting) or
      // path not started; the player retries.
      return res.status(upstream.status === 404 ? 404 : 502).json({ error: "live_unavailable" });
    }

    const ext = file.split(".").pop()!;
    res.setHeader("Content-Type", CONTENT_TYPES[ext] ?? "application/octet-stream");
    res.setHeader("Cache-Control", "no-store");
    // Allow the dashboard (a different origin/port) to fetch these via CORS.
    res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");
    Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream).pipe(res);
  }),
);
