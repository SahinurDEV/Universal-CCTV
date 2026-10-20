import onvif from "onvif";
import type { CameraCapabilities } from "@cctv/shared";
import { withTimeout } from "../lib/timeout.js";

const { Cam } = onvif;

const ONVIF_CONNECT_TIMEOUT_MS = 8000;

export type OnvifCapabilitySubset = Pick<
  CameraCapabilities,
  "ptz" | "zoom" | "motionEvents" | "imageSettings" | "firmwareUpdate"
>;

export type OnvifCapabilityProbeResult =
  | { ok: true; capabilities: OnvifCapabilitySubset }
  | { ok: false; reason: "connection_failed" | "timeout"; message: string };

/**
 * Minimal shape of the connected `onvif` package's underlying `Cam` instance
 * that `deriveOnvifCapabilities` reads from — kept narrow and separate from
 * the library's own loosely-typed `CamCapabilities`/`ActiveSource` so the
 * derivation function stays unit-testable against plain fixture objects.
 */
export interface OnvifCamSnapshot {
  capabilities?: {
    PTZ?: unknown;
    events?: unknown;
    imaging?: unknown;
    device?: { system?: { firmwareUpgrade?: unknown } };
  } | null;
  activeSource?: { ptz?: { name: string; token: string } } | null;
}

/**
 * Real ONVIF capability confirmation (PTZ, motion events, image settings,
 * firmware update) — connects to the device's ONVIF service over SOAP/HTTP
 * and reports what it actually advertises, rather than leaving every ONVIF
 * camera permanently on `CONNECTED_MISSING_CAPABILITIES` the way RTSP-only
 * probing always did (see `rtsp-probe.ts`'s `capabilitiesFromRtspProbe`,
 * which explicitly never sets these fields).
 *
 * HONESTY CAVEAT, matching this project's existing ONVIF discovery
 * disclaimer in `onvif-discovery.ts`/docs/camera-integration.md: there is no
 * physical ONVIF camera in this development environment. The connect+
 * getCapabilities SOAP exchange below has only been verified against hosts
 * that are NOT real ONVIF devices — confirming it fails cleanly (wrong
 * service, connection refused, timeout), not that it correctly parses a
 * real device's response. `deriveOnvifCapabilities` (the pure mapping
 * logic) IS unit-tested against synthetic ONVIF response shapes, the same
 * pattern this codebase already uses for `capabilitiesFromRtspProbe`. Do
 * not present the "found real capabilities" path as verified until it has
 * actually been run against real hardware.
 */
export async function probeOnvifCapabilities(
  host: string,
  port: number,
  credential?: { username?: string; password?: string },
): Promise<OnvifCapabilityProbeResult> {
  const cam = new Cam({
    hostname: host,
    port,
    username: credential?.username,
    password: credential?.password,
    timeout: ONVIF_CONNECT_TIMEOUT_MS,
    autoconnect: false,
  });

  const connect = new Promise<void>((resolve, reject) => {
    cam.connect((err) => (err ? reject(err) : resolve()));
  });

  try {
    await withTimeout(connect, ONVIF_CONNECT_TIMEOUT_MS + 2000, "onvif connect");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const reason = message.includes("timed out") ? "timeout" : "connection_failed";
    return { ok: false, reason, message };
  }

  return { ok: true, capabilities: deriveOnvifCapabilities(cam) };
}

/**
 * Pure mapping from a connected ONVIF device's advertised capabilities to
 * this project's capability model. Deliberately conservative:
 *   - `ptz`: the device must advertise the PTZ service AND the camera's
 *     active media profile must actually have a PTZ configuration attached
 *     (`activeSource.ptz`) — a device can advertise the PTZ *service*
 *     without any profile actually using it (e.g. a fixed-lens camera on
 *     a shared firmware image), so service-presence alone would overclaim.
 *   - `zoom`: ONVIF's capabilities document has no separate "zoom" flag;
 *     a PTZ-capable profile is the closest honest signal without a deeper
 *     `GetConfigurationOptions` probe for zoom-specific PTZ spaces, which
 *     this function doesn't attempt.
 *   - `motionEvents`: the device advertises an Events service at all —
 *     NOT that motion detection specifically works, which would require
 *     actually subscribing and waiting for a real motion event to fire.
 *   - `imageSettings`: the device advertises an Imaging service.
 *   - `firmwareUpdate`: the device's system capabilities explicitly
 *     advertise firmware upgrade support.
 */
export function deriveOnvifCapabilities(cam: OnvifCamSnapshot): OnvifCapabilitySubset {
  const ptz = Boolean(cam.capabilities?.PTZ) && Boolean(cam.activeSource?.ptz);
  return {
    ptz,
    zoom: ptz,
    motionEvents: Boolean(cam.capabilities?.events),
    imageSettings: Boolean(cam.capabilities?.imaging),
    firmwareUpdate: Boolean(cam.capabilities?.device?.system?.firmwareUpgrade),
  };
}
