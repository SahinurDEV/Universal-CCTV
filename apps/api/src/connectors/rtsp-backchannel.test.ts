import { describe, expect, it } from "vitest";
import { parseBackchannelSdp } from "./rtsp-backchannel.js";

const base = "v=0\r\ns=x\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=recvonly\r\n";

describe("parseBackchannelSdp", () => {
  it("finds a sendonly PCMU backchannel", () => {
    expect(parseBackchannelSdp(base + "m=audio 0 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=control:track2\r\na=sendonly\r\n"))
      .toEqual({ supported: true, codec: "PCMU", payloadType: 0, control: "track2" });
  });
  it("accepts PCMA with dynamic payload type", () => {
    const r = parseBackchannelSdp(base + "m=audio 0 RTP/AVP 97\r\na=rtpmap:97 PCMA/8000\r\na=sendonly\r\n");
    expect(r).toMatchObject({ supported: true, codec: "PCMA", payloadType: 97 });
  });
  it("ignores normal (recvonly) audio", () => {
    expect(parseBackchannelSdp(base + "m=audio 0 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=recvonly\r\n").supported).toBe(false);
  });
  it("reports AAC-only backchannels as unsupported codec", () => {
    expect(parseBackchannelSdp(base + "m=audio 0 RTP/AVP 98\r\na=rtpmap:98 MPEG4-GENERIC/16000\r\na=sendonly\r\n"))
      .toEqual({ supported: false, reason: "backchannel_codec_unsupported" });
  });
});
