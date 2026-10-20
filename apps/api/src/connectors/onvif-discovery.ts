import onvif from "onvif";
import type { Cam } from "onvif";

const { Discovery } = onvif;

export interface DiscoveredOnvifDevice {
  host: string;
  port: number;
  onvifServiceUrl: string | null;
}

/**
 * Performs ONVIF WS-Discovery (a UDP multicast probe on the local network
 * segment) and returns whatever devices answer within `timeoutMs`.
 *
 * Important limitation, not a bug: WS-Discovery only reaches devices on the
 * same LAN/broadcast domain as the process running this code. That's true
 * for this local/self-hosted deployment (the API runs on the same network as
 * the camera), but will NOT work for a cloud-hosted multi-tenant deployment —
 * the cloud has no path onto a customer's residential LAN. Reaching cameras
 * from the cloud requires the local gateway agent described in
 * docs/architecture.md §6, which is not built yet. Finding zero devices here
 * does not mean "no cameras exist" — it can also mean "this process isn't on
 * the camera's network," which is the expected cloud-deployment case.
 */
export function discoverOnvifDevices(timeoutMs = 5000): Promise<DiscoveredOnvifDevice[]> {
  return new Promise((resolve) => {
    Discovery.probe({ timeout: timeoutMs, resolve: true }, (err, devices) => {
      if (err || !devices) {
        resolve([]);
        return;
      }

      const results: DiscoveredOnvifDevice[] = devices
        .filter((d): d is Cam => typeof d === "object" && d !== null && "hostname" in d)
        .map((cam) => ({
          host: cam.hostname,
          port: cam.port,
          onvifServiceUrl: cam.xaddrs?.[0]?.href ?? null,
        }));

      resolve(results);
    });
  });
}
