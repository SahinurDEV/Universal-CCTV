import { isIP } from "node:net";

export class UnsafeCameraHostError extends Error {}

const BLOCKED_HOST_LITERALS = new Set(["localhost", "169.254.169.254", "metadata.google.internal"]);

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function isIpv4InCidr(ip: string, cidrBase: string, prefixLength: number): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(cidrBase) & mask);
}

/**
 * Validates a camera host at *configuration time* (camera create/update),
 * before any connector ever dials it. This blocks the obvious SSRF targets
 * (loopback, link-local, cloud metadata) outright.
 *
 * This is deliberately NOT a full SSRF defense: it does not resolve
 * hostnames via DNS (so DNS-rebinding and hostname-based bypasses aren't
 * caught here) and it does not block RFC1918 private ranges, because real
 * cameras legitimately live on 10.x/172.16.x/192.168.x LANs — blocking those
 * would break the product. The connector layer (Phase 4), which actually
 * opens sockets, is responsible for re-validating the *resolved* address
 * immediately before connecting, since that's the point where a DNS-rebind
 * bypass would otherwise land. Both layers matter; this one exists so an
 * obviously-hostile value never even gets stored.
 */
export function assertSafeCameraHost(host: string): void {
  const normalized = host.trim().toLowerCase();

  if (BLOCKED_HOST_LITERALS.has(normalized)) {
    throw new UnsafeCameraHostError(`Host "${host}" is not allowed.`);
  }

  const ipVersion = isIP(normalized);

  if (ipVersion === 4) {
    const blocked =
      isIpv4InCidr(normalized, "127.0.0.0", 8) || // loopback
      isIpv4InCidr(normalized, "169.254.0.0", 16) || // link-local (incl. cloud metadata)
      isIpv4InCidr(normalized, "0.0.0.0", 8); // "this network" / unspecified
    if (blocked) {
      throw new UnsafeCameraHostError(`Host "${host}" resolves to a blocked address range.`);
    }
  } else if (ipVersion === 6) {
    const blocked =
      normalized === "::1" || // loopback
      normalized.startsWith("fe80:") || // link-local
      normalized === "::"; // unspecified
    if (blocked) {
      throw new UnsafeCameraHostError(`Host "${host}" resolves to a blocked address range.`);
    }
  }
  // Non-IP hostnames (e.g. "camera1.local", a real DNS name) pass here;
  // DNS-resolution-time re-validation happens in the connector layer.
}
