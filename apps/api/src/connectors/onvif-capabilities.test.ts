import { describe, expect, it } from "vitest";
import { deriveOnvifCapabilities } from "./onvif-capabilities.js";

describe("deriveOnvifCapabilities", () => {
  it("confirms ptz/zoom only when the PTZ service is advertised AND the active profile actually has a PTZ configuration", () => {
    const caps = deriveOnvifCapabilities({
      capabilities: { PTZ: { XAddr: "http://cam/onvif/ptz" } },
      activeSource: { ptz: { name: "default", token: "ptz0" } },
    });
    expect(caps.ptz).toBe(true);
    expect(caps.zoom).toBe(true);
  });

  it("does not claim ptz when the service is advertised but no profile actually uses it", () => {
    const caps = deriveOnvifCapabilities({
      capabilities: { PTZ: { XAddr: "http://cam/onvif/ptz" } },
      activeSource: null,
    });
    expect(caps.ptz).toBe(false);
    expect(caps.zoom).toBe(false);
  });

  it("does not claim ptz when a profile has one but the service itself isn't advertised", () => {
    const caps = deriveOnvifCapabilities({
      capabilities: {},
      activeSource: { ptz: { name: "default", token: "ptz0" } },
    });
    expect(caps.ptz).toBe(false);
  });

  it("confirms motionEvents from the Events service and imageSettings from the Imaging service independently of PTZ", () => {
    const caps = deriveOnvifCapabilities({
      capabilities: { events: { XAddr: "http://cam/onvif/events" }, imaging: { XAddr: "http://cam/onvif/imaging" } },
      activeSource: null,
    });
    expect(caps.motionEvents).toBe(true);
    expect(caps.imageSettings).toBe(true);
    expect(caps.ptz).toBe(false);
  });

  it("confirms firmwareUpdate only when the device explicitly advertises firmware upgrade support", () => {
    const caps = deriveOnvifCapabilities({
      capabilities: { device: { system: { firmwareUpgrade: true } } },
      activeSource: null,
    });
    expect(caps.firmwareUpdate).toBe(true);
  });

  it("reports everything false for a device with no capabilities object at all", () => {
    const caps = deriveOnvifCapabilities({});
    expect(caps).toEqual({ ptz: false, zoom: false, motionEvents: false, imageSettings: false, firmwareUpdate: false });
  });
});
