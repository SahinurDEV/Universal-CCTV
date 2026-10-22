import http from "node:http";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * Minimal ONVIF Profile S device simulator (device + media + PTZ services)
 * used for automated tests and local demos. It speaks enough SOAP for the
 * `onvif` npm client to connect, read capabilities/profiles and drive PTZ
 * (ContinuousMove, Stop, GetStatus, Get/Set/Goto/RemovePreset).
 *
 * It is NOT a certified ONVIF implementation: it was written against the
 * request shapes our client sends, so passing tests against it proves our
 * code path end-to-end, not interoperability with every vendor.
 *
 * WS-Security UsernameToken (PasswordDigest) is verified when a username is
 * configured, like real cameras do.
 */
export interface OnvifSimOptions {
  port?: number;
  host?: string;
  username?: string;
  password?: string;
  /** Advertise a PTZ service + PTZ configuration on the profile. */
  ptz?: boolean;
  /** Advertise an audio output (backchannel) configuration. */
  audioOutput?: boolean;
  /** RTSP URL returned by GetStreamUri. */
  rtspUrl?: string;
}

export interface OnvifSimState {
  position: { x: number; y: number; zoom: number };
  velocity: { x: number; y: number; zoom: number };
  moving: boolean;
  presets: Map<string, { name: string; x: number; y: number; zoom: number }>;
  calls: string[];
}

export interface OnvifSimulator {
  port: number;
  url: string;
  state: OnvifSimState;
  close: () => Promise<void>;
}

const NS =
  'xmlns:s="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl" ' +
  'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" ' +
  'xmlns:tt="http://www.onvif.org/ver10/schema" xmlns:ter="http://www.onvif.org/ver10/error"';

function envelope(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><s:Envelope ${NS}><s:Body>${body}</s:Body></s:Envelope>`;
}

function fault(code: string, reason: string): string {
  return envelope(
    `<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>${code}</s:Value></s:Subcode></s:Code>` +
      `<s:Reason><s:Text xml:lang="en">${reason}</s:Text></s:Reason></s:Fault>`,
  );
}

function tag(xml: string, name: string): string | undefined {
  const m = new RegExp(`<(?:\\w+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${name}>`).exec(xml);
  return m?.[1];
}

function attr(xml: string, el: string, a: string): number | undefined {
  const m = new RegExp(`<(?:\\w+:)?${el}\\b[^>]*\\b${a}="([^"]+)"`).exec(xml);
  return m ? Number(m[1]) : undefined;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

function checkAuth(xml: string, username?: string, password?: string): boolean {
  if (!username) return true;
  const user = tag(xml, "Username");
  const digest = tag(xml, "Password");
  const nonce = tag(xml, "Nonce");
  const created = tag(xml, "Created");
  if (user !== username || !digest || !nonce || !created) return false;
  const expected = crypto
    .createHash("sha1")
    .update(Buffer.concat([Buffer.from(nonce, "base64"), Buffer.from(created), Buffer.from(password ?? "")]))
    .digest("base64");
  return expected === digest.trim();
}

export async function startOnvifSimulator(opts: OnvifSimOptions = {}): Promise<OnvifSimulator> {
  const ptz = opts.ptz ?? true;
  const state: OnvifSimState = {
    position: { x: 0, y: 0, zoom: 0 },
    velocity: { x: 0, y: 0, zoom: 0 },
    moving: false,
    presets: new Map(),
    calls: [],
  };
  let base = "";
  let presetSeq = 0;

  // Integrate velocity into position so GetStatus reflects movement.
  const tick = setInterval(() => {
    if (!state.moving) return;
    state.position.x = clamp(state.position.x + state.velocity.x * 0.05, -1, 1);
    state.position.y = clamp(state.position.y + state.velocity.y * 0.05, -1, 1);
    state.position.zoom = clamp(state.position.zoom + state.velocity.zoom * 0.05, 0, 1);
  }, 50);
  tick.unref();

  const profile = () =>
    `<trt:Profiles token="profile_1" fixed="true"><tt:Name>MainStream</tt:Name>` +
    `<tt:VideoSourceConfiguration token="vsc_1"><tt:Name>vsc</tt:Name><tt:UseCount>1</tt:UseCount><tt:SourceToken>vs_1</tt:SourceToken><tt:Bounds x="0" y="0" width="1280" height="720"/></tt:VideoSourceConfiguration>` +
    `<tt:VideoEncoderConfiguration token="vec_1"><tt:Name>vec</tt:Name><tt:UseCount>1</tt:UseCount><tt:Encoding>H264</tt:Encoding><tt:Resolution><tt:Width>1280</tt:Width><tt:Height>720</tt:Height></tt:Resolution><tt:Quality>5</tt:Quality><tt:RateControl><tt:FrameRateLimit>15</tt:FrameRateLimit><tt:EncodingInterval>1</tt:EncodingInterval><tt:BitrateLimit>2048</tt:BitrateLimit></tt:RateControl></tt:VideoEncoderConfiguration>` +
    (ptz
      ? `<tt:PTZConfiguration token="ptz_1"><tt:Name>ptz</tt:Name><tt:UseCount>1</tt:UseCount><tt:NodeToken>node_1</tt:NodeToken></tt:PTZConfiguration>`
      : "") +
    (opts.audioOutput
      ? `<tt:Extension><tt:AudioOutputConfiguration token="aoc_1"><tt:Name>speaker</tt:Name><tt:UseCount>1</tt:UseCount><tt:OutputToken>ao_1</tt:OutputToken><tt:SendPrimacy>www.onvif.org/ver20/HalfDuplex/Auto</tt:SendPrimacy><tt:OutputLevel>50</tt:OutputLevel></tt:AudioOutputConfiguration></tt:Extension>`
      : "") +
    `</trt:Profiles>`;

  const handle = (xml: string): { status: number; body: string } => {
    const op = /<(?:\w+:)?Body[^>]*>\s*<(?:\w+:)?(\w+)/.exec(xml)?.[1] ?? "unknown";
    state.calls.push(op);
    if (op === "GetSystemDateAndTime") {
      const d = new Date();
      return {
        status: 200,
        body: envelope(
          `<tds:GetSystemDateAndTimeResponse><tds:SystemDateAndTime><tt:DateTimeType>NTP</tt:DateTimeType><tt:DaylightSavings>false</tt:DaylightSavings>` +
            `<tt:UTCDateTime><tt:Time><tt:Hour>${d.getUTCHours()}</tt:Hour><tt:Minute>${d.getUTCMinutes()}</tt:Minute><tt:Second>${d.getUTCSeconds()}</tt:Second></tt:Time>` +
            `<tt:Date><tt:Year>${d.getUTCFullYear()}</tt:Year><tt:Month>${d.getUTCMonth() + 1}</tt:Month><tt:Day>${d.getUTCDate()}</tt:Day></tt:Date></tt:UTCDateTime>` +
            `</tds:SystemDateAndTime></tds:GetSystemDateAndTimeResponse>`,
        ),
      };
    }
    if (!checkAuth(xml, opts.username, opts.password)) {
      return { status: 400, body: fault("ter:NotAuthorized", "Sender not authorized") };
    }
    switch (op) {
      case "GetServices":
        // Old-style device: makes the client fall back to GetCapabilities.
        return { status: 400, body: fault("ter:ActionNotSupported", "GetServices not supported") };
      case "GetCapabilities":
        return {
          status: 200,
          body: envelope(
            `<tds:GetCapabilitiesResponse><tds:Capabilities>` +
              `<tt:Device><tt:XAddr>${base}/onvif/device_service</tt:XAddr><tt:System><tt:FirmwareUpgrade>false</tt:FirmwareUpgrade></tt:System></tt:Device>` +
              `<tt:Media><tt:XAddr>${base}/onvif/media_service</tt:XAddr></tt:Media>` +
              (ptz ? `<tt:PTZ><tt:XAddr>${base}/onvif/ptz_service</tt:XAddr></tt:PTZ>` : "") +
              `</tds:Capabilities></tds:GetCapabilitiesResponse>`,
          ),
        };
      case "GetDeviceInformation":
        return {
          status: 200,
          body: envelope(
            `<tds:GetDeviceInformationResponse><tds:Manufacturer>UniversalCCTV</tds:Manufacturer><tds:Model>ONVIF-Sim</tds:Model><tds:FirmwareVersion>1.0</tds:FirmwareVersion><tds:SerialNumber>SIM-0001</tds:SerialNumber><tds:HardwareId>sim</tds:HardwareId></tds:GetDeviceInformationResponse>`,
          ),
        };
      case "GetProfiles":
        return { status: 200, body: envelope(`<trt:GetProfilesResponse>${profile()}</trt:GetProfilesResponse>`) };
      case "GetVideoSources":
        return {
          status: 200,
          body: envelope(
            `<trt:GetVideoSourcesResponse><trt:VideoSources token="vs_1"><tt:Framerate>15</tt:Framerate><tt:Resolution><tt:Width>1280</tt:Width><tt:Height>720</tt:Height></tt:Resolution></trt:VideoSources></trt:GetVideoSourcesResponse>`,
          ),
        };
      case "GetAudioOutputs":
        return opts.audioOutput
          ? { status: 200, body: envelope(`<trt:GetAudioOutputsResponse><trt:AudioOutputs token="ao_1"/></trt:GetAudioOutputsResponse>`) }
          : { status: 400, body: fault("ter:ActionNotSupported", "No audio outputs") };
      case "GetStreamUri":
        return {
          status: 200,
          body: envelope(
            `<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>${opts.rtspUrl ?? "rtsp://127.0.0.1:8554/simulated"}</tt:Uri><tt:InvalidAfterConnect>false</tt:InvalidAfterConnect><tt:InvalidAfterReboot>false</tt:InvalidAfterReboot><tt:Timeout>PT0S</tt:Timeout></trt:MediaUri></trt:GetStreamUriResponse>`,
          ),
        };
    }
    if (!ptz) return { status: 400, body: fault("ter:ActionNotSupported", "PTZ not supported") };
    switch (op) {
      case "ContinuousMove": {
        state.velocity = {
          x: clamp(attr(xml, "PanTilt", "x") ?? 0, -1, 1),
          y: clamp(attr(xml, "PanTilt", "y") ?? 0, -1, 1),
          zoom: clamp(attr(xml, "Zoom", "x") ?? 0, -1, 1),
        };
        state.moving = true;
        return { status: 200, body: envelope(`<tptz:ContinuousMoveResponse/>`) };
      }
      case "Stop":
        state.moving = false;
        state.velocity = { x: 0, y: 0, zoom: 0 };
        return { status: 200, body: envelope(`<tptz:StopResponse/>`) };
      case "GetStatus": {
        const p = state.position;
        return {
          status: 200,
          body: envelope(
            `<tptz:GetStatusResponse><tptz:PTZStatus><tt:Position><tt:PanTilt x="${p.x}" y="${p.y}"/><tt:Zoom x="${p.zoom}"/></tt:Position>` +
              `<tt:MoveStatus><tt:PanTilt>${state.moving ? "MOVING" : "IDLE"}</tt:PanTilt><tt:Zoom>${state.moving ? "MOVING" : "IDLE"}</tt:Zoom></tt:MoveStatus>` +
              `<tt:UtcTime>${new Date().toISOString()}</tt:UtcTime></tptz:PTZStatus></tptz:GetStatusResponse>`,
          ),
        };
      }
      case "GetPresets": {
        const items = [...state.presets.entries()]
          .map(([t, p]) => `<tptz:Preset token="${t}"><tt:Name>${p.name}</tt:Name></tptz:Preset>`)
          .join("");
        return { status: 200, body: envelope(`<tptz:GetPresetsResponse>${items}</tptz:GetPresetsResponse>`) };
      }
      case "SetPreset": {
        const name = (tag(xml, "PresetName") ?? `Preset ${presetSeq + 1}`).replace(/[<>&]/g, "");
        const token = tag(xml, "PresetToken") ?? `preset_${++presetSeq}`;
        state.presets.set(token, { name, ...state.position });
        return {
          status: 200,
          body: envelope(`<tptz:SetPresetResponse><tptz:PresetToken>${token}</tptz:PresetToken></tptz:SetPresetResponse>`),
        };
      }
      case "GotoPreset": {
        const p = state.presets.get(tag(xml, "PresetToken") ?? "");
        if (!p) return { status: 400, body: fault("ter:NoToken", "Preset not found") };
        state.position = { x: p.x, y: p.y, zoom: p.zoom };
        return { status: 200, body: envelope(`<tptz:GotoPresetResponse/>`) };
      }
      case "RemovePreset":
        state.presets.delete(tag(xml, "PresetToken") ?? "");
        return { status: 200, body: envelope(`<tptz:RemovePresetResponse/>`) };
    }
    return { status: 400, body: fault("ter:ActionNotSupported", `${op} not implemented by simulator`) };
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 256 * 1024) req.destroy();
      else chunks.push(c);
    });
    req.on("end", () => {
      const { status, body } = handle(Buffer.concat(chunks).toString("utf8"));
      res.writeHead(status, { "Content-Type": "application/soap+xml; charset=utf-8" });
      res.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(opts.port ?? 0, opts.host ?? "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  base = `http://${opts.host ?? "127.0.0.1"}:${port}`;
  return {
    port,
    url: base,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        clearInterval(tick);
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
