import { describe, expect, it } from "vitest";
import {
  assertCameraTargetAllowed,
  assertSafeCameraHost,
  assertSafeResolvedCameraHost,
  UnsafeCameraHostError,
} from "./network-guard.js";

describe("assertSafeCameraHost", () => {
  it.each([
    "localhost",
    "LOCALHOST.",
    "foo.localhost",
    "127.0.0.1",
    "127.10.0.5",
    "0.0.0.0",
    "169.254.169.254",
    "169.254.1.1",
    "metadata.google.internal",
    "::1",
    "[::1]",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "fe80::1",
    "224.0.0.1",
    "2130706433", // decimal spelling of 127.0.0.1
    "0x7f000001",
    "0177.0.0.1",
    "cam@evil.example",
    "cam.example/path",
    "cam example",
    "host:554",
  ])("blocks %s", (host) => {
    expect(() => assertSafeCameraHost(host)).toThrow(UnsafeCameraHostError);
  });

  it.each(["192.168.1.64", "10.0.0.20", "172.16.5.4", "8.8.8.8", "cam1.example.com", "my-nvr.ddns.net", "2001:db8::10"])(
    "allows %s",
    (host) => {
      expect(() => assertSafeCameraHost(host)).not.toThrow();
    },
  );
});

describe("assertSafeResolvedCameraHost", () => {
  it("blocks a DNS name that resolves to loopback", async () => {
    // "localhost" is caught literally; *.localhost too. Use a name that the
    // system resolver maps to 127.0.0.1 via /etc/hosts on every Linux box.
    await expect(assertSafeResolvedCameraHost("ip6-localhost")).rejects.toThrow(UnsafeCameraHostError);
  });

  it("rejects names that do not resolve (or that a sandbox resolver maps to a reserved range)", async () => {
    await expect(assertSafeResolvedCameraHost("does-not-exist.invalid")).rejects.toThrow(UnsafeCameraHostError);
  });

  it("accepts a private LAN IP literal without DNS", async () => {
    await expect(assertSafeResolvedCameraHost("192.168.1.10")).resolves.toBeUndefined();
  });
});

describe("assertCameraTargetAllowed", () => {
  it("pins SIMULATED cameras to localhost", async () => {
    await expect(assertCameraTargetAllowed("SIMULATED", "localhost", { resolve: true })).resolves.toBeUndefined();
    await expect(assertCameraTargetAllowed("SIMULATED", "169.254.169.254", { resolve: false })).rejects.toThrow(
      UnsafeCameraHostError,
    );
  });

  it("applies the full guard to RTSP/ONVIF cameras", async () => {
    await expect(assertCameraTargetAllowed("RTSP", "localhost", { resolve: false })).rejects.toThrow(UnsafeCameraHostError);
    await expect(assertCameraTargetAllowed("ONVIF", "10.1.2.3", { resolve: true })).resolves.toBeUndefined();
  });
});
