import { describe, expect, it } from "vitest";
import { capabilitiesFromRtspProbe } from "./rtsp-probe.js";

describe("capabilitiesFromRtspProbe", () => {
  it("confirms liveView/cloudRecording/playback when a video stream is present", () => {
    const caps = capabilitiesFromRtspProbe([{ codecType: "video", codecName: "h264" }]);
    expect(caps.liveView).toBe(true);
    expect(caps.cloudRecording).toBe(true);
    expect(caps.playback).toBe(true);
    expect(caps.audio).toBe(false);
  });

  it("confirms audio only when an audio stream is present alongside video", () => {
    const caps = capabilitiesFromRtspProbe([
      { codecType: "video", codecName: "h264" },
      { codecType: "audio", codecName: "aac" },
    ]);
    expect(caps.audio).toBe(true);
  });

  it("never sets ONVIF-only capabilities from an RTSP probe", () => {
    const caps = capabilitiesFromRtspProbe([{ codecType: "video", codecName: "h264" }]);
    expect(caps.ptz).toBe(false);
    expect(caps.zoom).toBe(false);
    expect(caps.motionEvents).toBe(false);
    expect(caps.imageSettings).toBe(false);
    expect(caps.firmwareUpdate).toBe(false);
  });

  it("reports everything false when no video stream is found (e.g. audio-only or empty)", () => {
    const caps = capabilitiesFromRtspProbe([]);
    expect(caps.liveView).toBe(false);
    expect(caps.cloudRecording).toBe(false);
    expect(caps.playback).toBe(false);
  });
});
