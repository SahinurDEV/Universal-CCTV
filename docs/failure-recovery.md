# Failure Recovery

Per the master plan's Phase 9 scope ("test failure recovery"), this is a
dedicated pass — not incidental coverage — that actually kills each real
dependency (Postgres, Redis, MediaMTX) against a running dev server and
records what really happened, including two real bugs found and fixed as a
direct result.

## Method

For each dependency: start the API dev server for real, hit it successfully
once, `docker compose stop <service>`, hit it again (and keep hitting it),
observe the actual behavior (not assumed behavior), fix anything that wasn't
acceptable, `docker compose start <service>`, and confirm the API recovers
**without a restart** — Prisma/ioredis/BullMQ are all expected to reconnect
on their own once the dependency is back.

## Finding 1 (critical): a DB/Redis blip crashed the entire process

**Before this pass**: stopping Postgres and then hitting any route whose
handler queried the database — e.g. `GET /cameras` — killed the whole API
process outright. Confirmed for real: `netstat` showed the listening port
gone and the process no longer existed, not just one failed request.

**Root cause**: Express 4 does not forward a rejected promise from an
`async` route handler to its error middleware — unlike Express 5. A
rejection inside any of this codebase's ~28 `async (req, res) => {...}`
handlers (none of which had their own try/catch around the DB call) became
an unhandled promise rejection, which crashes the Node process by default.
One tenant's bad luck (a transient DB blip mid-request) took down every
tenant's traffic, not just that one request.

**Fix**: `apps/api/src/middleware/async-handler.ts`'s `asyncHandler()`
wraps every async route handler and both auth middlewares
(`requireAuth`, `requireTenant` in `apps/api/src/middleware/auth.ts`),
forwarding any rejection to `next(err)`. `apps/api/src/app.ts` now has a
final error-handling middleware that logs the error once and responds with
a uniform `{"error":"internal_error"}` / 500 — never a stack trace, never a
hang, never a crash.

**Verified for real, twice** (not just the regression test below):
1. Stopped Postgres against a running dev server → `GET /cameras` and
   `GET /subscription/plans` both returned a clean `500` immediately, and
   `netstat` confirmed the **same PID** was still listening throughout.
2. Restarted Postgres → `/ready` went back to `200`/`"ok"` and `GET
   /cameras` succeeded again, with no server restart — Prisma's own
   connection pool reconnected on its own.

**Automated regression test**: `apps/api/src/app.test.ts`, "async route
error handling" — in the unit-test environment the DB URL is intentionally
unreachable, so `GET /subscription/plans` (no auth, queries Prisma
directly) throws for real on every run; the test asserts a `500` and that
the app still answers a normal request immediately after.

**Defense-in-depth added on top of the real fix**: `apps/api/src/index.ts`
and `apps/api/src/worker.ts` each register `process.on("unhandledRejection")`
(log only — the primary fix above should mean this never fires for a
request-triggered error) and `process.on("uncaughtException")` (log + exit,
so a process manager restarts from a clean state if something truly escapes
every other layer). These are a safety net, not the fix — the asyncHandler
wrapping is what actually matters.

## Finding 2 (moderate): `/ready` was slow to detect a Redis outage

**Before this pass**: with an already-established Redis connection,
stopping the Redis container didn't crash anything, but `/ready` took
**27.7 seconds** (measured with `curl`'s `time_total`, not guessed) to
notice and report `redis: "failed"`. That's `ioredis` genuinely needing
that long to detect the dropped TCP connection in this environment, not an
infinite hang — but it's still far slower than any real load balancer or
Kubernetes readiness-probe timeout (typically 1-5s) would tolerate. A
readiness probe that's too slow to answer is operationally as bad as one
that lies, because the orchestrator will simply treat the timeout itself as
a failure without ever seeing the real status.

**Fix**: `apps/api/src/routes/health.ts`'s `withTimeout()` bounds each
dependency check (database and Redis) to 3 seconds; whichever is slower is
reported as `"failed"` and `/ready` still answers promptly.

**Verified for real**: reproduced the exact slow-detection scenario
(connect once while Redis is up, then stop Redis) against the fixed code —
`/ready` now answers in **3.02 seconds**, capped at the configured timeout
instead of whatever `ioredis` would have taken. A cold-stopped Redis (no
prior connection to detect the drop on) answers in ~40ms, correctly even
faster since there's nothing to time out.

## Finding 3: MediaMTX failures were already handled correctly

Stopping MediaMTX and attempting `POST /cameras/:id/recording/start`
returned a clean `502 {"error":"recording_start_failed"}` in under 20ms, no
crash, no hang — this path already had its own try/catch
(`apps/api/src/routes/recording.ts`) from when it was first built in
Phase 5. No fix needed; included here because it was actually tested, not
assumed safe by analogy with the other two.

## What self-heals without any intervention

Confirmed by letting each stopped container restart and re-hitting the API
with no server/worker restart of its own:
- **Postgres**: Prisma's connection pool reconnects on its own.
- **Redis**: `ioredis` reconnects on its own once `/ready` or a BullMQ
  operation touches it again.
- **MediaMTX**: the `simulated-camera` ffmpeg publisher container itself
  restarts automatically (its own restart policy) once MediaMTX is back,
  so the whole local dev pipeline recovers without any manual step beyond
  `docker compose start`.

## What this pass did not cover

- Killing Postgres/Redis **mid-transaction** (not just mid-simple-query) —
  only single-statement/single-command failures were exercised.
- A true network partition (packets silently dropped) rather than a clean
  container stop (which sends a prompt TCP close/RST) — a partition could
  behave differently (slower to detect) than what was measured here.
- The worker process's own BullMQ job failures under a DB/Redis outage —
  `worker.on("failed")` already catches a job's rejected promise (confirmed
  by reading the code, not by killing infra mid-job in this pass); a
  dedicated kill-mid-job test is a reasonable future addition.
- Multi-instance/load-balanced API behavior — this is still a
  single-process deployment (see docs/deployment.md).
