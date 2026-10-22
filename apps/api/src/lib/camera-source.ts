import { decryptSecret } from "./crypto.js";
import { assertCameraTargetAllowed, UnsafeCameraHostError } from "./network-guard.js";
import { buildRtspUrl, type RtspCredentialParts } from "../connectors/rtsp-url.js";

export type CameraSourceResult =
  | { ok: true; rtspUrl: string }
  | { ok: false; status: number; error: "credential_decrypt_failed" | "unsafe_host"; message?: string };

/**
 * Decrypts a camera's stored credential, runs the connect-time SSRF check
 * (DNS-resolved), and builds the RTSP URL MediaMTX/ffprobe will dial. The
 * returned URL embeds the plaintext credential — never log or return it.
 */
export async function resolveCameraRtspUrl(camera: {
  connectorType: string;
  host: string;
  port: number;
  credential: { encryptedValue: string; encryptionIv: string } | null;
}): Promise<CameraSourceResult> {
  let credentialParts: RtspCredentialParts | undefined;
  if (camera.credential) {
    try {
      credentialParts = JSON.parse(
        decryptSecret({ ciphertext: camera.credential.encryptedValue, iv: camera.credential.encryptionIv }),
      ) as RtspCredentialParts;
    } catch {
      return { ok: false, status: 500, error: "credential_decrypt_failed" };
    }
  }
  try {
    await assertCameraTargetAllowed(camera.connectorType, camera.host, { resolve: true });
  } catch (err) {
    if (err instanceof UnsafeCameraHostError) {
      return { ok: false, status: 400, error: "unsafe_host", message: err.message };
    }
    throw err;
  }
  return { ok: true, rtspUrl: buildRtspUrl(camera.host, camera.port, credentialParts) };
}
