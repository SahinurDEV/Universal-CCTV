import net from "node:net";
import crypto from "node:crypto";
import type { AddressInfo } from "node:net";

/**
 * Tiny RTSP server that behaves like a camera with an ONVIF audio
 * backchannel (PCMU). It only exists so the backchannel client can be tested
 * end-to-end; it does not serve video. Digest auth is enforced when a
 * username is set.
 */
export interface BackchannelSim {
  port: number;
  receivedPackets: number;
  receivedBytes: number;
  payloadTypes: Set<number>;
  requests: string[];
  close: () => Promise<void>;
}

export async function startBackchannelSimulator(opts: { host?: string; username?: string; password?: string; backchannel?: boolean } = {}): Promise<BackchannelSim> {
  const realm = "sim";
  const nonce = crypto.randomBytes(8).toString("hex");
  const md5 = (s: string) => crypto.createHash("md5").update(s).digest("hex");
  const sim: BackchannelSim = { port: 0, receivedPackets: 0, receivedBytes: 0, payloadTypes: new Set(), requests: [], close: async () => undefined };
  const sockets = new Set<net.Socket>();

  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    let buf = Buffer.alloc(0);
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (buf[0] === 0x24) {
          if (buf.length < 4) return;
          const len = buf.readUInt16BE(2);
          if (buf.length < 4 + len) return;
          const pkt = buf.subarray(4, 4 + len);
          sim.receivedPackets++;
          sim.receivedBytes += Math.max(0, pkt.length - 12);
          sim.payloadTypes.add(pkt[1]! & 0x7f);
          buf = buf.subarray(4 + len);
          continue;
        }
        const end = buf.indexOf("\r\n\r\n");
        if (end < 0) return;
        const head = buf.subarray(0, end).toString("latin1");
        buf = buf.subarray(end + 4);
        const [reqLine, ...lines] = head.split("\r\n");
        const [method, uri] = (reqLine ?? "").split(" ");
        const h: Record<string, string> = {};
        for (const l of lines) {
          const i = l.indexOf(":");
          if (i > 0) h[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
        }
        sim.requests.push(method ?? "");
        const cseq = h["cseq"] ?? "0";
        const reply = (status: string, extra: Record<string, string> = {}, body = "") => {
          const hdrs = { CSeq: cseq, ...extra, ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}) };
          sock.write(`RTSP/1.0 ${status}\r\n${Object.entries(hdrs).map(([k, v]) => `${k}: ${v}`).join("\r\n")}\r\n\r\n${body}`);
        };
        if (opts.username) {
          const auth = h["authorization"] ?? "";
          const resp = /response="([^"]+)"/.exec(auth)?.[1];
          const u = /uri="([^"]+)"/.exec(auth)?.[1] ?? "";
          const ok =
            /username="([^"]+)"/.exec(auth)?.[1] === opts.username &&
            resp === md5(`${md5(`${opts.username}:${realm}:${opts.password ?? ""}`)}:${nonce}:${md5(`${method}:${u}`)}`);
          if (!ok) {
            reply("401 Unauthorized", { "WWW-Authenticate": `Digest realm="${realm}", nonce="${nonce}"` });
            continue;
          }
        }
        const wantsBack = (h["require"] ?? "").includes("www.onvif.org/ver20/backchannel");
        if (wantsBack && opts.backchannel === false) {
          reply("551 Option not supported", { Unsupported: "www.onvif.org/ver20/backchannel" });
          continue;
        }
        switch (method) {
          case "DESCRIBE": {
            const sdp =
              "v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\ns=sim\r\nt=0 0\r\n" +
              "m=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:track1\r\na=recvonly\r\n" +
              (wantsBack ? "m=audio 0 RTP/AVP 0\r\na=rtpmap:0 PCMU/8000\r\na=control:track2\r\na=sendonly\r\n" : "");
            reply("200 OK", { "Content-Type": "application/sdp", "Content-Base": `${uri}/` }, sdp);
            break;
          }
          case "SETUP":
            reply("200 OK", { Transport: "RTP/AVP/TCP;unicast;interleaved=0-1", Session: "12345678;timeout=60" });
            break;
          case "PLAY":
          case "TEARDOWN":
          case "OPTIONS":
            reply("200 OK", { Session: "12345678" });
            break;
          default:
            reply("405 Method Not Allowed");
        }
      }
    });
    sock.on("error", () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, opts.host ?? "127.0.0.1", r));
  sim.port = (server.address() as AddressInfo).port;
  sim.close = () =>
    new Promise<void>((r) => {
      sockets.forEach((s) => s.destroy());
      server.close(() => r());
    });
  return sim;
}
