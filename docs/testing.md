# Testing

## Two tiers, by design

**Unit tests** (`apps/api`: `pnpm test`, config `vitest.config.ts`)
- Pattern: `src/**/*.test.ts` (explicitly excludes `*.integration.test.ts`).
- `vitest.setup.ts` injects fake-but-valid-shaped env vars (an unreachable
  Redis URL, a placeholder DB URL) so these never need real infra and run in
  under a couple of seconds. `/ready`'s own test asserts it degrades
  gracefully (200 or 503, both dependency checks present) rather than
  asserting a specific outcome, since the dependencies are intentionally
  unreachable here.
- Run these on every change; no `docker compose up` required.

**Integration tests** (`pnpm test:integration`, config
`vitest.integration.config.ts`)
- Pattern: `src/**/*.integration.test.ts`.
- `vitest.integration.setup.ts` loads the real `apps/api/.env` and these tests
  hit the actual Postgres/Redis/LocalStack containers from
  `docker compose up`. **Requires the containers to be running** — there is
  no mock/in-memory substitute here on purpose: auth, tenant isolation, and
  RBAC are exactly the kind of logic that passes against a mock and still
  breaks in production, so they're tested against the real database.
- Each test file creates its own tenants/users with randomized emails and
  deletes them in `afterAll` (relying on the schema's `onDelete: Cascade` to
  clean up memberships/sessions/cameras/audit logs transitively). Tests run
  with `fileParallelism: false` since they share one real database.
- **Known gap in the test suite itself**: `afterAll` only deletes DB rows —
  it does not delete the S3 objects the recording tests upload to
  LocalStack. Running `test:integration` repeatedly accumulates objects in
  the `cctv-recordings` bucket (each one now a real orphan, since its DB
  row was just cascaded away — exactly the scenario
  `recording/reconciliation.ts` exists to clean up; a running worker will
  actually remove these once they pass the 15-minute age threshold, but
  the test suite itself doesn't wait for or rely on that). If you need a
  clean bucket immediately, `docker compose down -v` or manually `aws s3
  rm --recursive` against it.

Run both locally before considering a change to `apps/api` done:

```bash
pnpm --filter @cctv/api test
docker compose up -d   # if not already running
pnpm --filter @cctv/api test:integration
```

## What's covered today

- **Auth**: register (incl. duplicate-email and short-password rejection),
  login (incl. wrong password and nonexistent-email cases returning an
  identical response shape to avoid account enumeration), logout, session
  expiry via `/auth/me` returning 401 post-logout.
- **Tenant isolation**: a second tenant's session gets 404 (not 403) reading,
  updating, or deleting another tenant's camera — verified against a real
  cross-tenant attempt, not just "the query includes a tenantId filter."
- **RBAC**: a `VIEWER`-role member can list/read cameras but gets 403
  attempting to create one.
- **SSRF-lite guard**: camera creation rejects a loopback host (`127.0.0.1`)
  and the cloud metadata address (`169.254.169.254`) before any row is
  written.
- **Credential confidentiality**: the camera-create response is asserted to
  never contain the plaintext credential string anywhere in the JSON body.
- **Health/readiness**: `/health` always 200; `/ready` reports per-dependency
  status and is exercised against both unreachable (unit test) and real
  (manually, see below) backing services.
- **RTSP connection testing**: `POST /cameras/:id/test-connection` is
  exercised against a *real, continuously-live* RTSP stream — MediaMTX +
  an ffmpeg-fed synthetic test pattern in `docker-compose.yml` (see
  docs/camera-integration.md) — not a mock. Covered: success (confirms real
  video/audio stream metadata, updates the capability record to
  `FULLY_SUPPORTED`), a real failure case (wrong stream path →
  `UNSUPPORTED`, honest error message with the RTSP URL/credential scrubbed
  out), and tenant isolation (another tenant's camera 404s, not 403).
- **ONVIF LAN discovery**: `POST /cameras/discover` is exercised for real —
  it runs an actual WS-Discovery UDP probe and is asserted to return a
  well-formed result and require auth. It cannot be asserted to *find*
  anything in this environment (there's no real ONVIF camera on this
  network) — see the next section and docs/camera-integration.md for why
  that's an inherent LAN-only limitation, not a gap in the test.
- Unit test for the RTSP→capability mapping logic
  (`capabilitiesFromRtspProbe`): confirms it never sets ONVIF-only
  capabilities (PTZ, motion events, etc.) from a plain RTSP probe.
- **ONVIF capability confirmation** (`onvif-capabilities.test.ts` +
  `onvif-capabilities.integration.test.ts`): unit tests the pure
  `deriveOnvifCapabilities` mapping against synthetic ONVIF response
  shapes (PTZ claimed-but-unused by any profile correctly stays
  unconfirmed; Events/Imaging/firmware signals derived independently of
  PTZ). Integration-tests `probeOnvifCapabilities` making a real network
  connection that fails cleanly and promptly (both asserted under 10s, not
  hanging to an internal timeout) against a real non-ONVIF local HTTP
  server and a closed port. A further test in `cameras.integration.test.ts`
  exercises the real route wiring: an ONVIF-type camera pointed at the live
  simulated RTSP stream (confirms real) with its ONVIF port pointed at a
  real non-ONVIF service correctly lands on `CONNECTED_MISSING_CAPABILITIES`,
  not `FULLY_SUPPORTED`. See docs/camera-integration.md for the explicit
  caveat: none of this has been run against a real physical ONVIF camera.
- **Recording pipeline** (`recording.integration.test.ts`): starts a real
  recording against the live simulated RTSP stream, waits for a real
  segment, stops it, and asserts — independently, via a direct S3
  `HeadObjectCommand`, not just "the DB row says so" — that the object
  actually exists, with a size consistent with real video (not an empty or
  near-empty file). Also covers: duplicate-start rejection (409), stopping
  with nothing active (404), and tenant isolation on both start and stop.
  Beyond the automated test, this was manually verified further — see
  docs/video-recording.md for a real duration-accuracy bug that manual
  testing caught and the fix that was verified afterward (bytes-per-second
  consistency across segments in the same recording).
- **Playback** (`playback.integration.test.ts`): against a real recorded
  segment — dates listing, segment listing (asserts the response never
  contains the internal S3 key structure), a generated signed URL
  independently fetched and confirmed byte-identical in size to the DB's
  `fileSizeBytes` with `Content-Type: video/mp4`, the download-mode
  `Content-Disposition` header confirmed present on the real response, and
  tenant isolation on both listing and URL generation. See
  docs/playback.md.
- **Retention and storage** (`retention.integration.test.ts`): default
  policy creation on registration, cross-tenant policy-assignment rejection,
  a real recorded segment's `retentionExpiresAt` matching its assigned
  policy exactly, `enforceRetention()` run directly against a mix of an
  actually-expired segment, a no-policy segment, and a not-yet-due
  segment — with the actually-expired one's S3 object independently
  confirmed gone via `HeadObjectCommand` and the other two confirmed still
  present. Storage usage tested against the real DB sum (byte-exact) and
  for tenant isolation (a second tenant sees zero). See
  docs/retention-and-storage.md.
- **Subscriptions and quota enforcement** (`subscription.integration.test.ts`):
  public plan catalog, auto-created trial subscription on registration,
  a real plan change (status/limits actually update) and cancellation,
  rejection of an unknown plan key, and all three quota checks exercised
  against a real server — camera limit (2 cameras succeed, a 3rd is
  rejected), retention limit (a too-long policy rejected, a within-limit
  one accepted on the same camera), and storage quota (a real
  over-quota-sized segment row blocks starting a new recording). See
  docs/subscriptions-and-billing.md.
- **Notifications and camera health** (`notifications.integration.test.ts`):
  `notifyOnce`'s dedup logic (identical condition suppressed within the
  cooldown, a different target or type is not suppressed), the
  notifications API (tenant-scoped listing, mark-read, tenant isolation on
  mark-read returning 404 not 403), and `checkCameraHealth()` run against a
  real actively-recording camera confirming zero false-positive
  notifications while healthy. Beyond the automated test, the actual
  offline-detection path was manually verified by stopping the simulated
  camera's real feed and confirming a real `CAMERA_OFFLINE` notification
  appeared within one health-check cycle and did not duplicate on the
  next — see docs/monitoring-and-alerts.md.
- **Failure recovery** (`app.test.ts`'s "async route error handling"):
  in this suite's fake-env setup the DB URL is unreachable, so `GET
  /subscription/plans` throws for real on every run; asserts the app
  answers 500 (not a crash/hang) and keeps serving the next request. This
  is the regression test for a real bug — a single DB/Redis blip used to
  crash the entire process, confirmed by actually stopping Postgres against
  a running dev server, not assumed. The dedicated pass that found and
  fixed this — including a second real bug (`/ready` taking 27.7s to
  detect a dropped Redis connection) — is in docs/failure-recovery.md and
  was verified manually against the real containers, not just this unit
  test.
- **Resource-consumption optimization re-verification**: after switching
  `checkCameraHealth()` from one MediaMTX HTTP call per camera to one bulk
  call total, the automated healthy-camera test above was re-run and still
  passes, and the live offline-detection cycle (stop the simulated feed,
  wait for a real health-check tick, confirm exactly one notification,
  confirm the cooldown holds on a second tick, confirm recovery) was
  repeated manually end-to-end and behaves identically to before the
  change. See docs/deployment.md's "Resource consumption" section.
- **Storage reconciliation** (`reconciliation.integration.test.ts`):
  `reconcileOrphanedObjects()` against the real bucket — a real orphan
  (no DB row) gets deleted, a real owned object (matching row) is left
  alone, and an orphan younger than the age threshold is left alone too
  (the in-flight-upload safety window). Beyond the automated test: deleted
  a real camera with two real recorded segments through the live API,
  confirmed via direct queries that the DB rows cascaded away but both S3
  objects remained (reproducing the actual bug — camera deletion orphans
  100% of its footage, not occasionally), then ran the real reconciliation
  function and confirmed via `HeadObjectCommand` that both were deleted.
  See docs/retention-and-storage.md.
- **Security review** (two-pass, per the `security-review` skill's own
  methodology — identify, then independently verify each finding): found
  and confirmed two real vulnerabilities (SSRF guard bypass via
  `connectorType: "SIMULATED"`; MediaMTX's dev-only unauthenticated API
  bound to all interfaces instead of loopback). Both fixed and verified:
  the exact exploit payload was tried against the fixed code and rejected,
  and a regression test exists for the SSRF bypass specifically
  (`cameras.integration.test.ts`). See docs/security.md.

## What's not covered yet (tracked, not hidden)

- A real payment provider, payment failure handling, historical usage
  snapshots — see docs/subscriptions-and-billing.md.
- Notification delivery beyond the in-app list (no email/SMS/webhook), and
  per-frame camera health metrics beyond offline/stopped detection — see
  docs/monitoring-and-alerts.md.
- HLS/adaptive playback and cross-segment scrubbing — MVP is direct MP4
  segment playback with Previous/Next between segments, per
  docs/playback.md.
- Motion-based/event-triggered recording, recording health/gap detection,
  and multi-worker coordination for the ingestion worker (it's a single
  process today) — see docs/video-recording.md's "not implemented" list.
- Password reset and email verification sending are not implemented (no
  email provider configured) — see docs/architecture.md §7.
- No Playwright/browser-level tests yet for the web app — frontend test
  coverage is tracked as a follow-up, not silently skipped.
- **Tests against a real physical camera**: none exist. Every "real"
  connectivity test here runs against the synthetic MediaMTX stream or a
  WS-Discovery probe with nothing to find — genuine hardware compatibility
  (a specific manufacturer/model/firmware) has not been verified and must
  not be claimed until it has been, per the project's rule against claiming
  untested camera compatibility. If you test against a real camera, record
  the exact model/firmware here.

## Manual verification performed (not automated, but actually run)

Beyond the automated suites above, these were manually exercised against the
real local stack while building Phase 1-3 (see conversation history / commit
messages for exact commands):
- `docker compose up -d` brings up Postgres/Redis/LocalStack; `/ready`
  returns `{"status":"ok","checks":{"database":"ok","redis":"ok"}}` against
  them, not just against mocks.
- `prisma migrate dev` applied cleanly against the real Postgres container
  twice (initial schema, then the `Session` table addition).

## Added in feature/complete-platform

- `src/lib/network-guard.test.ts` (unit): SSRF guard — loopback/metadata/
  link-local, numeric IP spellings, IPv4-mapped IPv6, URL-injection hosts,
  DNS-resolved checks, SIMULATED pinning.
- `src/routes/platform.integration.test.ts`: Locations CRUD + camera
  assignment + tenant isolation + RBAC; account settings (profile, password
  change revoking other sessions, case-insensitive login, sessions, alert
  preferences); webhooks (SSRF rejection, secret shown once, real signed
  delivery to a LAN receiver, event filtering, tenant isolation); **live
  view against the real MediaMTX HLS output** (auth, tenant isolation, path
  traversal, real playlist + video segment for a VIEWER); CSRF Origin check.
- `cameras.integration.test.ts`: connect-time SSRF check blocks a stored
  loopback host for test-connection, recording start and live start.

## Added in feature/gaps-and-features

- `src/lib/motion.test.ts` (unit): sensitivity→threshold mapping (range,
  monotonic, clamping), ffmpeg `scene_score` parsing, argv-only ffmpeg args.
- `src/lib/invites.test.ts` (unit): token generation/hashing, role rules
  (who may grant/manage which role), invite state.
- `src/routes/motion.integration.test.ts`: motion settings API (defaults,
  validation, tenant isolation 404, VIEWER 403), worker pass with an
  injected sampler → MotionEvent rows + exactly one MOTION_DETECTED alert
  per cooldown, below-threshold no-op, error recorded, disabled skipped.
- `src/routes/invites.integration.test.ts`: create → preview → accept with
  new account (single use, hash-only storage), existing account must be
  signed in as the invited email, RBAC (viewer/operator 403, admin can't
  invite/manage owners), revoke/expire/re-invite, already-member 409,
  last-owner protection, member removal cuts access, CSRF Origin check.

**Motion smoke test (real ffmpeg, manual, performed):** with
`scripts/local-services.sh` running, publish a second, *static* fake camera:

```bash
ffmpeg -re -f lavfi -i "smptebars=size=640x360:rate=15" -c:v libx264 \
  -preset ultrafast -tune zerolatency -g 30 -f rtsp rtsp://127.0.0.1:8554/static
```

Add two SIMULATED cameras (host `localhost`, port 8554, path `simulated`
and `static`), turn motion on at sensitivity 60, and start the worker
(`MOTION_CHECK_INTERVAL_SECONDS=10 pnpm --filter @cctv/api worker`). Result:
the moving test pattern produced a MotionEvent every check (peak scene
score ≈0.022 vs threshold 0.0129) and one MOTION_DETECTED alert; the static
camera produced none (score ≈0.000001).

**docker-compose.yml:** Docker is not installed on the dev box, so the
stack was *not* run. It was validated with the standalone `docker compose`
v2.40 CLI (`docker compose config -q`), every image tag was confirmed to
exist on Docker Hub, and ports/env/healthchecks were checked against the
app config.

Running without Docker: see docs/local-testing.md (§2B, `scripts/local-services.sh`).
