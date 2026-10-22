# PTZ control and two-way audio

## PTZ (ONVIF)

**What works**

- Continuous pan/tilt/zoom (hold a button to move, release to stop), Stop, and
  presets (save current position, go to, remove), via the ONVIF PTZ service
  (`ContinuousMove`, `Stop`, `GetStatus`, `GetPresets`, `SetPreset`,
  `GotoPreset`, `RemovePreset`) using the `onvif` npm client with WS-Security
  digest auth.
- Controls appear in the web camera page (`PtzPanel`) and the mobile camera
  screen (`PtzControls`) **only** when the camera's capability record says
  `ptz = true`. That flag is only written by **Test connection** for ONVIF
  cameras, after the device advertises a PTZ service *and* its active profile
  has a PTZ configuration. Zoom buttons follow the `zoom` flag.
- Every move carries an ONVIF `Timeout` (default 1.5 s from the UIs, max
  10 s). Clients re-send the move every second while the button is held, so a
  lost Stop (tab closed, phone loses signal) can't leave the camera turning.

**API** (all under `/cameras/:id`)

| Method | Path | Who |
|---|---|---|
| GET | `/ptz` → `{supported, zoom, canControl, presets, status}` | any member |
| POST | `/ptz/move` `{x, y, zoom ∈ [-1,1], timeoutMs 100–10000}` | Operator+ |
| POST | `/ptz/stop` | Operator+ |
| POST | `/ptz/presets` `{name}` | Operator+ |
| POST | `/ptz/presets/:token/goto` | Operator+ |
| DELETE | `/ptz/presets/:token` | Operator+ |

- Bodies are strict zod schemas; preset names are letters/digits/space/`_.-`
  only, tokens `[A-Za-z0-9_.:-]`.
- Rate limit: 240 control requests / minute **per user** (`429 too_many_requests`).
- Audit log: `camera.ptz.move`, `camera.ptz.stop`, `camera.ptz.preset.set`,
  `camera.ptz.preset.goto`, `camera.ptz.preset.remove` with the actor.
- The camera host is re-checked by the SSRF guard (DNS-resolved) before every
  ONVIF connection; loopback / link-local stay blocked. ONVIF sessions are
  cached for 5 minutes per camera and dropped on any error.

## Two-way audio

**Listening** is unchanged: if the camera's RTSP stream has an audio track
(`capability.audio`), it plays in the existing HLS live view.

**Talking** uses the ONVIF audio backchannel (ONVIF Streaming spec §5.3):

1. The API opens an RTSP session to the camera with
   `Require: www.onvif.org/ver20/backchannel`.
2. A camera that supports it answers `DESCRIBE` with an extra
   `m=audio … a=sendonly` media. We accept **G.711 PCMU or PCMA at 8 kHz**
   (the codec ONVIF Profile T requires for backchannels).
3. The browser records a clip with `MediaRecorder` while you hold **Hold to
   talk**. On release the clip is uploaded (`POST /audio/talk`, ≤ 2 MB,
   ≤ 30 s), transcoded with ffmpeg to 8 kHz mono G.711, and streamed to the
   camera as RTP over the RTSP TCP connection (interleaved), paced in real time
   in 20 ms packets.

`GET /cameras/:id/audio` → `{listen, talk, codec, canTalk, reason}`; the
backchannel probe result is cached for 10 minutes. Talk is Operator+,
rate-limited to 20 clips / minute per user, one clip at a time per camera, and
audit-logged (`camera.audio.talk` with duration and codec — never the audio).

### Honest limits

- **Push-to-talk, not a live call.** You hear nothing back in real time
  through this path, and the person at the camera hears you only after you
  release the button (latency ≈ clip length + 1–2 s). It is half duplex.
- **No WebRTC / WHIP.** MediaMTX can *receive* WHIP from a browser, but it
  does not forward audio into an ONVIF RTSP backchannel of a *source* camera,
  so a WHIP → camera path isn't possible with our current relay. A real-time
  version would need a server-side WebRTC endpoint (e.g. a custom
  pion/werift bridge) that pipes Opus → G.711 → backchannel continuously.
  Not built.
- **G.711 only.** Cameras that only offer an AAC backchannel report
  `backchannel_codec_unsupported`.
- **RTSP over TCP only**, Basic or Digest (MD5) auth. No UDP, no RTSPS.
- **Vendor-specific two-way audio is not supported.** Many consumer cameras
  (Hikvision ISAPI "two-way audio", Dahua HTTP audio, Reolink/Tapo cloud apps)
  don't implement the ONVIF backchannel at all; they show `talk: false`.
- **The fake camera (MediaMTX `simulated` path) has no backchannel**, so in
  the local environment Talk is hidden for it; the API reports
  `no_backchannel` / `simulated_camera`.
- **Mobile app:** PTZ controls and presets are in the app. Talk is **web
  only** for now (the app would need a native audio-recording plugin and
  microphone permission flow).

## Testing without a camera

There is no physical ONVIF camera here, so we wrote simulators:

- `src/onvif-sim/server.ts` — ONVIF device/media/PTZ SOAP server that checks
  WS-Security digests and keeps a real PTZ state (position integrates
  velocity; presets store positions). Run it with `pnpm --filter api
  onvif:sim` (port 8000, `admin`/`admin`; `ONVIF_SIM_HOST` to bind a LAN IP).
- `src/onvif-sim/rtsp-backchannel-sim.ts` — RTSP server that offers a PCMU
  backchannel, enforces Digest auth and counts the RTP packets it receives.

`src/routes/ptz-audio.integration.test.ts` drives the real API → real
`onvif` client → simulator over TCP: capability detection via **Test
connection**, move/stop changing the simulated position, presets, strict
validation, Viewer 403s, cross-workspace 404s, audit rows, the per-user rate
limit, backchannel discovery, and a real webm/Opus clip transcoded and
received as ~50 PCMU RTP packets.

These simulators were written against the requests our client sends, so they
prove our code path, **not** interoperability with every vendor's firmware.
Nothing here has been tried on real PTZ or backchannel hardware yet.
