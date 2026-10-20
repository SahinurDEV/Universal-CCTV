export interface RtspCredentialParts {
  username?: string;
  password?: string;
  path?: string;
}

/**
 * Builds a full RTSP URL from stored connection fields. The result contains
 * the camera's plaintext credential embedded in the URL (that's how RTSP
 * auth works) — callers must never log or return this value. See
 * docs/security.md.
 */
export function buildRtspUrl(
  host: string,
  port: number,
  credential?: RtspCredentialParts | null,
): string {
  const path = credential?.path ? (credential.path.startsWith("/") ? credential.path : `/${credential.path}`) : "";

  if (credential?.username) {
    const user = encodeURIComponent(credential.username);
    const pass = credential.password ? encodeURIComponent(credential.password) : "";
    return `rtsp://${user}:${pass}@${host}:${port}${path}`;
  }

  return `rtsp://${host}:${port}${path}`;
}
