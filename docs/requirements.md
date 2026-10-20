# Product Requirements — Universal CCTV Cloud Platform

## 1. Problem

Consumer and SMB IP cameras are locked to manufacturer cloud subscriptions (Ring,
Reolink, Hikvision, Dahua apps, etc.). Users with mixed-brand camera fleets have no
single place to view, record, and manage footage, and are forced to pay multiple
manufacturers for cloud storage. This platform is a manufacturer-agnostic recording
and viewing layer that sits on top of cameras the user already owns.

## 2. Non-negotiable constraints

- **Not every camera is supported.** Support is per-model, determined by tested
  connector capability, never assumed from marketing material. Every camera gets one
  of four states surfaced in the UI: `fully_supported`, `partially_supported`,
  `unsupported`, `connected_missing_capabilities`.
- **No RTSP ports exposed to the public internet.** Cameras are reached via direct
  LAN RTSP (dev/same-network case) or via an outbound-only local gateway process in
  production. The cloud never opens an inbound connection to a camera.
- **No simulated functionality presented as real.** A dev/simulated camera connector
  exists for local development and tests, and is labeled as simulated everywhere it
  appears (API response field `simulated: true`, UI badge). It is never substituted
  silently for a real connector.
- **Credentials are sensitive.** RTSP URLs commonly embed `rtsp://user:pass@host`.
  These are never logged, never returned in plaintext to the browser after creation,
  and stored via a secrets reference, not inline in general-purpose tables.
- **Tenant isolation is absolute.** Every query that touches camera, recording, or
  storage data is scoped by `tenantId`, enforced at the data-access layer, not just
  in UI filtering.

## 3. MVP scope (Phases 1-2 of the technology roadmap; see docs/architecture.md)

In scope for the initial build:

1. Account registration/login, single-tenant-per-org model (org = tenant).
2. Camera CRUD: add a camera by RTSP URL (+ optional ONVIF endpoint), test connection,
   store capability record.
3. RTSP connector: connect, probe stream (codec/resolution/fps via ffprobe), report
   capabilities honestly (most RTSP-only cameras report `liveView`, `cloudRecording`,
   `playback` true and `ptz`/`motionEvents`/`imageSettings` false unless ONVIF confirms
   otherwise).
4. ONVIF connector (best-effort): device discovery on LAN (WS-Discovery), capability
   fetch (profiles, PTZ presence) where the device answers ONVIF correctly. Falls back
   to RTSP-only capability set when ONVIF probing fails or times out.
5. Simulated connector: for dev/CI, serves a looping local test video over RTSP
   (via an ffmpeg-fed `rtsp-simple-server`/`mediamtx` container) so the full pipeline
   can be exercised with zero physical hardware.
6. Recording pipeline: ffmpeg stream-copy ingestion, fixed-duration segments, segment
   upload to S3-compatible storage (MinIO locally), metadata row per segment.
7. Playback: list segments for a camera/date, generate short-lived signed GET URLs,
   play in browser `<video>` tag (MP4 segment playback for MVP; HLS is a stated
   stretch goal once multi-segment continuous playback is needed).
8. Retention: per-camera retention policy (7/30/90 days), a scheduled job that expires
   segments past retention and deletes the backing object only after the DB row is
   marked `expired`.
9. Storage quota: per-tenant storage quota tracked from actual uploaded segment sizes,
   enforced before new recording jobs start.
10. Dashboard: Overview, Cameras, Live View (MJPEG/snapshot or short RTSP-over-WS
    preview — real live view is a Phase 4+ item, not claimed before it works),
    Recordings, Storage, Settings.

Explicitly **out of scope for MVP** (tracked as later phases, not promised now):
PTZ control, motion-event ingestion, manufacturer proprietary SDKs (Wi-Fi-only
cameras), mobile apps, real billing provider integration, multi-location
hierarchies beyond a single `Location` table existing in the schema.

## 4. Definition of "done" for any feature in this project

A feature is only reported as working when:
- Real code path exists (no TODO stub returning fake success).
- It has been exercised end-to-end at least once (test or manual run) and the
  artifact it claims to produce (a row, a file in MinIO, a JWT, etc.) was verified
  to exist.
- Automated test coverage exists for the happy path and at least one failure path.
- Limitations are written down in the relevant doc, not left implicit.

## 5. Primary personas

- **Tenant admin**: owns the org, manages billing/users/locations, sees all cameras.
- **Operator**: views live/recordings, cannot manage billing or delete other users.
- **(Future) Viewer-only**: read-only access to specific cameras/locations.

## 6. Success criteria for MVP

- A developer can `docker compose up`, register an account, add the simulated
  camera, see it recording, and play back a recording segment — with no physical
  camera and no cloud account required.
- A real RTSP camera on the same LAN as the API/worker can be added and recorded
  with no code changes, only configuration.
- No tenant can retrieve another tenant's camera, recording, or signed URL.
