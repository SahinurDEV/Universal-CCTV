# Database Schema

Source of truth: `apps/api/prisma/schema.prisma`. This doc explains the shape and
the tradeoffs made for MVP; see inline doc-comments in the schema file for the
specific reasoning attached to each model.

## Entity overview

- **Tenant / User / Membership** — org = tenant. `Membership` carries a `Role`
  enum (`OWNER`, `ADMIN`, `OPERATOR`, `VIEWER`) per tenant.
- **Location / Camera** — camera belongs to a tenant and optionally a location.
- **CameraCredential** — RTSP credentials, kept in a separate table from
  `Camera`, AES-256-GCM encrypted at rest, never joined into list/read endpoints
  that return camera metadata to the client.
- **CameraCapabilityRecord** — one-to-one with `Camera`, written only by the
  capability-detection flow.
- **CameraConnectionSession** — append-only history of connect attempts/status,
  used for health monitoring and offline notifications.
- **RecordingJob / RecordingSegment** — a `RecordingJob` represents one
  "recording is active for this camera" lifecycle; `RecordingSegment` is one row
  per completed (or in-progress) video segment with its object key, size,
  duration, status, and retention expiry.
- **RetentionPolicy** — per-tenant named policies (e.g. "30-day"), optionally
  assigned per camera.
- **SubscriptionPlan / Subscription / UsageRecord** — plan limits live in the
  `SubscriptionPlan` table (never hardcoded in the recording engine), tenant's
  active subscription references a plan, `UsageRecord` is a periodic snapshot
  for billing/usage reporting.
- **Notification / AuditLog** — tenant-scoped notification feed and audit trail.
- **GatewayDevice** — reserved for the future Go local-gateway agent (not yet
  implemented; see docs/architecture.md §6).
- **IntegrationConfig** — reserved for future manufacturer-API connectors.

## Tradeoffs explicitly made for MVP (documented per spec §13 requirement)

1. **No separate `Role`/`Permission` tables.** `Membership.role` is a fixed enum
   (OWNER/ADMIN/OPERATOR/VIEWER) rather than a fully dynamic permissions system.
   Rationale: a dynamic permission matrix is unused complexity until there's a
   real need for custom roles; the enum is enforced in API middleware
   (`requireRole(...)`) and is trivial to migrate off later since authorization
   checks are already centralized, not scattered.

2. **No separate `StorageObject` table.** The spec lists "Storage objects" as a
   distinct entity from recording segments, but for MVP every object we store is
   a recording segment 1:1 — so `RecordingSegment` carries `objectKey`,
   `fileSizeBytes`, and `integrityVerifiedAt` directly instead of a joined table.
   If/when we store non-recording objects (thumbnails, exported clips), those get
   their own table rather than overloading this one, and `RecordingSegment` stays
   a facade over its own object.

3. **Camera credentials encrypted with a server-held symmetric key
   (`CREDENTIAL_ENCRYPTION_KEY`), not a managed secrets service.** A real secrets
   manager (AWS Secrets Manager / Vault) is the recommended production upgrade —
   deferred because it is an external dependency with no AWS account available in
   this environment yet (see docs/architecture.md §7 risks). The encryption
   boundary (`CameraCredential` table, dedicated encrypt/decrypt module, never
   logged, never returned by read endpoints) is already in place so swapping the
   key-storage backend later does not change any call site.

4. **One active `RecordingJob` per camera, enforced at the application layer**
   inside a DB transaction, backed by the `(cameraId, status)` index. A stricter
   DB-level partial unique index (`WHERE status IN ('PENDING','RUNNING')`) is the
   next hardening step once the recording manager lands (Phase 5) and we can test
   the concurrent-start race directly.

5. **All timestamps are UTC `DateTime` columns** (Postgres `timestamptz` under
   Prisma's `DateTime`). No naive/local timestamps anywhere in the schema.

## Migrations

Run from `apps/api`:

```bash
pnpm prisma:migrate   # prisma migrate dev — creates/applies a migration locally
pnpm prisma:generate  # prisma generate — regenerate the client after schema edits
```

No migration has been applied yet in this environment (no running Postgres
instance was available during scaffolding) — see docs/testing.md for what's been
verified vs. what's pending a live database.
