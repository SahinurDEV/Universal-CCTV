import express, { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { prisma } from "../lib/db.js";
import { requireAuth, requireTenant, requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../middleware/async-handler.js";
import { writeAuditLog } from "../lib/audit.js";
import { decryptSecret } from "../lib/crypto.js";
import { logger } from "../lib/logger.js";
import { assertCameraTargetAllowed, UnsafeCameraHostError } from "../lib/network-guard.js";
import { buildRtspUrl } from "../connectors/rtsp-url.js";
import * as ptz from "../connectors/onvif-ptz.js";
import {
  probeBackchannel,
  sendBackchannelAudio,
  transcodeToG711,
  type BackchannelInfo,
} from "../connectors/rtsp-backchannel.js";

/**
 * PTZ (ONVIF) and two-way audio (ONVIF RTSP backchannel).
 *   GET    /cameras/:id/ptz                      support + presets + status (any member)
 *   POST   /cameras/:id/ptz/move                 {x,y,zoom,timeoutMs}   OPERATOR+
 *   POST   /cameras/:id/ptz/stop                                         OPERATOR+
 *   POST   /cameras/:id/ptz/presets              {name}                 OPERATOR+
 *   POST   /cameras/:id/ptz/presets/:token/goto                         OPERATOR+
 *   DELETE /cameras/:id/ptz/presets/:token                              OPERATOR+
 *   GET    /cameras/:id/audio                    listen/talk support (any member)
 *   POST   /cameras/:id/audio/talk               audio clip body        OPERATOR+
 * Every control call is rate-limited per user and audit-logged.
 */
export const ptzRouter = Router();
const auth = [requireAuth, requireTenant];
const operator = requireRole("OWNER", "ADMIN", "OPERATOR");
const idSchema = z.string().uuid();
const tokenSchema = z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/);

const userKey = (req: Request) => `u:${req.authUser?.id ?? "anon"}`;
/** ~10 control commands/second sustained is far beyond a human on a joystick. */
export const ptzRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 240,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: "too_many_requests" },
});
/** Reads also dial the camera (ONVIF / RTSP DESCRIBE), so they are limited too. */
export const ptzReadRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: "too_many_requests" },
});
export const talkRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: userKey,
  message: { error: "too_many_requests" },
});

const moveSchema = z
  .object({
    x: z.number().min(-1).max(1).default(0),
    y: z.number().min(-1).max(1).default(0),
    zoom: z.number().min(-1).max(1).default(0),
    timeoutMs: z.number().int().min(100).max(10000).default(1000),
  })
  .strict();
const presetSchema = z
  .object({ name: z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N} _.-]+$/u) })
  .strict();

type CamWithCreds = NonNullable<Awaited<ReturnType<typeof loadCamera>>>;

async function loadCamera(req: Request) {
  const id = idSchema.safeParse(req.params.id);
  if (!id.success) return null;
  return prisma.camera.findFirst({
    where: { id: id.data, tenantId: req.authTenant!.id },
    include: { credential: true, capability: true },
  });
}

function creds(camera: CamWithCreds): { username?: string; password?: string; path?: string } {
  if (!camera.credential) return {};
  return JSON.parse(decryptSecret({ ciphertext: camera.credential.encryptedValue, iv: camera.credential.encryptionIv }));
}

function ptzSupported(camera: CamWithCreds): boolean {
  return camera.connectorType === "ONVIF" && Boolean(camera.capability?.ptz);
}

async function ptzTarget(camera: CamWithCreds): Promise<ptz.PtzTarget> {
  await assertCameraTargetAllowed(camera.connectorType, camera.host, { resolve: true });
  const c = creds(camera);
  return { cameraId: camera.id, host: camera.host, port: camera.onvifPort ?? 80, username: c.username, password: c.password };
}

function sendPtzError(res: Response, err: unknown) {
  if (err instanceof UnsafeCameraHostError) return res.status(400).json({ error: "unsafe_host", message: err.message });
  if (err instanceof ptz.PtzError) {
    const status = err.code === "not_supported" ? 409 : 502;
    return res.status(status).json({ error: `ptz_${err.code}` });
  }
  if (err instanceof Error && /timed out/.test(err.message)) return res.status(504).json({ error: "ptz_timeout" });
  throw err;
}

function audit(req: Request, cameraId: string, action: string, metadata: Record<string, string | number | boolean> = {}) {
  return writeAuditLog({
    tenantId: req.authTenant!.id,
    actorUserId: req.authUser!.id,
    action,
    targetType: "Camera",
    targetId: cameraId,
    metadata,
  });
}

ptzRouter.get("/:id/ptz", ...auth, ptzReadRateLimiter, asyncHandler(async (req, res) => {
  const camera = await loadCamera(req);
  if (!camera) return res.status(404).json({ error: "not_found" });
  const canControl = ["OWNER", "ADMIN", "OPERATOR"].includes(req.authTenant!.role);
  if (!ptzSupported(camera)) return res.json({ supported: false, zoom: false, canControl, presets: [], status: null });
  try {
    const t = await ptzTarget(camera);
    const [presets, status] = await Promise.all([ptz.getPresets(t), ptz.getStatus(t).catch(() => null)]);
    res.json({ supported: true, zoom: Boolean(camera.capability?.zoom), canControl, presets, status });
  } catch (err) {
    sendPtzError(res, err);
  }
}));

ptzRouter.post("/:id/ptz/move", ...auth, operator, ptzRateLimiter, asyncHandler(async (req, res) => {
  const body = moveSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: "invalid_body" });
  const camera = await loadCamera(req);
  if (!camera) return res.status(404).json({ error: "not_found" });
  if (!ptzSupported(camera)) return res.status(409).json({ error: "ptz_not_supported" });
  try {
    await ptz.continuousMove(await ptzTarget(camera), body.data);
    await audit(req, camera.id, "camera.ptz.move", body.data);
    res.json({ ok: true });
  } catch (err) {
    sendPtzError(res, err);
  }
}));

ptzRouter.post("/:id/ptz/stop", ...auth, operator, ptzRateLimiter, asyncHandler(async (req, res) => {
  const camera = await loadCamera(req);
  if (!camera) return res.status(404).json({ error: "not_found" });
  if (!ptzSupported(camera)) return res.status(409).json({ error: "ptz_not_supported" });
  try {
    await ptz.stop(await ptzTarget(camera));
    await audit(req, camera.id, "camera.ptz.stop");
    res.json({ ok: true });
  } catch (err) {
    sendPtzError(res, err);
  }
}));

ptzRouter.post("/:id/ptz/presets", ...auth, operator, ptzRateLimiter, asyncHandler(async (req, res) => {
  const body = presetSchema.safeParse(req.body ?? {});
  if (!body.success) return res.status(400).json({ error: "invalid_body" });
  const camera = await loadCamera(req);
  if (!camera) return res.status(404).json({ error: "not_found" });
  if (!ptzSupported(camera)) return res.status(409).json({ error: "ptz_not_supported" });
  try {
    const token = await ptz.setPreset(await ptzTarget(camera), body.data.name);
    await audit(req, camera.id, "camera.ptz.preset.set", { name: body.data.name, token });
    res.status(201).json({ token, name: body.data.name });
  } catch (err) {
    sendPtzError(res, err);
  }
}));

ptzRouter.post("/:id/ptz/presets/:token/goto", ...auth, operator, ptzRateLimiter, asyncHandler(async (req, res) => {
  const token = tokenSchema.safeParse(req.params.token);
  if (!token.success) return res.status(400).json({ error: "invalid_token" });
  const camera = await loadCamera(req);
  if (!camera) return res.status(404).json({ error: "not_found" });
  if (!ptzSupported(camera)) return res.status(409).json({ error: "ptz_not_supported" });
  try {
    await ptz.gotoPreset(await ptzTarget(camera), token.data);
    await audit(req, camera.id, "camera.ptz.preset.goto", { token: token.data });
    res.json({ ok: true });
  } catch (err) {
    sendPtzError(res, err);
  }
}));

ptzRouter.delete("/:id/ptz/presets/:token", ...auth, operator, ptzRateLimiter, asyncHandler(async (req, res) => {
  const token = tokenSchema.safeParse(req.params.token);
  if (!token.success) return res.status(400).json({ error: "invalid_token" });
  const camera = await loadCamera(req);
  if (!camera) return res.status(404).json({ error: "not_found" });
  if (!ptzSupported(camera)) return res.status(409).json({ error: "ptz_not_supported" });
  try {
    await ptz.removePreset(await ptzTarget(camera), token.data);
    await audit(req, camera.id, "camera.ptz.preset.remove", { token: token.data });
    res.status(204).send();
  } catch (err) {
    sendPtzError(res, err);
  }
}));

// --- Two-way audio -------------------------------------------------------

const BACKCHANNEL_CACHE_MS = 10 * 60 * 1000;
const backchannelCache = new Map<string, { at: number; info: BackchannelInfo }>();
/** Test hook. */
export function clearBackchannelCache() {
  backchannelCache.clear();
}

async function backchannelFor(camera: CamWithCreds, rtspUrl: string): Promise<BackchannelInfo> {
  const hit = backchannelCache.get(camera.id);
  if (hit && Date.now() - hit.at < BACKCHANNEL_CACHE_MS) return hit.info;
  const info = await probeBackchannel(rtspUrl);
  backchannelCache.set(camera.id, { at: Date.now(), info });
  return info;
}

async function rtspUrlFor(camera: CamWithCreds): Promise<string> {
  await assertCameraTargetAllowed(camera.connectorType, camera.host, { resolve: true });
  return buildRtspUrl(camera.host, camera.port, creds(camera));
}

ptzRouter.get("/:id/audio", ...auth, ptzReadRateLimiter, asyncHandler(async (req, res) => {
  const camera = await loadCamera(req);
  if (!camera) return res.status(404).json({ error: "not_found" });
  const canTalk = ["OWNER", "ADMIN", "OPERATOR"].includes(req.authTenant!.role);
  // Simulated cameras are the local ffmpeg fixture: no backchannel exists.
  if (camera.connectorType === "SIMULATED") {
    return res.json({ listen: Boolean(camera.capability?.audio), talk: false, canTalk, reason: "simulated_camera" });
  }
  try {
    const info = await backchannelFor(camera, await rtspUrlFor(camera));
    res.json({ listen: Boolean(camera.capability?.audio), talk: info.supported, codec: info.codec ?? null, canTalk, reason: info.reason ?? null });
  } catch (err) {
    if (err instanceof UnsafeCameraHostError) return res.status(400).json({ error: "unsafe_host" });
    throw err;
  }
}));

const MAX_CLIP_BYTES = 2 * 1024 * 1024;
const MAX_TALK_SECONDS = 30;
const talkBody = express.raw({
  type: ["audio/*", "video/webm", "application/octet-stream"],
  limit: MAX_CLIP_BYTES,
});
const activeTalk = new Set<string>();

ptzRouter.post("/:id/audio/talk", ...auth, operator, talkRateLimiter, talkBody, asyncHandler(async (req, res) => {
  const camera = await loadCamera(req);
  if (!camera) return res.status(404).json({ error: "not_found" });
  if (!Buffer.isBuffer(req.body) || req.body.length === 0) return res.status(400).json({ error: "audio_required" });
  if (camera.connectorType === "SIMULATED") return res.status(409).json({ error: "talk_not_supported", reason: "simulated_camera" });
  if (activeTalk.has(camera.id)) return res.status(409).json({ error: "talk_in_progress" });
  let rtspUrl: string;
  try {
    rtspUrl = await rtspUrlFor(camera);
  } catch (err) {
    if (err instanceof UnsafeCameraHostError) return res.status(400).json({ error: "unsafe_host" });
    throw err;
  }
  const info = await backchannelFor(camera, rtspUrl);
  if (!info.supported || !info.codec) return res.status(409).json({ error: "talk_not_supported", reason: info.reason ?? null });
  activeTalk.add(camera.id);
  try {
    let samples: Buffer;
    try {
      samples = await transcodeToG711(req.body, info.codec, MAX_TALK_SECONDS);
    } catch {
      return res.status(400).json({ error: "audio_decode_failed" });
    }
    if (samples.length === 0) return res.status(400).json({ error: "audio_decode_failed" });
    try {
      const result = await sendBackchannelAudio(rtspUrl, samples);
      const seconds = Math.round((samples.length / 8000) * 10) / 10;
      await audit(req, camera.id, "camera.audio.talk", { seconds, codec: result.codec });
      res.json({ ok: true, seconds, codec: result.codec });
    } catch (err) {
      backchannelCache.delete(camera.id);
      logger.warn({ cameraId: camera.id, err: err instanceof Error ? err.message : err }, "backchannel send failed");
      res.status(502).json({ error: "talk_failed" });
    }
  } finally {
    activeTalk.delete(camera.id);
  }
}));
