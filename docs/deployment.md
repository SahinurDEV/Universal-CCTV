# Deployment and Backup

This describes how to run this platform somewhere other than this dev
machine, and how to back it up. **This project has only ever been run
locally** — nothing here has been exercised against a real cloud
deployment. Treat this as a documented starting point, not a verified
runbook, until it's actually been through a real deploy.

## What has to run

| Process | What it is | Notes |
|---|---|---|
| `apps/api` | Express API | Stateless — can run multiple instances behind a load balancer |
| `apps/api` worker | `pnpm --filter @cctv/api worker` | **Must run as a separate process** from the API. Single-instance only right now — running two workers would double-poll the same recording jobs (see docs/video-recording.md's "not implemented: multi-worker coordination") |
| `apps/web` | Next.js dashboard | Stateless |
| PostgreSQL | Primary datastore | Not containerized in production — use a managed instance (RDS, Cloud SQL, etc.) |
| Redis | BullMQ queue backing | Not containerized in production — use a managed instance |
| MediaMTX | RTSP ingestion + recording | See the production hardening note below — the current config is dev-only |
| S3 (or compatible) | Recording storage | Real AWS S3 in production, not LocalStack |

## Required setup steps, in order

```bash
# 1. Install dependencies
pnpm install

# 2. Configure environment — see .env.example for every variable.
# At minimum, for a real deployment (not local dev):
#   - DATABASE_URL: real managed Postgres
#   - REDIS_URL: real managed Redis
#   - APP_SECRET, CREDENTIAL_ENCRYPTION_KEY: generate fresh with `openssl rand -hex 32`
#     each — NEVER reuse the dev values committed anywhere in this repo's history
#   - STORAGE_*: real AWS S3 bucket + IAM credentials (least-privilege — see below)
#   - MEDIAMTX_API_URL / MEDIAMTX_PLAYBACK_URL: wherever MediaMTX actually runs
#   - CORS_ORIGIN: the real dashboard domain, not localhost
#   - NODE_ENV=production

# 3. Apply migrations (NOT `prisma migrate dev` — that's dev-only and can
#    prompt interactively / reset data). Use the non-interactive deploy command:
pnpm --filter @cctv/api exec prisma migrate deploy

# 4. Seed subscription plans (idempotent — safe to re-run)
pnpm --filter @cctv/api prisma:seed

# 5. Build and start
pnpm build
pnpm --filter @cctv/api start      # API
pnpm --filter @cctv/api worker     # worker, separate process/host
pnpm --filter @cctv/web start      # web (after `pnpm --filter @cctv/web build`)
```

A reverse proxy (nginx, a cloud load balancer, etc.) terminating TLS in
front of `apps/api` and `apps/web` is assumed but not configured here —
nothing in this repo sets up TLS termination.

## Required IAM permissions for the S3 bucket

Least-privilege, per docs/security.md's existing principle — the API/worker
only ever need:
- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` on
  `arn:aws:s3:::<bucket>/tenants/*`
- No `s3:ListBucket`, no account-wide S3 permissions, no access to any
  other bucket.

## MediaMTX in production — this needs real hardening before deployment

`infra/mediamtx/mediamtx.yml` currently grants unauthenticated access to
MediaMTX's config and playback APIs (`action: api` / `action: playback` for
`user: any`) — explicitly documented there as **local-dev-only**, acceptable
only because the ports aren't exposed beyond this dev machine. Before
deploying anywhere reachable by more than this machine:
- Set real `authInternalUsers` credentials for the `api` and `playback`
  actions (see MediaMTX's own docs for the config shape — it's the same
  `authInternalUsers` block, just with a real `pass` instead of granting
  `any`).
- Update `apps/api`'s `MEDIAMTX_API_URL`/`MEDIAMTX_PLAYBACK_URL` calls (
  `connectors/mediamtx-client.ts`, `lib/storage.ts`'s presigned-URL
  consumers) to send that credential — not implemented yet, since local dev
  never needed it.
- Put MediaMTX's ports behind network-level access control (security group /
  firewall) so only `apps/api`/the worker can reach them — they should never
  be internet-facing.

## Backup procedures

**PostgreSQL**: this is the single most important thing to back up — it
holds every tenant, camera, credential reference, and recording's metadata
(the metadata, not the video itself — see docs/database-schema.md). Use
your managed Postgres provider's automated backup/point-in-time-recovery
feature. Nothing in this codebase implements an application-level backup —
rely on the database layer for this.

**S3 recordings**: the actual video bytes. Enable S3 versioning and/or
cross-region replication at the bucket level if recordings need protection
against accidental deletion beyond what retention enforcement already does
intentionally (docs/retention-and-storage.md) — nothing in the application
code backs these up separately.

**What's NOT backed up by anything here**: Redis (BullMQ queue state) is
treated as ephemeral — losing it loses in-flight/scheduled job state but
not any durable data (recording jobs resume being polled once the worker
restarts and finds `RUNNING` rows in Postgres again). MediaMTX's own disk
(not-yet-ingested segments) has no backup — if MediaMTX's volume is lost
before the worker ingests a segment, that footage is gone. This is a real
gap worth knowing about, not a design that was deliberately accepted as
"fine to lose."

## Resource consumption

Measured against this project's own real, lightly-used dev stack (not
estimated) — one tenant, one actively-recording simulated camera, idle
otherwise:

| Process | Resident memory | Notes |
|---|---|---|
| API (`node dist/index.js` equivalent) | ~96-100MB RSS | Measured via the OS process table, not `process.memoryUsage()` from inside (which under-counts). Dev-mode (`tsx watch`) adds a separate wrapper process on top of this for the file watcher; a production build (`pnpm build && node dist/index.js`) doesn't have that second process. |
| Worker (`worker.ts`) | ~67-97MB RSS | Same single Node process whether 1 camera or several are being recorded — the BullMQ job loop and Prisma client don't scale per-camera in memory, only the work each job tick does. |
| Web (`next start`) | ~56MB RSS | Production Next.js server process. |

None of these grow over time in normal operation in this testing — no
per-request cache, no unbounded array, no listener added without a matching
removal. The Prisma client, Redis connection, and BullMQ `Queue`/`Worker`
instances are each a single long-lived singleton per process (see
`apps/api/src/lib/db.ts`, `lib/redis.ts`), not re-created per request.

**One real optimization made and verified during this pass**: the
camera-health-check job (`recording/health.ts`'s `checkCameraHealth()`)
originally called MediaMTX's per-path status endpoint once for every
actively-recording camera — N HTTP requests to MediaMTX every 30 seconds,
scaling linearly with camera count for no reason. MediaMTX's own
`GET /v3/paths/list` returns every path's status in a single response
(confirmed against the real running MediaMTX instance, not assumed from
docs — see `apps/api/src/connectors/mediamtx-client.ts`'s
`listAllPathStatuses`). Switched the health check to one bulk call
regardless of camera count. Re-verified for real after the change: the
healthy-camera integration test still passes, and a live offline-detection
cycle (stopping the simulated camera's feed, waiting for the 30s health
check, confirming exactly one `CAMERA_OFFLINE` notification, confirming the
cooldown holds on a second cycle, then confirming recovery) was repeated
end-to-end and behaves identically to before the change — see
docs/failure-recovery.md and docs/monitoring-and-alerts.md for the same
verification pattern applied elsewhere in this project.

**Tuning knobs for a production deployment, not changed here because they
trade dev-loop observability for efficiency** (see `worker.ts`'s own
comments): the 15s recording-ingestion poll and the 30s health-check
interval are both deliberately short so changes are observable without an
artificial wait during development. A production deployment recording
long-duration segments has no real need for sub-minute polling; loosening
both intervals (e.g. to 60s/120s) would cut MediaMTX/DB round trips further
with no loss of correctness, at the cost of alerts/ingestion lagging by
up to that interval.

**Database connections**: Prisma's default pool size
(`num_physical_cpus * 2 + 1`) is per *process* — with the API and worker as
two separate processes, that's two independent pools against the same
Postgres instance. Fine at this scale; a multi-instance horizontal
deployment (see the scaling risk in docs/architecture.md §7) should set an
explicit `connection_limit` in `DATABASE_URL` sized for the total instance
count, or sit behind PgBouncer, rather than letting each instance default
independently.

## What's not implemented (tracked, not hidden)

- No CI/CD pipeline — building/testing/deploying is manual (the commands
  above).
- No infrastructure-as-code (Terraform/CloudFormation/etc.) — nothing here
  provisions the managed Postgres/Redis/S3 resources this deployment guide
  assumes exist already.
- No horizontal-scaling guidance for the worker beyond "don't run two" —
  real multi-worker support needs job locking/sharding, not built
  (docs/video-recording.md).
- No health-check/readiness wiring for a container orchestrator beyond the
  existing `/health` and `/ready` HTTP endpoints — no Kubernetes manifests,
  no ECS task definitions, etc.
