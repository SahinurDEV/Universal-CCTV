import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

/**
 * ONVIF audio backchannel (ONVIF Streaming Spec §5.3): the client opens an
 * RTSP session with `Require: www.onvif.org/ver20/backchannel`, the camera
 * answers DESCRIBE with an extra `a=sendonly` audio media, and the client
 * SETUPs that media and then *sends* RTP audio to the camera.
 *
 * Scope (deliberately small, see docs/ptz-audio.md):
 *   - G.711 only (PCMU / PCMA at 8 kHz, mono) — the codec every
 *     backchannel-capable camera is required to accept. AAC backchannels
 *     are not implemented.
 *   - RTP over the RTSP TCP connection (interleaved). No UDP.
 *   - Half duplex "push to talk": a finished clip is transcoded with ffmpeg
 *     and streamed in real time. This is NOT low-latency WebRTC talk.
 *   - Basic and Digest (MD5) RTSP auth.
 */

export type BackchannelCodec = "PCMU" | "PCMA";
export interface BackchannelInfo {
  supported: boolean;
  codec?: BackchannelCodec;
  payloadType?: number;
  control?: string;
  reason?: string;
}

const REQUIRE = "www.onvif.org/ver20/backchannel";
const IO_TIMEOUT_MS = 8000;

interface RtspResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

class RtspConn {
  private sock: net.Socket;
  private buf = Buffer.alloc(0);
  private waiters: ((r: RtspResponse | Error) => void)[] = [];
  private cseq = 0;
  private authHeader: ((method: string, uri: string) => string) | null = null;
  session: string | null = null;

  constructor(
    private url: URL,
    private user: string,
    private pass: string,
  ) {
    this.sock = net.connect({ host: url.hostname, port: Number(url.port || 554) });
    this.sock.setTimeout(IO_TIMEOUT_MS, () => this.sock.destroy(new Error("RTSP timeout")));
    this.sock.on("data", (d) => {
      this.buf = Buffer.concat([this.buf, d]);
      this.drain();
    });
    this.sock.on("error", (e) => this.fail(e));
    this.sock.on("close", () => this.fail(new Error("RTSP connection closed")));
  }

  ready(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.sock.once("connect", () => resolve());
      this.sock.once("error", reject);
    });
  }

  private fail(e: Error) {
    const w = this.waiters.splice(0);
    w.forEach((fn) => fn(e));
  }

  private drain() {
    for (;;) {
      // Skip interleaved packets the server might send us.
      if (this.buf[0] === 0x24) {
        if (this.buf.length < 4) return;
        const len = this.buf.readUInt16BE(2);
        if (this.buf.length < 4 + len) return;
        this.buf = this.buf.subarray(4 + len);
        continue;
      }
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      const head = this.buf.subarray(0, end).toString("latin1");
      const lines = head.split("\r\n");
      const status = Number(/^RTSP\/1\.0 (\d{3})/.exec(lines[0] ?? "")?.[1] ?? 0);
      const headers: Record<string, string> = {};
      for (const l of lines.slice(1)) {
        const i = l.indexOf(":");
        if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
      }
      const len = Number(headers["content-length"] ?? 0);
      if (this.buf.length < end + 4 + len) return;
      const body = this.buf.subarray(end + 4, end + 4 + len).toString("utf8");
      this.buf = this.buf.subarray(end + 4 + len);
      this.waiters.shift()?.({ status, headers, body });
    }
  }

  private send(method: string, uri: string, extra: Record<string, string>): Promise<RtspResponse> {
    const h: Record<string, string> = { CSeq: String(++this.cseq), "User-Agent": "UniversalCCTV", Require: REQUIRE, ...extra };
    if (this.session) h.Session = this.session;
    if (this.authHeader) h.Authorization = this.authHeader(method, uri);
    const msg = `${method} ${uri} RTSP/1.0\r\n${Object.entries(h).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n`;
    return new Promise((resolve, reject) => {
      this.waiters.push((r) => (r instanceof Error ? reject(r) : resolve(r)));
      this.sock.write(msg);
    });
  }

  async request(method: string, uri: string, extra: Record<string, string> = {}): Promise<RtspResponse> {
    let res = await this.send(method, uri, extra);
    if (res.status === 401 && !this.authHeader && this.user) {
      const www = res.headers["www-authenticate"] ?? "";
      if (/^digest/i.test(www)) {
        const realm = /realm="([^"]*)"/i.exec(www)?.[1] ?? "";
        const nonce = /nonce="([^"]*)"/i.exec(www)?.[1] ?? "";
        const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
        const ha1 = md5(`${this.user}:${realm}:${this.pass}`);
        this.authHeader = (m, u) =>
          `Digest username="${this.user}", realm="${realm}", nonce="${nonce}", uri="${u}", response="${md5(`${ha1}:${nonce}:${md5(`${m}:${u}`)}`)}"`;
      } else {
        const b = Buffer.from(`${this.user}:${this.pass}`).toString("base64");
        this.authHeader = () => `Basic ${b}`;
      }
      res = await this.send(method, uri, extra);
    }
    return res;
  }

  writeInterleaved(channel: number, payload: Buffer): boolean {
    const hdr = Buffer.alloc(4);
    hdr[0] = 0x24;
    hdr[1] = channel;
    hdr.writeUInt16BE(payload.length, 2);
    return this.sock.write(Buffer.concat([hdr, payload]));
  }

  close() {
    this.sock.destroy();
  }
}

/** Parses a DESCRIBE answer for a sendonly (camera-receives) G.711 audio media. */
export function parseBackchannelSdp(sdp: string): BackchannelInfo {
  const sections = sdp.split(/\r?\n(?=m=)/);
  for (const s of sections) {
    if (!s.startsWith("m=audio")) continue;
    if (!/^a=sendonly\s*$/m.test(s)) continue;
    const pts = s.split(/\r?\n/)[0]!.split(" ").slice(3).map(Number);
    const control = /^a=control:(\S+)/m.exec(s)?.[1];
    for (const pt of pts) {
      const map = new RegExp(`^a=rtpmap:${pt} ([A-Za-z0-9]+)/(\\d+)`, "m").exec(s);
      const name = (map?.[1] ?? (pt === 0 ? "PCMU" : pt === 8 ? "PCMA" : "")).toUpperCase();
      const rate = Number(map?.[2] ?? 8000);
      if ((name === "PCMU" || name === "PCMA") && rate === 8000) {
        return { supported: true, codec: name, payloadType: pt, control };
      }
    }
    return { supported: false, reason: "backchannel_codec_unsupported" };
  }
  return { supported: false, reason: "no_backchannel" };
}

function splitUrl(rtspUrl: string) {
  const url = new URL(rtspUrl);
  const user = decodeURIComponent(url.username);
  const pass = decodeURIComponent(url.password);
  url.username = "";
  url.password = "";
  return { url, user, pass, clean: url.toString() };
}

function resolveControl(base: string, control: string | undefined): string {
  if (!control || control === "*") return base;
  if (/^rtsp:\/\//i.test(control)) return control;
  return `${base.replace(/\/$/, "")}/${control}`;
}

async function openAndDescribe(rtspUrl: string) {
  const { url, user, pass, clean } = splitUrl(rtspUrl);
  const conn = new RtspConn(url, user, pass);
  await conn.ready();
  const res = await conn.request("DESCRIBE", clean, { Accept: "application/sdp" });
  return { conn, res, clean };
}

export async function probeBackchannel(rtspUrl: string): Promise<BackchannelInfo> {
  let conn: RtspConn | null = null;
  try {
    const opened = await openAndDescribe(rtspUrl);
    conn = opened.conn;
    if (opened.res.status === 551) return { supported: false, reason: "backchannel_not_supported" };
    if (opened.res.status === 401) return { supported: false, reason: "unauthorized" };
    if (opened.res.status !== 200) return { supported: false, reason: `describe_${opened.res.status}` };
    return parseBackchannelSdp(opened.res.body);
  } catch (err) {
    return { supported: false, reason: err instanceof Error ? err.message : "connect_failed" };
  } finally {
    conn?.close();
  }
}

/** Transcodes any ffmpeg-readable clip to 8 kHz mono G.711. */
export function transcodeToG711(input: Buffer, codec: BackchannelCodec, maxSeconds = 30): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-t", String(maxSeconds),
      "-ac", "1", "-ar", "8000", "-f", codec === "PCMU" ? "mulaw" : "alaw", "pipe:1",
    ]);
    const out: Buffer[] = [];
    let err = "";
    ff.stdout.on("data", (d: Buffer) => out.push(d));
    ff.stderr.on("data", (d: Buffer) => (err += d.toString()));
    ff.on("error", reject);
    ff.on("close", (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg failed: ${err.slice(0, 200)}`))));
    ff.stdin.on("error", () => undefined);
    ff.stdin.end(input);
  });
}

/**
 * Streams already-encoded G.711 samples to the camera's backchannel in real
 * time (20 ms RTP packets). Resolves with packets sent.
 */
export async function sendBackchannelAudio(rtspUrl: string, samples: Buffer, opts: { realtime?: boolean } = {}): Promise<{ packets: number; codec: BackchannelCodec }> {
  const { conn, res, clean } = await openAndDescribe(rtspUrl);
  try {
    if (res.status !== 200) throw new Error(res.status === 551 ? "backchannel_not_supported" : `describe_${res.status}`);
    const info = parseBackchannelSdp(res.body);
    if (!info.supported) throw new Error(info.reason ?? "no_backchannel");
    const base = res.headers["content-base"] ?? clean;
    const setup = await conn.request("SETUP", resolveControl(base, info.control), {
      Transport: "RTP/AVP/TCP;unicast;interleaved=0-1",
    });
    if (setup.status !== 200) throw new Error(`setup_${setup.status}`);
    conn.session = (setup.headers["session"] ?? "").split(";")[0] ?? null;
    const play = await conn.request("PLAY", base, { Range: "npt=0.000-" });
    if (play.status !== 200) throw new Error(`play_${play.status}`);

    const ssrc = crypto.randomBytes(4).readUInt32BE(0);
    let seq = crypto.randomInt(0, 65535);
    let ts = crypto.randomInt(0, 2 ** 31);
    let packets = 0;
    const start = Date.now();
    for (let off = 0; off < samples.length; off += 160) {
      const chunk = samples.subarray(off, off + 160);
      const rtp = Buffer.alloc(12);
      rtp[0] = 0x80;
      rtp[1] = (info.payloadType ?? 0) | (packets === 0 ? 0x80 : 0);
      rtp.writeUInt16BE(seq & 0xffff, 2);
      rtp.writeUInt32BE(ts >>> 0, 4);
      rtp.writeUInt32BE(ssrc, 8);
      conn.writeInterleaved(0, Buffer.concat([rtp, chunk]));
      packets++;
      seq++;
      ts += chunk.length;
      if (opts.realtime !== false) {
        const due = start + packets * 20 - Date.now();
        if (due > 0) await new Promise((r) => setTimeout(r, due));
      }
    }
    await conn.request("TEARDOWN", base).catch(() => undefined);
    return { packets, codec: info.codec! };
  } finally {
    conn.close();
  }
}
