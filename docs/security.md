# Security

Documents the security-relevant decisions actually implemented so far.
Not a full security program — it grows as each phase adds real attack
surface, not written speculatively ahead of the code.

## Authentication

- Passwords hashed with bcrypt (`bcryptjs`, 12 salt rounds). Chosen over
  native `bcrypt`/`argon2` specifically to avoid native-module build
  failures on Windows dev machines — this is a real constraint that bit this
  project during setup, not a hypothetical.
- Sessions are **opaque, DB-backed tokens**, not JWTs. The raw token lives
  only in an `httpOnly`, `SameSite=Lax` cookie; only its SHA-256 hash is
  persisted (`Session.tokenHash`). This means a session can actually be
  revoked (logout sets `revokedAt`) — a bare JWT can't be invalidated
  server-side without a separate blocklist, which would just be this same
  mechanism with extra steps.
- Login and register are rate-limited (20 requests / 15 minutes per IP) via
  `express-rate-limit` to slow down credential stuffing.
- Login returns an identical `401 {"error":"invalid_credentials"}` whether
  the email doesn't exist or the password is wrong, so the response shape
  alone can't be used to enumerate registered accounts. (bcrypt's own
  compare timing still differs slightly between "user not found, skip
  compare" and "user found, compare" — a Phase 9 hardening item would be a
  dummy-hash compare on the not-found path to close that further; not done
  yet.)
- **Not implemented yet**: email verification sending, password reset.
  `User.emailVerifiedAt` exists in the schema but nothing sets it; no SMTP
  provider is configured. Documented here rather than silently half-built.

## Tenant isolation and authorization

- Every camera route requires `requireAuth` (valid session) then
  `requireTenant` (session's active tenant + a real `Membership` row,
  re-checked per request, not cached from login time).
- Every camera query is scoped `WHERE tenantId = <active tenant>`, enforced
  in the route handler, not left to the caller. A request for another
  tenant's camera returns **404**, not 403 — this is deliberate: 403 would
  confirm the resource exists under a different tenant, which is itself an
  information leak.
- Role-gating (`requireRole`) blocks mutating actions (create/delete) for
  the `VIEWER` role; reads are allowed for any role with a valid membership.
- Verified by integration tests against a real Postgres instance
  (docs/testing.md), including an explicit "tenant B cannot read/update/
  delete tenant A's camera" test — not just asserted by code inspection.

## Camera credential handling

- RTSP credentials (username/password/path) are encrypted at rest with
  AES-256-GCM (`lib/crypto.ts`) using a server-held key
  (`CREDENTIAL_ENCRYPTION_KEY`, 32 bytes, from environment — never a
  default, since a default key provides no real protection).
- The encrypted value is stored in its own table (`CameraCredential`),
  separate from camera metadata, and is never included in any API response —
  camera read/list endpoints return `hasCredential: boolean` only. Verified
  by an integration test asserting the plaintext credential string never
  appears anywhere in a create-camera JSON response.
- Credentials are never logged: the logger's redaction config
  (`lib/logger.ts`) strips `*.rtspUrl`, `*.password`, `*.credentialRef`, and
  `req.headers.cookie`/`res.headers['set-cookie']` from structured logs.
- **Known gap, not yet addressed**: the encryption key lives in process
  environment, not a managed secrets service (Vault/AWS Secrets Manager).
  Documented as a tradeoff in docs/database-schema.md — acceptable for this
  stage, not for production, with no external secrets-manager dependency
  introduced until one is actually needed.

## SSRF protection

- `lib/network-guard.ts` rejects a camera host at **creation/update time**
  if it's loopback (`127.0.0.0/8`, `::1`), link-local (`169.254.0.0/16`,
  `fe80::/10` — this blocks the cloud metadata address
  `169.254.169.254` specifically), or the literal `localhost`.
- Deliberately does **not** block RFC1918 private ranges (`10.x`,
  `172.16.x`, `192.168.x`) — real cameras legitimately live there, and
  blocking those ranges would break the actual product.
- Deliberately does **not** perform DNS resolution at this stage (no
  connector dials anything yet, Phase 4). This is a known half-measure: a
  hostname that resolves to a blocked address at connection time would pass
  this check. The connector layer, which actually opens a socket, is
  responsible for re-validating the *resolved* address immediately before
  connecting — documented as a requirement for Phase 4, not forgotten.
- Verified by integration tests for both the loopback and metadata-address
  cases.

### Real vulnerability found and fixed: the guard was fully bypassable

A dedicated security-review pass (two independent sub-agent review +
verification passes, following the `security-review` skill's methodology)
found that `connectorType: "SIMULATED"` skipped `assertSafeCameraHost`
entirely, with no check that `host` was actually the known dev fixture
address. Since `host`/`connectorType` are independent request fields, any
authenticated tenant member could create a camera with
`{connectorType: "SIMULATED", host: "169.254.169.254"}` and the guard would
never run — then `test-connection` or `recording/start` would make the
server (and MediaMTX) actually dial that address. **Fixed**: `SIMULATED`
cameras are now pinned to the literal host `"localhost"` — anything else is
rejected with the same `unsafe_host` error, in both the create and update
routes (`routes/cameras.ts`). Verified: the exploit payload now returns 400,
and the real simulated-camera flow still works. A regression test exists
for both (`cameras.integration.test.ts`).

## MediaMTX network exposure

- `infra/mediamtx/mediamtx.yml` intentionally disables auth on MediaMTX's
  config (9997) and playback (9996) APIs for local dev, on the stated
  assumption that "this port isn't exposed beyond this dev machine."
- **Real gap found and fixed**: `docker-compose.yml` published these ports
  (plus RTSP 8554 and WebRTC 8889) with bare `"HOST:CONTAINER"` syntax,
  which Docker binds to `0.0.0.0` by default — actually reachable from any
  network-adjacent host, contradicting the stated assumption. Anyone on the
  same LAN could have hit the playback API directly to pull any tenant's
  footage, bypassing the app's own auth entirely, or used the config API to
  tamper with recording paths. **Fixed**: all four ports now bind
  explicitly to `127.0.0.1`. Verified: `Get-NetTCPConnection` confirms
  loopback-only binding, and the config API/RTSP publish/playback all still
  work from the host itself (every real consumer runs on this host).
- This is still a local-dev mitigation, not a production one — before any
  real deployment, MediaMTX needs real `authInternalUsers` credentials, not
  just loopback binding (see docs/deployment.md's MediaMTX hardening note).

## Transport and headers

- `helmet()` applied for standard security headers (CSP, HSTS,
  `X-Content-Type-Options`, etc.) on every API response.
- CORS restricted to a single configured origin (`CORS_ORIGIN`) with
  `credentials: true` — the dashboard's cookie-based session only works from
  that exact origin, not from arbitrary sites.
- HTTPS/TLS termination is a deployment-time concern (reverse proxy /
  load balancer), not yet configured — this is local-dev only so far.

## Audit logging

- `lib/audit.ts` writes to `AuditLog` for register, login, camera
  create/update/delete. A failed audit write never fails the user-facing
  request it's recording (logged via `logger.error` instead) — audit
  logging is observability, not a transactional guarantee.
- Audit metadata never includes credentials or full RTSP URLs — only
  non-sensitive fields (e.g. camera name/host/port, not username/password).

## Deferred (tracked, not forgotten)

- Encryption at rest for the database itself (depends on deployment target —
  e.g. RDS encryption) — not applicable to local Postgres-in-Docker dev.
- Secrets-manager-backed credential encryption key.
- MFA, account lockout after repeated failed logins (rate limiting exists;
  per-account lockout does not).
- Signed URL generation for recording playback — no recordings exist yet to
  sign URLs for.

## Security pass — October 2026 (feature/complete-platform)

Real problems found and fixed in this pass (each has a test unless noted):

1. **SSRF: connect-time re-validation was documented but never implemented.**
   `network-guard.ts` said the connector layer would re-check the *resolved*
   address before dialing; nothing did. A DNS name resolving to 127.0.0.1 /
   169.254.169.254, alternative IP spellings (`2130706433`, `0x7f000001`,
   `0177.0.0.1`), or IPv4-mapped IPv6 (`::ffff:127.0.0.1`) passed the guard
   and were dialed by ffprobe/MediaMTX. Fixed: strict hostname syntax check,
   numeric-hostname rejection, IPv4-mapped handling, multicast/reserved
   blocks, optional RFC1918 block (`BLOCK_PRIVATE_CAMERA_HOSTS`), a
   `CAMERA_HOST_DENYLIST`, and `assertSafeResolvedCameraHost` (DNS lookup,
   every address checked) called right before test-connection,
   recording start and live start (`lib/camera-source.ts`).
   Tests: `network-guard.test.ts`, cameras integration test.
   *Residual:* a DNS-rebinding window between our lookup and the dialer's own
   lookup remains; fully closing it needs dialing by pinned IP.
2. **Deleted cameras kept streaming/recording on MediaMTX forever** (path
   never removed). Fixed in `DELETE /cameras/:id`.
3. **`STORAGE_FORCE_PATH_STYLE=false` was ignored** (`z.coerce.boolean()`
   turns `"false"` into `true`). Fixed with an explicit enum parser.
4. **Login timing leaked which emails exist** (bcrypt only ran when the user
   existed). Now a dummy hash is always compared.
5. **Emails were case-sensitive** (`A@x.com` and `a@x.com` = two accounts).
   Now trimmed + lower-cased on register and login.
6. **No password length cap** — bcrypt silently ignores bytes after 72 and
   huge inputs are a cheap CPU DoS. Now 8–128 chars and ≤72 bytes.
7. **CSRF defense-in-depth:** SameSite=lax does not protect against other
   origins on the same *site* (other localhost ports, sibling subdomains),
   and several POSTs have no body. Added an Origin allow-list check for all
   state-changing requests (`middleware/origin-check.ts`).
8. **No rate limit on server-side dial-outs** (`/cameras/discover`,
   `test-connection`) and `/cameras/discover` was open to VIEWERs. Added
   `probeRateLimiter`, role restriction, a global API limiter, and a
   separate generous limiter for live HLS. `TRUST_PROXY` env supported so
   limits key on the real client IP behind a proxy.
9. **Production could boot with the published default `APP_SECRET`** or
   `CORS_ORIGIN=*`. Now refused at startup.
10. **MediaMTX anonymous access from any IP** (`ips: []`). Now limited to
    loopback + Docker bridge range; RTMP/SRT/WebRTC/MoQ disabled; image
    pinned to 1.21.2. Browsers only reach video through the authenticated
    API proxy (`routes/live.ts`) which validates file names (no traversal)
    and forwards only HLS's own query params.
11. **Web security headers** were absent: added CSP, `X-Frame-Options: DENY`,
    `nosniff`, Referrer-Policy, Permissions-Policy (`apps/web/next.config.mjs`).
12. **Input validation:** camera credential fields reject control characters
    (CR/LF/NUL) and have length caps; host ≤253 chars.
13. **Dependency audit:** 44 advisories (5 critical, 13 high) → 2 remaining.
    Upgraded Next.js 14 → 15.5 (React 19), vitest 2 → 4, vite → 7, esbuild,
    postcss (pnpm overrides). Remaining: `braces` via eslint-config-next
    (dev-only, no patched version published) and `postcss-selector-parser`
    via Tailwind 3 (dev/build-only, moderate).

New features were built with the same rules: tenant-scoped queries returning
404 for other tenants' ids, server-side RBAC, audit log entries, encrypted
webhook secrets (shown once), webhook SSRF guard (no redirects, https-only in
production, private ranges blocked in production), password change revoking
all other sessions.

## Invites, members and motion detection (feature/gaps-and-features)

- **Invite tokens**: 256-bit random, base64url; only a SHA-256 hash is
  stored. The raw link is returned once to the inviter (and emailed if SMTP
  is configured); it is logged only when `NODE_ENV=development`. Tokens
  expire (`INVITE_TTL_HOURS`, default 72), are single-use (consumed with a
  conditional update inside a transaction, so concurrent accepts can't both
  succeed), and re-inviting the same email revokes the previous link.
  Invalid/expired/revoked/used tokens all return the same 404.
- **Accepting**: an existing account must be signed in as the invited email
  (no account takeover by link holders); a new account can only be created
  for the invited email. Public token endpoints have their own rate limit;
  invite creation is rate limited per IP. All state-changing endpoints are
  covered by the existing Origin (CSRF) check.
- **Roles**: only OWNER/ADMIN manage invites/members; ADMIN can't grant
  OWNER or modify/remove owners; the last OWNER can't be demoted/removed.
  Membership is re-checked on every request, so removal is immediate.
- **Login `next=` redirect** only accepts same-site relative paths.
- **Motion worker**: ffmpeg is spawned with an argv array (no shell); it
  reads the camera through MediaMTX on loopback after the same DNS-resolved
  SSRF check used for live view, so the camera isn't dialled twice. Error
  messages stored on the camera have the stream URL (which can embed
  credentials) scrubbed. Motion settings changes are audit-logged.
- **docker-compose.yml**: Postgres, Redis and S3 are now bound to
  127.0.0.1 (they use public dev credentials).
- **Dependencies**: `postcss` (via next) and `postcss-selector-parser` are
  overridden to patched versions. Remaining: `braces` (dev-only, via
  eslint-config-next → fast-glob → micromatch) has no patched release.
