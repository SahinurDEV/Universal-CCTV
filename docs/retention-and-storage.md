# Retention and Storage Accounting

## Retention policies

- Every tenant gets three example policies at registration (not fixed
  product commitments — see docs/requirements.md §9): **7 days**, **30 days**
  (marked default), **90 days**. `GET /retention-policies` lists a tenant's
  policies.
- A camera can be assigned a specific policy (`PATCH /cameras/:id` with
  `retentionPolicyId`); if it has none, new segments fall back to the
  tenant's default policy. If *neither* exists, segments get
  `retentionExpiresAt: null` — meaning **kept indefinitely**, not deleted
  immediately. This is deliberate: "ambiguous policy" must never be
  interpreted as "delete it," per the product's own retention-safety rule
  (docs/requirements.md §10).
- `retentionExpiresAt` is computed **once, at ingest time**
  (`recording/ingest.ts`'s `resolveRetentionDays`), from whatever policy was
  in effect for that camera at that moment, and frozen onto the segment row.
  Changing a camera's policy later only affects segments recorded after the
  change — verified: assigning a new 7-day policy mid-stream left
  already-recorded segments at their original 30-day expiry while new
  segments picked up 7 days.

## Enforcement (`recording/retention.ts`, `enforceRetention()`)

Runs on a BullMQ-scheduled interval in `worker.ts` (60s in this local dev
setup — a real deployment would use a much longer interval, since retention
doesn't need minute-level responsiveness; it's kept short here purely so
it's observable without an artificial wait). Steps, matching
docs/requirements.md §10 exactly:

1. **Mark eligible**: `COMPLETE` segments whose `retentionExpiresAt` has
   passed become `EXPIRED`. A segment with `retentionExpiresAt: null` is
   never selected by this query — structurally impossible to accidentally
   delete an unset-policy segment.
2. **Delete the backing object** for every `EXPIRED` segment.
3. **Update metadata** — only on a successful delete does the row become
   `DELETED`.
4. **Audit log** each deletion (`recording.retention_delete`).

**Reconciliation is this same function, not a separate one.** A segment
whose S3 delete failed stays `EXPIRED` (never silently reverted to
`COMPLETE`) — the next scheduled run just tries it again. There is no
separate "retry failed deletes" job because every run already retries
anything still sitting in `EXPIRED`.

Verified directly (not just via the automated test): created a segment with
`retentionExpiresAt` in the past, one with no policy at all, and one not yet
due — ran `enforceRetention()` — confirmed via independent S3 `HeadObject`
checks that only the actually-expired segment's object was gone; the
no-policy and not-yet-due objects were both still present.

## Storage usage (`GET /storage/usage`)

Sums real `fileSizeBytes` across a tenant's segments with status `COMPLETE`
or `EXPIRED` (an `EXPIRED` segment's object still exists until deletion
actually succeeds — excluding it would undercount real storage in use
during the window between "marked for deletion" and "actually deleted").
`DELETED`/`UPLOAD_FAILED`/`RECORDING` segments don't have a real object
occupying storage right now, so they're excluded.

Verified the returned total against the real database sum (byte-exact
match) and against a second tenant seeing zero (not this tenant's numbers).
Feeds the Overview page's "Storage used" tile and the dedicated Storage
page's per-camera breakdown.

## What's not implemented

- **Storage reconciliation / orphaned-object cleanup**: an object that
  exists in S3 with no corresponding DB row (e.g. from a crash between
  upload and DB write — though `ingest.ts`'s ordering already minimizes
  this window) is never detected or cleaned up. Tracked, not built.
- **Storage quotas**: nothing enforces a per-tenant storage limit or warns
  as one is approached — that depends on the subscription/billing layer
  (Phase 8), which doesn't exist yet.
- **Per-camera retention estimate before enabling long retention**
  (docs/requirements.md §10's "show users an estimate" requirement) — not
  built; the storage calculator formula exists only as a worked example in
  docs/foundation-assessment.md §8, not as a real tool.
- Deleting a camera does **not** clean up its recordings' S3 objects or
  retention-expire them early — this was already a documented gap before
  Phase 7 and retention enforcement doesn't change it.
