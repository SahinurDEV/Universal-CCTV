# Universal CCTV Cloud Platform

Manufacturer-agnostic cloud CCTV recording and management — connect cameras from
different brands, record to your own cloud storage, and manage playback from one
dashboard, without being locked into any single manufacturer's subscription.

**Status: foundation + auth/tenancy/camera-registration are real and tested.**
Camera connectivity (actually dialing a camera), capability detection, the
recording pipeline, and playback are **not** implemented yet. See
docs/requirements.md for MVP scope and "definition of done."

## What's implemented so far

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
  metadata hosts at creation time. No connector actually dials a camera yet —
  this just stores config; the API and UI both say so explicitly.
- **Dashboard**: login/register pages, auth-gated layout with the full nav
  (Overview, Cameras, Live View, Recordings, Storage, Locations, Alerts,
  Integrations, Subscription, Settings), a working Cameras list/add/detail
  flow against the real API, and honestly-labeled "not implemented yet" pages
  for every section that isn't built (no fake buttons).
- `/health` and `/ready` endpoints, verified against real Postgres/Redis.
- Local dev infra via Docker Compose: Postgres, Redis, S3-compatible storage
  (LocalStack — see note below).
- Test suite: 3 unit tests + 15 integration tests (auth lifecycle, tenant
  isolation, RBAC, SSRF guard, credential confidentiality) — see
  docs/testing.md for the unit/integration split and what each covers.

Not yet implemented: camera connectors that actually connect, capability
detection, the recording pipeline, playback, retention jobs, billing, email
sending (verification/password-reset). See docs/requirements.md §3 and
docs/testing.md for the explicit list.

## Prerequisites

- Node.js 20+ (developed against Node 22)
- pnpm 9+ (`corepack enable` or `npm i -g pnpm`)
- Docker Desktop (for Postgres/Redis/S3-compatible storage locally)

## Setup

```bash
pnpm install
cp .env.example .env
# Edit .env: set APP_SECRET and CREDENTIAL_ENCRYPTION_KEY
# (openssl rand -hex 32 for each) at minimum.

docker compose up -d        # postgres, redis, localstack (S3-compatible)

pnpm --filter @cctv/api prisma:generate
pnpm --filter @cctv/api exec prisma migrate dev   # first run only, creates the schema

pnpm dev:api                # http://localhost:4100
pnpm dev:web                # http://localhost:3100 (separate terminal)
```

Open http://localhost:3100, create a workspace, and add a camera — the whole
flow (register → login → create camera → see it in the list → tenant
isolation) runs against the real API and database.

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
| `pnpm build` | Build all workspace packages |
| `pnpm test` | Run unit tests in all workspace packages |
| `pnpm --filter @cctv/api test:integration` | Run API integration tests (needs `docker compose up`) |
| `pnpm --filter @cctv/api prisma:generate` | Regenerate the Prisma client |
| `pnpm --filter @cctv/api exec prisma migrate dev` | Create/apply a migration |

## Documentation

- [docs/requirements.md](docs/requirements.md) — product requirements, MVP scope, non-goals
- [docs/architecture.md](docs/architecture.md) — system components, data flow, connector interface
- [docs/database-schema.md](docs/database-schema.md) — schema design and explicit tradeoffs
- [docs/foundation-assessment.md](docs/foundation-assessment.md) — open-source NVR project evaluation (licensing, fit, recommendation)
- [docs/testing.md](docs/testing.md) — unit vs. integration test split, coverage, known gaps
- [docs/security.md](docs/security.md) — auth, tenant isolation, credential handling, SSRF guard, known gaps

## Manual verification performed

Both servers were started against the real Docker infra and exercised over
HTTP: register → `/auth/me` → create a camera (with a real encrypted
credential) → list cameras, all through the live API; the web app's pages
were confirmed to render their expected content via the rendered HTML. Actual
in-browser interaction (clicking through forms, verifying the client-side
auth redirect) was **not** performed — this environment has no graphical
browser available. If you hit anything that doesn't work when you click
through it yourself, that's the gap to report.

## Environment variables

See [.env.example](.env.example) — every variable the platform reads is
documented there. Never commit a real `.env` file.
