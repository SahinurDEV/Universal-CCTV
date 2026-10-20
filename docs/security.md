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
