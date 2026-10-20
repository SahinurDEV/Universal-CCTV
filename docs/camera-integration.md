# Camera Integration

Two audiences, two halves of this doc: **Part 1** is for engineers working on
the connector code. **Part 2** is a plain-language guide for anyone adding
their own camera through the dashboard.

---

## Part 1 — Technical reference

### What actually happens today

| Action | Implementation | Verified against |
|---|---|---|
| Register a camera's connection details | `POST /cameras` — stores host/port/encrypted credential, creates an unconfirmed (`UNSUPPORTED`) capability record | Real Postgres (integration tests) |
| Test connection | `POST /cameras/:id/test-connection` — shells out to `ffprobe` against the camera's RTSP URL with an 8s timeout, parses the real stream list | A real, continuously-live RTSP stream (MediaMTX + a synthetic ffmpeg feed in `docker-compose.yml`) |
| LAN discovery | `POST /cameras/discover` — ONVIF WS-Discovery (UDP multicast, via the `onvif` npm package) for 1–15 seconds | Runs for real on this machine; finds 0 devices because there's no real ONVIF camera on this network — see the limitation below |

Everything else in docs/architecture.md §3 (ONVIF capability confirmation
beyond "does the RTSP stream exist" — PTZ, motion events, image settings,
firmware update) is **not implemented**. A camera can test as
`FULLY_SUPPORTED` today purely on the strength of its RTSP stream; that tier
name reflects "everything this camera claimed to need was confirmed," not
"every possible camera feature was confirmed" — see `capabilitiesFromRtspProbe`
in `apps/api/src/connectors/rtsp-probe.ts` for exactly what is and isn't set.

### Connection-test mechanics

`apps/api/src/connectors/rtsp-probe.ts`:
- Builds the RTSP URL server-side (`rtsp-url.ts`) from the stored host/port
  and the decrypted credential — the URL, which embeds the camera's
  username/password, is never logged, never returned to the client, and is
  scrubbed out of ffprobe's own stderr before that error text is surfaced.
- Runs `ffprobe -rtsp_transport tcp -timeout <µs> -show_streams <url>` as a
  child process with an array of arguments (never a shell string), so a
  hostile host/credential value can't inject shell commands.
- A video stream present → `liveView`/`cloudRecording`/`playback` confirmed
  true. An audio stream present → `audio` confirmed true. Nothing else is
  ever set true by this function — PTZ etc. require ONVIF, which this
  doesn't do.
- Every test overwrites the camera's `CameraCapabilityRecord` with what was
  *just* confirmed (not merged with old data) and appends a
  `CameraConnectionSession` row for history/audit.

### Discovery mechanics and its real limitation

`apps/api/src/connectors/onvif-discovery.ts` wraps the `onvif` package's
WS-Discovery probe. **This only finds devices on the same LAN/broadcast
domain as the process running the API.** That's true today because this is
a local/self-hosted deployment — the API runs on your machine, on your
network, same as the camera.

It will **not** work once there's a cloud-hosted multi-tenant version of this
platform: a cloud server has no network path onto a customer's home or
office LAN to send a multicast probe. Reaching cameras from the cloud
requires the local gateway agent described in docs/architecture.md §6 (an
on-prem process that opens an outbound connection to the cloud) — not built
yet. Don't remove this limitation note when that gateway ships; update it to
describe how discovery routes through the gateway instead.

### SSRF guard interaction with SIMULATED cameras

`lib/network-guard.ts`'s `assertSafeCameraHost` blocks loopback/link-local
hosts — which would normally block `localhost`, the address the simulated
camera fixture uses. Both the create and update routes skip this check
specifically when `connectorType === "SIMULATED"`, since that connector type
always points at our own dev fixture, not an arbitrary user-supplied target.
Real RTSP/ONVIF cameras still go through the full guard.

### What a test to hardware would require

No test in this repo exercises a real, physical camera — only the synthetic
MediaMTX-fed stream. If you add real-camera test coverage, document the
specific model/firmware tested and don't generalize the result to "RTSP
cameras work" — see docs/requirements.md's "definition of done."

---

## Part 2 — Connecting your camera (end-user guide)

### Before you start

You'll need three things from your camera:
1. Its **IP address** on your network (e.g. `192.168.1.50`).
2. Whether it supports **RTSP** or **ONVIF** (most IP cameras support RTSP;
   many also support ONVIF).
3. A **username and password** for the camera's video stream, if it has one.

### Option A: Let us find it for you

On the "Add camera" screen, click **Scan network**. This looks for ONVIF
cameras on your local network for a few seconds and lists anything found —
click **Use this** on your camera to fill in its address automatically.

**This only works if the device running this software is on the same
network as your camera.** If you're running this on your own computer at
home or in your office (which is how this platform runs today), that's
normally the case. If nothing shows up:
- Your camera might not support ONVIF (try Option B instead).
- Your camera might be on a different network/VLAN or behind a separate
  router.
- Some cameras need ONVIF explicitly turned on in their settings (see below).

### Option B: Enter it manually

If you already know your camera's IP address:

1. **Find the IP address.** Check your router's "connected devices" page
   (often at `192.168.1.1` or `192.168.0.1` in a browser), or use the
   camera manufacturer's own app/finder tool, which usually shows it.
2. **Find the RTSP port and stream path.** Most cameras use port `554` and
   a path like `/stream1` or `/live/ch0` — check your camera's manual or
   manufacturer's support page; this varies a lot by brand. A few common
   defaults:
   - Hikvision-style: `/Streaming/Channels/101`
   - Dahua-style: `/cam/realmonitor?channel=1&subtype=0`
   - Many generic/ONVIF cameras: `/onvif1` or `/live`
   - If none of these work, your camera's own app usually shows the exact
     RTSP URL somewhere in its sharing/export settings.
3. **Enter the username/password** your camera uses for its video stream
   (often different from its web-admin password on some brands — check the
   camera's settings for "RTSP authentication" or "stream credentials").
4. Click **Add camera**, then open it and click **Test Connection**.

### Enabling RTSP/ONVIF on your camera

Most cameras ship with RTSP already on, but ONVIF sometimes needs to be
turned on explicitly:
- Log into your camera's own web interface or app (usually by typing its IP
  address into a browser, or via the manufacturer's app).
- Look for a setting named **ONVIF**, **Network → Platform Access**, or
  similar, and enable it — note the ONVIF username/password shown there,
  which may differ from your main admin login.
- Save, then try **Scan network** again.

### Reading the "Test Connection" result

- **Connected successfully** — we received real video (and audio, if your
  camera sends it) from the stream you configured. The camera's support tier
  updates to reflect exactly what was confirmed.
- **Connection failed** — the message explains why (wrong credentials, wrong
  path, camera unreachable, or it timed out). Double-check the host, port,
  path, and credentials, and make sure the camera is powered on and on the
  same network.

### Troubleshooting

| Symptom | Likely cause |
|---|---|
| "Connection failed" with a 404-style message | Wrong stream path — check your camera's manual for the correct RTSP path |
| "Connection failed" with an authentication error | Wrong username/password, or the camera uses separate "stream" credentials from its admin login |
| Times out | Camera is off, on a different network, or a firewall is blocking port 554 (or whatever port you configured) |
| Scan finds nothing | Camera doesn't support ONVIF, ONVIF isn't enabled on it, or it's on a different network — try Option B |
| "That host is not allowed" when adding | You entered a loopback address (`127.0.0.1`) or similar — that's blocked on purpose; use your camera's real LAN IP |

### What this doesn't do yet

Connecting a camera here does **not** currently record video, show a live
preview, or control PTZ/zoom — those are separate, not-yet-built features
(see docs/requirements.md). Today, connecting a camera proves the platform
*can* reach its video stream; what happens with that stream (recording,
live view) is upcoming work.
