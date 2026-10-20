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

Per-tenant storage *quota enforcement* (blocking a new recording once a
plan's limit is reached) lives in the subscription/billing layer, not
here — see docs/subscriptions-and-billing.md.

## Storage reconciliation / orphaned-object cleanup

**Built.** `recording/reconciliation.ts`'s `reconcileOrphanedObjects()`,
run on a BullMQ schedule in `worker.ts` (every 5 minutes in this local dev
setup — same "short for observability" tradeoff as the other jobs).

The real root cause this closes, found by reading the schema rather than
guessing: `DELETE /cameras/:id` cascades away every `RecordingSegment` row
for that camera (Prisma `onDelete: Cascade` on the `camera` relation) but
never touches the camera's S3 objects — so deleting a camera orphans 100%
of its recorded footage immediately, not just occasionally. A second,
narrower source exists too: `ingest.ts` uploads to S3 *before* writing the
DB row, so a crash in that window orphans the upload (the retry generates
a fresh object key for the same segment, rather than reusing the orphaned
one).

The job lists every object under the bucket's `tenants/` prefix,
cross-references each one's key against `recording_segments.object_key`
in bulk (chunked `IN` queries, not one query per object), and deletes
anything with no matching row — regardless of that row's status, since
even a `DELETED` row means something already owns that key's lifecycle.
Objects younger than 15 minutes (`ORPHAN_MIN_AGE_MS`) are never touched,
so an upload that's genuinely mid-ingest (DB write about to land) can
never be mistaken for an orphan.

**Verified for real**, not just via the automated test
(`reconciliation.integration.test.ts`): recorded two real segments for a
real camera, deleted that camera through the live API, confirmed via a
direct Prisma query that both `RecordingSegment` rows were gone and via
`HeadObjectCommand` that both S3 objects still existed (reproducing the
bug), then ran `reconcileOrphanedObjects` against the live stack and
confirmed via `HeadObjectCommand` again that both objects were actually
deleted.

## What's not implemented

- **Per-camera retention estimate before enabling long retention**
  (docs/requirements.md §10's "show users an estimate" requirement) — not
  built; the storage calculator formula exists only as a worked example in
  docs/foundation-assessment.md §8, not as a real tool.
