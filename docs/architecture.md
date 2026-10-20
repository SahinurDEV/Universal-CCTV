# System Architecture — Universal CCTV Cloud Platform

## 1. Component map

| Component | Responsibility | Stack |
|---|---|---|
| Web App | Dashboard, live view, playback UI | Next.js, TypeScript, Tailwind |
| Backend API | REST + WebSocket, auth, authorization, orchestration | Node.js, Express, TypeScript |
| Camera Integration Service | Connector interface + per-manufacturer adapters | Node.js (TS), runs inside API/worker processes |
| Camera Capability Registry | Canonical capability model per camera, persisted | PostgreSQL table `camera_capabilities` |
| Video Ingestion Service | Pulls RTSP, writes segments | **Implemented** — MediaMTX itself (native Go stream-copy, no ffmpeg in this path); `apps/api` only drives its config API |
| Recording Manager | Job lifecycle, dedup, retry, gap detection | **Partially implemented** — job lifecycle + dedup via `RecordingJob`/one-active-job check; retry/gap detection not yet built |
| Video Processing Workers | Run ingestion jobs, upload segments | **Implemented** — `apps/api/src/worker.ts`, Node.js + BullMQ (polls MediaMTX's recordings API every 15s; see docs/video-recording.md) |
| Cloud Storage Service | Object storage abstraction | **Implemented** — `apps/api/src/lib/storage.ts`, AWS SDK v3, LocalStack (dev) / AWS S3 (prod) |
| Recording Metadata DB | Segment/job/retention metadata | PostgreSQL + Prisma |
| Retention Enforcement | Expire + delete segments past policy, storage usage accounting | **Implemented** — `apps/api/src/recording/retention.ts` (BullMQ job in `worker.ts`), `GET /storage/usage`; see docs/retention-and-storage.md |
| Storage Reconciliation | Find and delete S3 objects with no matching DB row (orphaned by a deleted camera or a crash mid-ingest) | **Implemented** — `apps/api/src/recording/reconciliation.ts` (BullMQ job in `worker.ts`); see docs/retention-and-storage.md |
| Subscription & Billing Service | Plans, quotas, billing adapter | **Implemented** (dev adapter only, no real payment provider) — `apps/api/src/billing/provider.ts`, `apps/api/src/lib/quota.ts`; see docs/subscriptions-and-billing.md |
| Notification Service | Health alerts, quota alerts | **Implemented** (in-app only, no email/SMS/webhook adapter) — `apps/api/src/lib/notifications.ts` (dedup chokepoint), `apps/api/src/recording/health.ts`, a 30s BullMQ health-check job in `worker.ts`; see docs/monitoring-and-alerts.md |
| Local Gateway Agent | LAN camera discovery, outbound tunnel to cloud | **Go** — static binary, cross-platform (see §6) |
| Monitoring/Logging | Structured logs, health/metrics endpoints | pino (structured logs), `/health` `/ready`; see docs/monitoring-and-alerts.md for the camera/recording health signals beyond process-level logging |

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
MediaMTX (pulls the stream as path "cam-{cameraId}", stream-copy fMP4 segments
          to its own disk — no ffmpeg/transcoding in this path at all)
  ▼
apps/api/src/worker.ts polls MediaMTX's recordings-list API every 15s
  ├──► fetches each finished segment over HTTP (MediaMTX playback API)
  ├──► Cloud Storage Service ──► S3 / LocalStack
  ├──► Segment Metadata row ──► PostgreSQL (recording_segments)
  └──► deletes the segment from MediaMTX's own disk once both succeed
                                     │
                                     ▼
                              Backend API (authz-scoped queries, signed URL issuance — implemented, docs/playback.md)
                                     │
                                     ▼
                              Web Application (playback implemented; live view not yet built)
```

See docs/video-recording.md for the full mechanics, including why polling
(not a webhook) and a real duration-accuracy bug found and fixed while
verifying this against the actual running stack.

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
| Direct RTSP (same LAN as API/worker) | **Implemented** | `POST /cameras/:id/test-connection`; used for local dev and for self-hosted/on-prem deployments where the API runs on-site |
| Local gateway, outbound tunnel | Documented, not implemented | Needed for cloud-hosted workers to reach cameras behind residential NAT; see §6. ONVIF discovery and RTSP testing both inherit this limitation today — they only work on the API's own LAN |
| ONVIF discovery/capability | **Both implemented** — discovery (WS-Discovery) and capability fetch (PTZ, zoom, motion events, imaging, firmware) | WS-Discovery on the same broadcast domain as the probing process; capability fetch's connect-and-fail-cleanly path verified against real non-ONVIF services (no physical ONVIF camera in this environment); see docs/camera-integration.md |
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

**Real vulnerability found and fixed (Phase 9 security review):** the guard
above was fully bypassable — the `SIMULATED` connector type skipped it
entirely, so a request could declare `connectorType: "SIMULATED"` with any
`host`, including the cloud metadata address, and the server would actually
dial it on test-connection/recording-start. Fixed by requiring `SIMULATED`
cameras to use the literal `host: "localhost"` dev-fixture address and
routing every other connector type through the unchanged guard; a
regression test (`cameras.integration.test.ts`) tries the original exploit
payload and asserts it's rejected. Full writeup, including a second finding
(MediaMTX's unauthenticated config/playback API bound to all interfaces
instead of loopback), in docs/security.md.

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
| No physical camera hardware available | **Implemented**: MediaMTX + an ffmpeg-fed synthetic test stream (`docker-compose.yml`) gives connection-testing a real, continuously-live RTSP source to probe. Real-camera testing is still explicitly flagged as required before claiming support for any specific model — the simulated stream proves the pipeline shape, not hardware compatibility. |
| ONVIF behavior varies wildly by vendor/firmware | Treated as best-effort; capability detection always falls back safely to RTSP-only rather than guessing. |
| Payment provider availability varies by country | **Implemented**: billing provider abstraction with a dev adapter (docs/subscriptions-and-billing.md); no real payment provider wired until one is explicitly chosen. |
| Horizontal scaling of ffmpeg workers | BullMQ workers are stateless re: job assignment (job carries camera+RTSP config); scaling is "add another worker process" — validated once Phase 5 lands real load. |
| Security review found two real, fixable vulnerabilities before production | **Implemented**: SSRF guard bypass via the `SIMULATED` connector type, and MediaMTX's dev-only API bound to all interfaces — both fixed and verified against the real stack; see §5 above and docs/security.md. Since this was one review pass at one point in time, not a continuous control, further changes to `cameras.ts` or the network-guard code should be re-reviewed rather than assumed still safe. |
| No alert delivery outside the dashboard | `Notification` rows are the entire delivery mechanism today (docs/monitoring-and-alerts.md) — an operator who isn't actively looking at the dashboard will not be paged. Acceptable for MVP; an email/SMS/webhook adapter is the natural next step before relying on this for unattended production use. |
| A single DB/Redis blip could crash the whole API process | **Fixed and verified against the real containers** (not assumed): Express 4 doesn't forward an async handler's rejected promise to error middleware, so an un-try/caught DB error used to kill the entire process on any tenant's traffic. Every route/middleware now goes through `asyncHandler` to a centralized error handler; confirmed by actually stopping Postgres against a running dev server and watching the same process PID keep serving 500s. See docs/failure-recovery.md. |

## 8. Tenant isolation

Every table that stores tenant-owned data carries `tenantId`. All Prisma queries in
the API go through repository functions that require a `tenantId` parameter — there
is no "query all cameras" code path without a tenant scope. This is covered by an
automated test (see docs/testing.md) that asserts cross-tenant reads return 404/empty,
not another tenant's data.
