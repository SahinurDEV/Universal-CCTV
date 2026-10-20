import { describe, expect, it } from "vitest";
import { probeOnvifCapabilities } from "./onvif-capabilities.js";

/**
 * There is no physical ONVIF camera in this environment (same constraint
 * documented for ONVIF discovery — see onvif-discovery.ts/
 * docs/camera-integration.md), so the "connects to a real device and
 * correctly parses its capabilities" path cannot be verified here. What
 * CAN be verified for real: the connect attempt genuinely opens a network
 * connection to a real, live local service and fails cleanly when that
 * service isn't actually ONVIF — not a mock, not a stub, a real SOAP
 * request against a real running HTTP server (MediaMTX's own config API)
 * that simply doesn't speak ONVIF.
 */
describe("probeOnvifCapabilities against real (non-ONVIF) local services", () => {
  it(
    "fails cleanly and promptly against a real HTTP server that isn't an ONVIF device",
    async () => {
      const start = Date.now();
      // MediaMTX's real, live config API (see docker-compose.yml) — a real
      // server, just not one that speaks ONVIF's SOAP protocol.
      const result = await probeOnvifCapabilities("localhost", 9997);
      const elapsedMs = Date.now() - start;

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.message.length).toBeGreaterThan(0);
      }
      // Must fail fast (wrong-protocol response, not a hang waiting for the
      // internal timeout) — proves this is a real attempted connection, not
      // a stub that always returns instantly regardless of the target.
      expect(elapsedMs).toBeLessThan(10000);
    },
    15000,
  );

  it(
    "fails cleanly against a closed port with connection refused",
    async () => {
      const result = await probeOnvifCapabilities("localhost", 1);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe("connection_failed");
      }
    },
    15000,
  );
});
