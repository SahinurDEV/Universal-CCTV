import onvif from "onvif";
import { withTimeout } from "../lib/timeout.js";

const { Cam } = onvif;
const CONNECT_TIMEOUT_MS = 8000;
const CALL_TIMEOUT_MS = 6000;
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface PtzTarget {
  cameraId: string;
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export interface PtzPreset {
  token: string;
  name: string;
}

export interface PtzStatus {
  position: { x: number; y: number; zoom: number } | null;
  moving: boolean;
}

export class PtzError extends Error {
  constructor(
    public code: "connect_failed" | "not_supported" | "command_failed",
    message: string,
  ) {
    super(message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyCam = any;
const cache = new Map<string, { cam: AnyCam; key: string; at: number }>();

function cacheKey(t: PtzTarget): string {
  return `${t.host}:${t.port}:${t.username ?? ""}:${t.password ?? ""}`;
}

/** Drops a cached ONVIF session (e.g. camera edited or deleted). */
export function forgetPtzSession(cameraId: string): void {
  cache.delete(cameraId);
}

async function connect(t: PtzTarget): Promise<AnyCam> {
  const key = cacheKey(t);
  const hit = cache.get(t.cameraId);
  if (hit && hit.key === key && Date.now() - hit.at < CACHE_TTL_MS) return hit.cam;
  const cam = new Cam({
    hostname: t.host,
    port: t.port,
    username: t.username,
    password: t.password,
    timeout: CONNECT_TIMEOUT_MS,
    autoconnect: false,
  });
  try {
    await withTimeout(
      new Promise<void>((resolve, reject) => cam.connect((err: unknown) => (err ? reject(err) : resolve()))),
      CONNECT_TIMEOUT_MS + 2000,
      "onvif connect",
    );
  } catch (err) {
    throw new PtzError("connect_failed", err instanceof Error ? err.message : String(err));
  }
  if (!cam.capabilities?.PTZ || !cam.activeSource?.ptz) {
    throw new PtzError("not_supported", "Camera does not expose PTZ on its active profile");
  }
  cache.set(t.cameraId, { cam, key, at: Date.now() });
  return cam;
}

function call<T>(t: PtzTarget, fn: (cam: AnyCam, cb: (err: unknown, data?: T) => void) => void): Promise<T> {
  return connect(t).then((cam) =>
    withTimeout(
      new Promise<T>((resolve, reject) =>
        fn(cam, (err, data) => {
          if (err) {
            cache.delete(t.cameraId);
            reject(new PtzError("command_failed", err instanceof Error ? err.message : String(err)));
          } else resolve(data as T);
        }),
      ),
      CALL_TIMEOUT_MS,
      "onvif ptz",
    ),
  );
}

/** Velocities are -1..1 (ONVIF generic velocity space). timeoutMs makes the
 * camera stop by itself even if the Stop request never arrives. */
export function continuousMove(t: PtzTarget, v: { x: number; y: number; zoom: number; timeoutMs: number }) {
  return call<void>(t, (cam, cb) =>
    cam.continuousMove({ x: v.x, y: v.y, zoom: v.zoom, timeout: v.timeoutMs }, cb),
  );
}

export function stop(t: PtzTarget) {
  return call<void>(t, (cam, cb) => cam.stop({ panTilt: true, zoom: true }, cb));
}

export async function getPresets(t: PtzTarget): Promise<PtzPreset[]> {
  const res = await call<Record<string, { $: { token: string }; name: string }>>(t, (cam, cb) => cam.getPresets({}, cb));
  return Object.values(res ?? {}).map((p) => ({ token: String(p.$.token), name: String(p.name ?? p.$.token) }));
}

export async function setPreset(t: PtzTarget, name: string): Promise<string> {
  const res = await call<unknown>(t, (cam, cb) => cam.setPreset({ presetName: name }, cb));
  // onvif returns the raw parsed body: [{ setPresetResponse: [{ presetToken: ["x"] }] }]
  const token = JSON.stringify(res).match(/"presetToken":\["([^"]+)"\]/)?.[1];
  return token ?? "";
}

export function gotoPreset(t: PtzTarget, token: string) {
  return call<void>(t, (cam, cb) => cam.gotoPreset({ preset: token }, cb));
}

export function removePreset(t: PtzTarget, token: string) {
  return call<void>(t, (cam, cb) => cam.removePreset({ presetToken: token }, cb));
}

export async function getStatus(t: PtzTarget): Promise<PtzStatus> {
  const s = await call<{ position?: { x?: number; y?: number; zoom?: number }; moveStatus?: { panTilt?: string; zoom?: string } }>(
    t,
    (cam, cb) => cam.getStatus({}, cb),
  );
  const pos = s?.position;
  return {
    position: pos ? { x: Number(pos.x ?? 0), y: Number(pos.y ?? 0), zoom: Number(pos.zoom ?? 0) } : null,
    moving: s?.moveStatus?.panTilt === "MOVING" || s?.moveStatus?.zoom === "MOVING",
  };
}
