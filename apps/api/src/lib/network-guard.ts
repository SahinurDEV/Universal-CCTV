import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { loadEnv } from "../env.js";

export class UnsafeCameraHostError extends Error {}

const BLOCKED_HOST_LITERALS = new Set([
  "localhost",
  "localhost.localdomain",
  "ip6-localhost",
  "ip6-loopback",
  "169.254.169.254",
  "metadata.google.internal",
  "metadata",
  "instance-data",
]);

/** Hostnames: letters, digits, dots, hyphens only (no userinfo, ports, paths, spaces). */
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.?$/i;

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map(Number);
  const [a = 0, b = 0, c = 0, d = 0] = parts;
  return ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
}

function isIpv4InCidr(ip: string, cidrBase: string, prefixLength: number): boolean {
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(cidrBase) & mask);
}

const PRIVATE_V4: Array<[string, number]> = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
];

function blockedIpv4Reason(ip: string, blockPrivate: boolean): string | null {
  if (isIpv4InCidr(ip, "127.0.0.0", 8)) return "loopback";
  if (isIpv4InCidr(ip, "169.254.0.0", 16)) return "link-local";
  if (isIpv4InCidr(ip, "0.0.0.0", 8)) return "unspecified";
  if (isIpv4InCidr(ip, "224.0.0.0", 4)) return "multicast";
  if (isIpv4InCidr(ip, "240.0.0.0", 4)) return "reserved";
  if (isIpv4InCidr(ip, "198.18.0.0", 15)) return "benchmarking/reserved";
  if (blockPrivate && PRIVATE_V4.some(([b, p]) => isIpv4InCidr(ip, b, p))) return "private";
  if (blockPrivate && isIpv4InCidr(ip, "100.64.0.0", 10)) return "carrier-grade NAT";
  return null;
}

function blockedIpv6Reason(ip: string, blockPrivate: boolean): string | null {
  const n = ip.toLowerCase().replace(/^\[|\]$/g, "");
  // IPv4-mapped / IPv4-compatible forms (::ffff:127.0.0.1) must be checked
  // as IPv4 — otherwise they are a trivial loopback bypass.
  const mapped = n.match(/^(?:0*:)*(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/);
  if (mapped?.[1]) return blockedIpv4Reason(mapped[1], blockPrivate);
  const mappedHex = n.match(/^(?:0*:)*ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex?.[1] && mappedHex[2]) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return blockedIpv4Reason(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, blockPrivate);
  }
  if (n === "::1" || /^(0{1,4}:){7}0{0,3}1$/.test(n)) return "loopback";
  if (n === "::" || /^(0{1,4}:){7}0{1,4}$/.test(n)) return "unspecified";
  if (/^fe[89ab][0-9a-f]:/.test(n)) return "link-local";
  if (/^ff[0-9a-f]{2}:/.test(n)) return "multicast";
  if (n.startsWith("fd00:ec2::254")) return "cloud metadata";
  if (blockPrivate && /^f[cd][0-9a-f]{2}:/.test(n)) return "private";
  return null;
}

function denylist(): Set<string> {
  return new Set(
    loadEnv()
      .CAMERA_HOST_DENYLIST.split(",")
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

function assertSafeAddress(host: string, address: string, blockPrivate: boolean): void {
  const version = isIP(address);
  const reason =
    version === 4 ? blockedIpv4Reason(address, blockPrivate) : version === 6 ? blockedIpv6Reason(address, blockPrivate) : null;
  if (reason) {
    throw new UnsafeCameraHostError(`Host "${host}" resolves to a blocked address range (${reason}).`);
  }
}

/**
 * Validates a camera host at *configuration time* (camera create/update),
 * before any connector ever dials it. Blocks loopback, link-local (incl.
 * cloud metadata), multicast/reserved, IPv4-mapped IPv6 loopback, and
 * anything that isn't a syntactically plain hostname or IP literal (which
 * stops "user@host", "host/path" and similar URL-injection tricks).
 *
 * RFC1918 private ranges are allowed by default because real cameras live on
 * 10.x/172.16.x/192.168.x LANs; set BLOCK_PRIVATE_CAMERA_HOSTS=true for a
 * multi-tenant cloud deployment. Hostnames are NOT resolved here —
 * `assertSafeResolvedCameraHost` must be called right before dialing.
 */
export function assertSafeCameraHost(host: string): void {
  const normalized = host.trim().toLowerCase().replace(/\.$/, "");
  const env = loadEnv();

  if (BLOCKED_HOST_LITERALS.has(normalized) || normalized.endsWith(".localhost") || denylist().has(normalized)) {
    throw new UnsafeCameraHostError(`Host "${host}" is not allowed.`);
  }

  const literal = normalized.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    assertSafeAddress(host, literal, env.BLOCK_PRIVATE_CAMERA_HOSTS);
    return;
  }

  if (!HOSTNAME_RE.test(normalized)) {
    throw new UnsafeCameraHostError(`Host "${host}" is not a valid hostname or IP address.`);
  }
  // All-numeric "hostnames" (e.g. "2130706433", "0x7f.1") are alternative
  // IPv4 spellings that getaddrinfo accepts; never allow them.
  if (/^[0-9.]+$/.test(normalized) || /^0x/i.test(normalized)) {
    throw new UnsafeCameraHostError(`Host "${host}" is not a valid hostname or IP address.`);
  }
}

/**
 * Connect-time SSRF check: re-validates the host syntactically, then resolves
 * it via DNS and rejects if ANY resolved address is in a blocked range. This
 * closes the DNS-name bypass (e.g. a public name that resolves to 127.0.0.1
 * or 169.254.169.254). Call immediately before ffprobe/ONVIF/MediaMTX dials
 * the camera. (A residual DNS-rebinding window between this lookup and the
 * dial remains; documented in docs/security.md.)
 */
export async function assertSafeResolvedCameraHost(host: string): Promise<void> {
  assertSafeCameraHost(host);
  const env = loadEnv();
  const literal = host.trim().replace(/^\[|\]$/g, "");
  if (isIP(literal)) return;

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host.trim(), { all: true, verbatim: true });
  } catch {
    throw new UnsafeCameraHostError(`Host "${host}" could not be resolved.`);
  }
  if (addresses.length === 0) {
    throw new UnsafeCameraHostError(`Host "${host}" could not be resolved.`);
  }
  for (const { address } of addresses) {
    assertSafeAddress(host, address, env.BLOCK_PRIVATE_CAMERA_HOSTS);
  }
}

/** Host that the dev/test SIMULATED connector must use. */
export const SIMULATED_CAMERA_HOST = "localhost";

/**
 * Single entry point used by every route that stores or dials a camera host.
 * SIMULATED cameras are pinned to the local fixture and can be disabled
 * entirely (ALLOW_SIMULATED_CAMERAS=false, default in production).
 */
export async function assertCameraTargetAllowed(
  connectorType: string,
  host: string,
  opts: { resolve: boolean },
): Promise<void> {
  if (connectorType === "SIMULATED") {
    if (!loadEnv().ALLOW_SIMULATED_CAMERAS) {
      throw new UnsafeCameraHostError("Simulated cameras are disabled on this server.");
    }
    if (host !== SIMULATED_CAMERA_HOST) {
      throw new UnsafeCameraHostError('Simulated cameras must use host "localhost" (the dev fixture address).');
    }
    return;
  }
  if (opts.resolve) {
    await assertSafeResolvedCameraHost(host);
  } else {
    assertSafeCameraHost(host);
  }
}
