# System Architecture — Universal CCTV Cloud Platform

## 1. Component map

| Component | Responsibility | Stack |
|---|---|---|
| Web App | Dashboard, live view, playback UI | Next.js, TypeScript, Tailwind |
| Backend API | REST + WebSocket, auth, authorization, orchestration | Node.js, Express, TypeScript |
| Camera Integration Service | Connector interface + per-manufacturer adapters | Node.js (TS), runs inside API/worker processes |
| Camera Capability Registry | Canonical capability model per camera, persisted | PostgreSQL table `camera_capabilities` |
| Video Ingestion Service | Pulls RTSP, writes segments | Node worker shelling out to FFmpeg |
| Recording Manager | Job lifecycle, dedup, retry, gap detection | Node.js + BullMQ + Redis |
| Video Processing Workers | Run ingestion jobs, upload segments | Node.js + BullMQ workers (horizontally scalable) |
| Cloud Storage Service | Object storage abstraction | S3 SDK, MinIO (dev) / AWS S3 (prod) |
| Recording Metadata DB | Segment/job/retention metadata | PostgreSQL + Prisma |
| Subscription & Billing Service | Plans, quotas, billing adapter | Node.js module, pluggable provider |
| Notification Service | Health alerts, quota alerts | Node.js + BullMQ, email adapter |
| Local Gateway Agent | LAN camera discovery, outbound tunnel to cloud | **Go** — static binary, cross-platform (see §6) |
| Monitoring/Logging | Structured logs, health/metrics endpoints | pino (structured logs), `/health` `/ready` |

**Why Go only for the gateway, not the rest of the backend:** the gateway runs
unattended on arbitrary customer hardware (a Windows PC, a Pi, a NUC) with no managed
runtime. A single static binary with low idle memory and strong concurrency for
many camera heartbeats/tunnels is a better fit there than shipping a Node runtime.
The API/workers run on infrastructure we control, where Node + BullMQ + ffmpeg is a
well-understood, fast-to-iterate combination and introducing a second language in
the core request/recording path would cost more in cross-team maintenance than it
would gain in raw performance (ffmpeg, not the orchestration language, is the hot
path there).

## 2. Data flow

```
Camera
  │ RTSP (LAN) / ONVIF
  ▼
Camera Connector (RTSP | ONVIF | Simulated adapter)
  │ validated stream + capability probe
  ▼
Video Ingestion Service (ffmpeg, stream-copy where possible)
  │ segments (fixed duration, e.g. 60s) + diagnostic logs
  ▼
Recording Manager (BullMQ job: one per camera, dedup by cameraId+activeFlag)
  ├──► Video Segment file ──► Cloud Storage Service ──► S3 / MinIO
  └──► Segment Metadata row ──► PostgreSQL (recording_segments)
                                     │
                                     ▼
                              Backend API (authz-scoped queries, signed URL issuance)
                                     │
                                     ▼
                              Web Application (live view / playback)
```

Large video bytes never transit the main API process: workers write directly to
object storage, and playback is served via short-lived signed URLs issued by the API
but fetched by the browser directly from storage.

## 3. Camera connector interface

All connectors implement the same TypeScript interface so the rest of the system is
manufacturer-agnostic:

```ts
interface CameraConnector {
  discover?(network: DiscoveryScope): Promise<DiscoveredDevice[]>;
  validateCredentials(config: CameraConnectionConfig): Promise<boolean>;
  openStream(config: CameraConnectionConfig): Promise<StreamHandle>;
  getDeviceInfo(config: CameraConnectionConfig): Promise<DeviceInfo>;
  detectCapabilities(config: CameraConnectionConfig): Promise<CameraCapabilities>;
  getStreamProfiles?(config: CameraConnectionConfig): Promise<StreamProfile[]>;
  getImagingSettings?(config: CameraConnectionConfig): Promise<ImagingSettings>;
  ptz?: PTZControl; // present only if capability says ptz === true
  getMotionEvents?(config: CameraConnectionConfig): Promise<MotionEventSubscription>;
  configureRecording?(config: CameraConnectionConfig, opts: RecordingConfig): Promise<void>;
  getConnectionStatus(config: CameraConnectionConfig): Promise<ConnectionStatus>;
  disconnect(handle: StreamHandle): Promise<void>;
}

interface CameraCapabilities {
  liveView: boolean;
  cloudRecording: boolean;
  playback: boolean;
  ptz: boolean;
  zoom: boolean;
  motionEvents: boolean;
  imageSettings: boolean;
  audio: boolean;
  firmwareUpdate: boolean;
}
```

Rules enforced in code, not just docs:
- `detectCapabilities` is the **only** source of truth written to
  `camera_capabilities`. No capability is set `true` from a model-number lookup
  table alone — RTSP/ONVIF probing (or an explicit tested-and-documented override
  for a specific firmware version) is required.
- Optional interface methods (`ptz`, `getMotionEvents`, etc.) are only invoked by
  the API/UI when the corresponding capability flag is `true`. The UI disables,
  rather than hides, controls for `false` flags, with a tooltip explaining why
  (e.g. "This camera does not expose ONVIF PTZ control").
- A connector that cannot complete `detectCapabilities` (timeout, auth failure,
  protocol not implemented) must return a capability object that is all-`false`
  except fields it can prove, and the camera's overall status becomes
  `unsupported` or `partially_supported`, never `fully_supported`.

### Support tiers surfaced in the UI

| Tier | Meaning |
|---|---|
| `fully_supported` | RTSP stream confirmed + all capabilities the model claims are confirmed |
| `partially_supported` | RTSP stream confirmed, some capabilities (e.g. PTZ) unconfirmed/absent |
| `connected_missing_capabilities` | Stream confirmed, ONVIF unreachable, falls back to RTSP-only capability set |
| `unsupported` | No usable stream could be established (wrong protocol, auth failure, unreachable) |

## 4. Connection strategies (MVP vs later)

| Method | MVP? | Notes |
|---|---|---|
| Direct RTSP (same LAN as API/worker) | Yes | Used for local dev and for self-hosted/on-prem deployments where the worker runs on-site |
| Local gateway, outbound tunnel | Documented, not implemented | Needed for cloud-hosted workers to reach cameras behind residential NAT; see §6 |
| ONVIF discovery/capability | Best-effort, Yes | WS-Discovery on the same broadcast domain as the probing process |
| Manufacturer API/SDK adapters | No | Requires per-manufacturer developer agreements; stubbed as a connector type with none implemented |

## 5. SSRF / network-safety boundary

Because users supply arbitrary hostnames/IPs for "their" camera, every connector
call is routed through a single network-egress guard before any socket opens:

- Resolve the hostname, reject if it resolves to a loopback, link-local, or cloud
  metadata address (`169.254.169.254`, `fd00:ec2::254`, etc.) unless the target is
  on an explicit tenant-scoped allowlist.
- Reject ports outside an allowlisted set for the connector type (RTSP: 554 and
  tenant-declared custom ports only).
- Connector network calls run in a worker process, never in the main API request
  path, so a slow/hostile target can't tie up API capacity.

## 6. Local Gateway Agent (Go) — design, not yet implemented

- Enrolls via a short-lived pairing code shown in the dashboard; receives a
  long-lived device identity (keypair, not a shared secret).
- Opens a single outbound mTLS/WebSocket connection to the cloud; the cloud never
  initiates a connection to the gateway or the camera.
- Heartbeats every N seconds; missed heartbeats surface as `camera offline`
  notifications after a debounce window (avoids alert storms on flaky networks).
- Credential rotation: cloud can push a rotation command over the existing
  connection; the old credential is revoked only after the gateway acks the new one.
- Revocation: deleting the gateway in the dashboard invalidates its identity
  server-side immediately; the next heartbeat attempt is rejected.

This is tracked as Phase 4+ work (see docs/requirements.md) — not built in this pass.

## 7. Risks and external dependencies

| Risk | Mitigation / status |
|---|---|
| No AWS account/credentials available in this environment | S3-compatible abstraction built against MinIO locally; same code path targets real S3 by config only. Documented as untested-against-real-S3 until credentials are supplied. |
| No physical camera hardware available | Simulated RTSP connector + MediaMTX-based test stream for dev/CI. Real-camera testing explicitly flagged as required before claiming support for any specific model. |
| ONVIF behavior varies wildly by vendor/firmware | Treated as best-effort; capability detection always falls back safely to RTSP-only rather than guessing. |
| Payment provider availability varies by country | Billing provider abstraction with a dev adapter; no real payment provider wired until one is explicitly chosen. |
| Horizontal scaling of ffmpeg workers | BullMQ workers are stateless re: job assignment (job carries camera+RTSP config); scaling is "add another worker process" — validated once Phase 5 lands real load. |

## 8. Tenant isolation

Every table that stores tenant-owned data carries `tenantId`. All Prisma queries in
the API go through repository functions that require a `tenantId` parameter — there
is no "query all cameras" code path without a tenant scope. This is covered by an
automated test (see docs/testing.md) that asserts cross-tenant reads return 404/empty,
not another tenant's data.
