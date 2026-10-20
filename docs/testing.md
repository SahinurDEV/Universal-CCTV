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

## What's not covered yet (tracked, not hidden)

- Camera connectors (RTSP/ONVIF/simulated), capability detection, recording
  pipeline, playback, retention jobs, billing — none of this is implemented
  yet (see docs/requirements.md), so there's nothing to test.
- Password reset and email verification sending are not implemented (no
  email provider configured) — see docs/architecture.md §7.
- No Playwright/browser-level tests yet for the web app — the dashboard is
  new in this phase; frontend test coverage is tracked as a follow-up, not
  silently skipped.
- Tests requiring physical camera hardware: none exist yet because no camera
  connector exists yet. When Phase 4 lands, any test that can only run
  against a real physical camera (as opposed to the simulated connector or a
  LAN-reachable test stream) will be explicitly marked and documented here,
  per the project's rule against claiming untested camera compatibility.

## Manual verification performed (not automated, but actually run)

Beyond the automated suites above, these were manually exercised against the
real local stack while building Phase 1-3 (see conversation history / commit
messages for exact commands):
- `docker compose up -d` brings up Postgres/Redis/LocalStack; `/ready`
  returns `{"status":"ok","checks":{"database":"ok","redis":"ok"}}` against
  them, not just against mocks.
- `prisma migrate dev` applied cleanly against the real Postgres container
  twice (initial schema, then the `Session` table addition).
