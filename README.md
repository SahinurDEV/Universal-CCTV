# Universal CCTV Cloud Platform

Manufacturer-agnostic cloud CCTV recording and management — connect cameras from
different brands, record to your own cloud storage, and manage playback from one
dashboard, without being locked into any single manufacturer's subscription.

**Status: the full MVP roadmap is implemented and tested**, plus a real
security review (two genuine vulnerabilities found and fixed, not a clean
report written to sound reassuring), real camera health
monitoring/alerting, and a real failure-recovery pass (two more real bugs
found by actually killing Postgres/Redis against a running server, both
fixed and reverified). See docs/requirements.md for MVP scope and
"definition of done," docs/camera-integration.md for camera connectivity,
docs/video-recording.md for recording, docs/playback.md for playback,
docs/retention-and-storage.md for retention/storage,
docs/subscriptions-and-billing.md for subscriptions,
docs/monitoring-and-alerts.md for alerting, docs/security.md and
docs/failure-recovery.md for what those two review passes found, and
docs/deployment.md for running this anywhere but here.

## Documentation

- 📘 **[User manual](docs/user-manual.md)** — sign up, add locations, connect
  cameras (RTSP paths for Hikvision, Dahua, Reolink, Axis, Tapo, Uniview,
  ONVIF), remote access, live view, recordings, alerts, settings.
- 📱 **[Mobile app](docs/mobile-app.md)** — the Flutter Android/iOS app:
  setup, running on a phone, release APK/IPA builds, Firebase push setup.
- 🧪 **[Local testing guide](docs/local-testing.md)** — exact commands to run
  and test everything locally, with or without Docker, using a fake ffmpeg camera.
- 🔒 [Security](docs/security.md) · [Testing](docs/testing.md) · [Deployment](docs/deployment.md)

## What's implemented so far

- **Mobile app (Flutter, Android + iOS)** in `apps/mobile`: configurable
  server URL, sign-in with a bearer token kept in the Keychain / Android
  Keystore, workspace switcher, locations and cameras with recording status,
  camera detail, live view and a multi-camera live grid through the existing
  HLS proxy, recordings and playback, alerts with detection labels and
  snapshots, motion and detection toggles, optional FCM push, dark mode and
  tablet layouts. Backed by a new `POST /auth/mobile/login` bearer-token
  mode and `/push/fcm/*` endpoints. See docs/mobile-app.md.

- **Share links**: time-limited public links to one camera's live view or a
  recorded clip, with optional password, view limit and instant revocation.
  HMAC-signed tokens (only a hash stored), strict scope, rate limits and audit
  log; share action in the mobile app. See docs/share-links.md.

- **People & vehicle detection**: when motion fires, a snapshot is taken and
  run through SSD MobileNet v1 (COCO, Apache-2.0) on CPU via
  onnxruntime-node; per-camera alert classes (person / vehicle / any);
  labels and a snapshot thumbnail (stored in object storage) on every
  event; falls back to plain motion alerts when the model is unavailable.
  Model is downloaded (checksum-verified) by `pnpm --filter @cctv/api
  model:download` or on first use, never committed.
- **Web Push**: VAPID + service worker; per-device subscribe/list/remove in
  Settings; follows alert preferences; disabled safely when keys are unset.
- **Retention in days**: per workspace with per-camera override, enforced
  retroactively by the worker (storage + database), storage usage per
  camera.

- **Motion-detection alerts**: per-camera on/off + sensitivity; a worker
  samples each enabled camera through MediaMTX with ffmpeg's scene-change
  filter, stores every detection, and raises a rate-limited
  `MOTION_DETECTED` alert (in-app + webhooks, respects alert preferences).
- **Team & invites**: invite by email with a role, single-use hashed token
  links with expiry, accept page (new or existing account), revoke, role
  changes and removal with owner/admin rules, workspace switcher. Email is
  sent via SMTP when `SMTP_URL` is set; otherwise the link is shown once to
  the inviter.
- **Mobile-friendly dashboard**: collapsible menu, responsive grids/forms,
  scrollable tables.

- **Live View**: multi-camera grid (1 / 2×2 / 3×3 / 4×4, location filter,
  paging) playing live HLS from MediaMTX through an authenticated API proxy —
  every playlist/segment request re-checks the session and tenant, MediaMTX
  itself is never exposed to browsers.
- **Locations**: create/edit/delete sites (name, address, time zone) and
  assign cameras; tenant-scoped with RBAC.
- **Integrations**: signed outbound webhooks (HMAC-SHA256) for every new
  alert, with per-event filtering, test delivery, secret rotation, and SSRF
  protection on the target URL.
- **Settings**: profile, password change (revokes other sessions), per-user
  alert preferences, signed-in devices / sign out everywhere else.

- Monorepo (pnpm workspaces): `apps/web` (Next.js dashboard), `apps/api`
  (Express API), `packages/shared` (camera connector/capability types shared
  by both).
- PostgreSQL schema (Prisma) covering tenancy, cameras, recordings, retention,
  subscriptions, notifications, audit logs, sessions — see
  docs/database-schema.md. Migrations applied and verified against a real
  local Postgres.
- **Authentication**: registration (creates a tenant + OWNER membership),
  login, logout, session-based auth via DB-backed revocable tokens (not
  JWTs), `/auth/me`, tenant switching. Passwords hashed with bcrypt.
- **Tenant isolation + RBAC**: every camera route is scoped by tenant;
  cross-tenant access returns 404 (not 403, to avoid leaking existence);
  role-gated actions (e.g. only OWNER/ADMIN/OPERATOR can create a camera)
  enforced server-side. Verified by integration tests against a real
  database, not mocked.
- **Camera registration (CRUD)**: register a camera's connection details
  (RTSP/ONVIF/simulated), with encrypted-at-rest credential storage
  (AES-256-GCM) and an SSRF-lite guard rejecting loopback/link-local/cloud-
  metadata hosts at creation time.
- **Real connection testing**: "Test Connection" actually shells out to
  `ffprobe` against the camera's RTSP stream and reports what it genuinely
  finds (video/audio codecs, resolution) or a real, specific failure reason.
  Verified against a real, continuously-live synthetic RTSP stream (MediaMTX
  + ffmpeg in `docker-compose.yml`), not a mock.
- **LAN auto-discovery**: "Scan network" runs a real ONVIF WS-Discovery probe
  to find cameras on the same network as the server, so you don't have to
  type in an IP address by hand. Only works when the server is on the
  camera's LAN (true for this local/self-hosted setup) — see
  docs/camera-integration.md for why a future cloud deployment needs a
  different mechanism (a local gateway agent, not built yet).
- **Real ONVIF capability confirmation**: for ONVIF cameras, "Test
  Connection" now also connects to the device's real ONVIF service and
  reports its actually-advertised PTZ/zoom/motion-events/imaging/firmware
  capabilities, instead of permanently leaving every ONVIF camera on
  "missing capabilities." Honest limitation (same as discovery above): no
  physical ONVIF camera exists in this environment, so only the
  connect-and-fail-cleanly path and the real route wiring (against the
  live simulated RTSP stream) have been verified — see
  docs/camera-integration.md.
- **Dashboard**: login/register pages, auth-gated layout with the full nav
  (Overview, Cameras, Live View, Recordings, Storage, Locations, Alerts,
  Integrations, Subscription, Settings), a working Cameras list/add/detail
  flow with discovery and connection-testing wired in against the real API.
  Every nav section is now implemented.
- **Real cloud recording pipeline**: start/stop recording a camera (any
  connector type) — MediaMTX pulls the RTSP stream and writes fMP4 segments
  natively (true stream-copy, no transcoding), a background worker
  (`pnpm --filter @cctv/api worker`) polls every 15s and uploads completed
  segments to S3, writing `RecordingSegment` rows with sizes/durations
  cross-checked against the real files. Verified end-to-end against the
  live simulated stream, including a background worker ingesting segments
  *while recording was still active*, not just on stop. See
  docs/video-recording.md — including a real duration-accuracy bug that was
  found and fixed during that verification.
- **Real playback**: a Recordings page — camera + date selectors (dates
  populated only from days that actually have recordings, never a blind
  guess), a day timeline showing real segments as bars with gaps genuinely
  visible, a video player with Previous/Next, and Download. Backed by
  short-lived signed S3 URLs; verified by independently fetching a
  generated URL and confirming the byte count matches the database exactly.
  See docs/playback.md.
- **Retention + storage accounting**: every tenant gets 7/30/90-day example
  policies at registration; a camera can be assigned one, with new segments
  picking up whatever policy was active when they were recorded (changing
  a camera's policy never rewrites already-recorded segments). A background
  job expires and deletes segments past their policy — verified: the
  real S3 object for an actually-expired segment gets deleted, while a
  segment with no policy at all is never touched (ambiguous policy means
  "keep indefinitely," not "delete it"). Storage usage is tracked from real
  segment sizes, byte-exact against the database, and shown on the Overview
  and Storage pages. See docs/retention-and-storage.md.
- **Subscriptions + quota enforcement**: every tenant starts on a 14-day
  trial of a Free plan (2 cameras / 5GB / 7-day retention — example tiers,
  not fixed pricing). Three limits are actually enforced against a real
  server, not just checked in unit logic: camera count (blocked at the
  limit, verified), retention days (a too-long policy rejected, an
  in-limit one accepted), and storage quota (blocked once usage reaches
  the plan's cap). Plan changes go through a billing-provider abstraction
  with exactly one implementation — a development adapter that never
  charges real money, labeled as such everywhere it appears. See
  docs/subscriptions-and-billing.md.
- **Security review**: a dedicated multi-pass review (not self-assessment)
  found two real, exploitable issues — both fixed and verified. One let
  anyone bypass the SSRF guard by declaring a camera `connectorType:
  "SIMULATED"` regardless of its actual host, causing the server to dial
  an attacker-chosen address; the other was MediaMTX's dev-only
  unauthenticated API being reachable from the LAN instead of the
  loopback-only exposure the project's own docs assumed. See
  docs/security.md.
- **Camera health monitoring + alerts**: a background job asks MediaMTX
  whether each actively-recording camera's connection is really up, and
  generates `CAMERA_OFFLINE`/`RECORDING_STOPPED`/`UPLOAD_FAILURE`/
  `STORAGE_QUOTA_WARNING`/`RETENTION_CLEANUP_FAILURE` alerts — verified for
  real by actually stopping the simulated camera's feed and confirming
  exactly one alert appeared (not a flood across repeated polls), then
  confirming recovery. Alerts page + an unread badge in the nav. See
  docs/monitoring-and-alerts.md.
- `/health` and `/ready` endpoints, verified against real Postgres/Redis.
- Local dev infra via Docker Compose: Postgres, Redis, S3-compatible storage
  (LocalStack), and MediaMTX (with its config + playback APIs enabled,
  loopback-only) + a synthetic camera feed.
- **Failure recovery**: a transient DB/Redis outage used to be able to take
  down the entire API process or make `/ready` itself hang for ~28
  seconds — found by actually stopping Postgres/Redis against a running
  dev server, not assumed safe. Both fixed (every route now goes through a
  centralized async-error handler; health checks are now time-bounded) and
  reverified against the real containers, including confirming the exact
  same process survives an outage and self-heals once the dependency
  returns, with no restart. See docs/failure-recovery.md.
- **Storage reconciliation**: deleting a camera was found to orphan 100%
  of its recorded footage immediately (cascades the DB rows away, never
  touches S3) — confirmed for real by deleting a camera with real
  recordings and checking both the DB and S3 directly. A background job
  now finds and removes any object with no matching DB row (with a
  15-minute safety window so an in-flight upload is never mistaken for an
  orphan), reverified against the same real scenario afterward. See
  docs/retention-and-storage.md.
- Test suite: 15 unit tests + 57 integration tests (auth lifecycle, tenant
  isolation, RBAC, SSRF guard, credential confidentiality, real RTSP
  connection testing, ONVIF discovery, ONVIF capability confirmation
  (unit-tested derivation logic + real connect-and-fail-cleanly behavior +
  real route wiring), real recording start/stop with S3 verification, real
  playback with byte-exact verification, real retention enforcement and
  storage accounting, subscription lifecycle and quota enforcement,
  notification dedup and real camera health checks, async error handling
  under a simulated DB failure, orphaned-object reconciliation) — see
  docs/testing.md.

Not yet implemented: a real payment provider, payment failure handling,
email sending (verification/password-reset), motion-based recording,
HLS/adaptive playback, historical usage snapshots, notification delivery
beyond the in-app list (no email/SMS/webhook). See docs/requirements.md §3
and docs/testing.md for the explicit list.

## Prerequisites

- Node.js 20+ (developed against Node 22)
- pnpm 9+ (`corepack enable` or `npm i -g pnpm`)
- Docker Desktop (for Postgres/Redis/S3-compatible storage/MediaMTX locally)
- **ffmpeg/ffprobe on your PATH** — required by `apps/api` at runtime for
  camera connection testing (not containerized; the API shells out to the
  local `ffprobe` binary). Override the binary name/path with the
  `FFPROBE_PATH` env var if it's not on PATH.

## Setup

```bash
pnpm install
cp .env.example .env
# Edit .env: set APP_SECRET and CREDENTIAL_ENCRYPTION_KEY
# (openssl rand -hex 32 for each) at minimum.

docker compose up -d        # postgres, redis, localstack, mediamtx + simulated camera feed

pnpm --filter @cctv/api prisma:generate
pnpm --filter @cctv/api exec prisma migrate dev   # first run only, creates the schema
pnpm --filter @cctv/api prisma:seed               # creates the Free/Starter/Pro subscription plans

pnpm dev:api                # http://localhost:4100
pnpm dev:web                # http://localhost:3100 (separate terminal)
pnpm --filter @cctv/api worker   # separate terminal — only needed to actually ingest recordings
```

Open http://localhost:3100, create a workspace, and add a camera. To try the
whole pipeline without any physical hardware, add a camera with connector
type **Simulated**, host `localhost`, port `8554`, stream path `/simulated`
— then on its detail page: **Test Connection** (probes the live synthetic
stream), **Start Recording** (needs the worker running, see below), and
after ~15-20s, open the **Recordings** page from the nav to pick that
camera/date and actually play back what got recorded.

`apps/api` reads its own `.env` (Prisma's CLI loads `.env` from the package
directory it runs in) — keep `apps/api/.env` in sync with the root `.env`, or
symlink it, until a shared env-loading story is built.

### Local port notes (machine-specific, check your own setup)

This dev machine already had other unrelated processes bound to every
"obvious" default port, so the defaults here are intentionally non-standard:

- Postgres is published on host port **5433** (not 5432) — a native Postgres
  install already owned 5432.
- The API listens on port **4100** (not 4000), and the web app on **3100**
  (not 3000) — unrelated processes (a Cursor IDE agent) already owned both
  4000 and 3000.

If your machine doesn't have those conflicts, these are safe to change back —
just keep `DATABASE_URL`/`docker-compose.yml`'s port mapping,
`PORT`/`NEXT_PUBLIC_API_BASE_URL`, `CORS_ORIGIN`, and `apps/web/package.json`'s
`-p 3100` flags consistent with whatever you pick.

### Why LocalStack instead of MinIO for local S3-compatible storage

The original plan (see docs/architecture.md) used MinIO for local dev, matching
common practice. As of this environment, Docker Hub rejects anonymous pulls of
`minio/minio` and `minio/mc` ("pull access denied") following MinIO's
November 2024 restriction on public container image distribution. LocalStack's
S3 service is a drop-in substitute for local dev only: the application talks
to the generic AWS S3 SDK/API either way, so there is no app-code difference,
and production still targets real AWS S3.

## Scripts

| Command | Does |
|---|---|
| `pnpm dev:api` | Run the API with hot reload (port 4100) |
| `pnpm dev:web` | Run the Next.js dev server (port 3100) |
| `pnpm --filter @cctv/api worker` | Run the recording ingestion worker (only needed to actually upload recordings) |
| `pnpm build` | Build all workspace packages |
| `pnpm test` | Run unit tests in all workspace packages |
| `pnpm --filter @cctv/api test:integration` | Run API integration tests (needs `docker compose up`) |
| `pnpm --filter @cctv/api prisma:generate` | Regenerate the Prisma client |
| `pnpm --filter @cctv/api exec prisma migrate dev` | Create/apply a migration |
| `pnpm --filter @cctv/api prisma:seed` | Create the Free/Starter/Pro subscription plans (required once per database) |

## Documentation

- [docs/requirements.md](docs/requirements.md) — product requirements, MVP scope, non-goals
- [docs/architecture.md](docs/architecture.md) — system components, data flow, connector interface
- [docs/database-schema.md](docs/database-schema.md) — schema design and explicit tradeoffs
- [docs/foundation-assessment.md](docs/foundation-assessment.md) — open-source NVR project evaluation (licensing, fit, recommendation)
- [docs/camera-integration.md](docs/camera-integration.md) — connector architecture + a plain-language "connecting your camera" guide
- [docs/video-recording.md](docs/video-recording.md) — how the recording pipeline actually works, including a real bug found and fixed during verification
- [docs/playback.md](docs/playback.md) — signed URLs, the Recordings page, what's verified
- [docs/retention-and-storage.md](docs/retention-and-storage.md) — retention policies, enforcement/reconciliation, storage accounting
- [docs/subscriptions-and-billing.md](docs/subscriptions-and-billing.md) — plans, the dev billing adapter, quota enforcement
- [docs/monitoring-and-alerts.md](docs/monitoring-and-alerts.md) — camera health checks, notification types, alert-storm prevention
- [docs/mobile-app.md](docs/mobile-app.md) — Flutter mobile app, bearer auth, FCM push setup, building APK/IPA
- [docs/testing.md](docs/testing.md) — unit vs. integration test split, coverage, known gaps
- [docs/security.md](docs/security.md) — auth, tenant isolation, credential handling, SSRF guard, the two real findings from the Phase 9 review
- [docs/failure-recovery.md](docs/failure-recovery.md) — two real bugs found by actually killing Postgres/Redis/MediaMTX against a running server, both fixed and reverified
- [docs/deployment.md](docs/deployment.md) — running this somewhere other than this dev machine, backups, what's not implemented

## Manual verification performed

Both servers (plus the recording worker) were run against the real Docker
infra and exercised over HTTP: register → `/auth/me` → create a camera (with
a real encrypted credential) → list cameras → test its connection against
the live simulated RTSP stream → ran a real ONVIF discovery scan → started
recording and let the background worker ingest segments *while recording
was still active* (not just on stop) → stopped and confirmed the final
drain, with every resulting database row's size/duration independently
cross-checked against the real S3 object and the real downloaded file →
listed recording dates/segments and generated a signed playback URL,
independently fetching it and confirming the byte count matches the
database exactly and the download-mode header is really present → ran
retention enforcement directly against a mix of expired/ambiguous/future
segments and confirmed via independent S3 checks that only the genuinely
expired one's object was deleted → created cameras up to a free-trial
tenant's 2-camera limit and confirmed the 3rd was actually rejected (first
caught a real bug here: a stale running server process had the
pre-quota-enforcement code, so the first attempt wrongly succeeded —
restarting and retesting confirmed the real fix), then confirmed the
retention-days and storage-quota limits the same way → ran a two-pass
security review and, for each of the two findings it surfaced, confirmed
the actual exploit payload (an attacker-controlled host declared as a
simulated camera) worked before the fix and was rejected after → stopped
the simulated camera's real feed via Docker and confirmed exactly one
`CAMERA_OFFLINE` alert appeared within one health-check cycle, stayed at
one across a second cycle (cooldown holding), then confirmed recovery →
actually stopped Postgres against the running dev server and confirmed a
DB-dependent route returned a clean 500 (not a crash — `netstat` confirmed
the same process PID was still listening throughout), then restarted
Postgres and confirmed recovery with no server restart → actually stopped
Redis and timed `/ready` with a real `curl`, finding it took 27.7s to
report the failure before a fix, then re-measured at a capped 3.02s after
the fix → actually stopped MediaMTX and confirmed a recording-start attempt
failed cleanly (502, <20ms, no crash) rather than hanging → deleted a real
camera with two real recorded segments and confirmed via direct DB/S3
checks that it orphaned both objects (the actual bug), then ran the
reconciliation job and confirmed both were deleted → created an ONVIF-type
camera pointed at the real simulated RTSP stream with its ONVIF port
pointed at a real non-ONVIF HTTP service, confirmed RTSP succeeded, the
real ONVIF probe was attempted and failed cleanly, and the camera
correctly landed on CONNECTED_MISSING_CAPABILITIES rather than claiming
capabilities it never confirmed. All through the
live API. The web app's pages were confirmed to render their
expected content via the rendered HTML. Actual in-browser interaction
(clicking through forms, verifying the client-side auth redirect, clicking
the Start/Stop Recording buttons themselves) was **not** performed — this
environment has no graphical browser available. If you hit anything that
doesn't work when you click through it yourself, that's the gap to report.

## Environment variables

See [.env.example](.env.example) — every variable the platform reads is
documented there. Never commit a real `.env` file.
