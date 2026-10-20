# Subscriptions and Billing

## There is no real payment provider — and that's deliberate

Per docs/requirements.md §15: payment provider availability varies by
country and shouldn't be assumed, and a development billing adapter is
acceptable for MVP as long as it's never presented as a real transaction.
This platform has exactly one `BillingProvider` implementation
(`apps/api/src/billing/provider.ts`): `devBillingProvider`, which simulates
every call instantly with no external payment processor involved.

- `Subscription.billingProvider` is persisted as `"dev"` so every
  simulated subscription is auditable as such — nothing silently looks
  like a real Stripe (or similar) subscription.
- The Subscription dashboard page shows an explicit amber banner on every
  load: "Development billing provider — plan changes here are simulated.
  No real payment is ever charged."
- Plugging in a real provider later means implementing the
  `BillingProvider` interface and swapping `getBillingProvider()`'s
  return value — no changes needed to quota enforcement or the
  subscription routes, which only ever talk to the interface.

## Plans live in the database, not in code

`SubscriptionPlan` rows (seeded via `prisma/seed.ts` — see the `prisma:seed`
script) are the only source of camera limits, storage quotas, retention
limits, and price. Three example tiers exist (not fixed product
commitments — same caveat as the retention-day examples elsewhere in this
project):

| Plan | Cameras | Storage | Max retention | Price/mo |
|---|---|---|---|---|
| Free Trial (`free`) | 2 | 5 GB | 7 days | $0 |
| Starter (`starter`) | 10 | 50 GB | 30 days | $29 |
| Pro (`pro`) | 50 | 500 GB | 90 days | $99 |

No limit or price is hardcoded into the recording, retention, or camera
code — `lib/quota.ts`'s `getActiveSubscription` is the only place those
numbers get read, and every enforcement check goes through it.

## What happens on registration

Every new tenant gets a `Subscription` row immediately: plan = `free`,
status = `TRIALING`, a 14-day `currentPeriodEnd`. If the `free` plan hasn't
been seeded yet (a deployment-order bug, not a user error), registration
still succeeds but the tenant has no subscription — verified this doesn't
crash anything: every quota check treats "no subscription" as "unlimited,"
not as "block everything," so a seeding bug degrades gracefully instead of
locking out every new signup.

## Quota enforcement — where, and why there

Per docs/requirements.md §9/§15 ("storage quota... enforced before new
recording jobs start," limits stored in config/DB, never hardcoded into the
recording engine):

| Limit | Enforced at | Response on violation |
|---|---|---|
| Camera count | `POST /cameras` (before creating the row) | `402 camera_limit_reached` |
| Storage quota | `POST /cameras/:id/recording/start` (before dialing the camera) | `402 storage_quota_exceeded` |
| Retention days | `PATCH /cameras/:id` when setting `retentionPolicyId` | `402 retention_exceeds_plan` |

All three were verified against a real running server, not just unit
logic: created 2 cameras on a fresh free-trial tenant (succeeded), a 3rd
was rejected; assigned a 30-day retention policy on a free-trial camera
(rejected, limit is 7), then the 7-day policy on the same camera (accepted).
Storage-quota enforcement is tested by inserting a real-shaped
`RecordingSegment` row sized past the plan's quota (faster than actually
uploading 5GB) and confirming `recording/start` is blocked — the
enforcement code only sums `fileSizeBytes`, so this exercises the identical
code path a real 5GB of footage would.

**Deliberate non-enforcement**: downgrading to a plan with a lower camera
limit than currently in use is allowed (`POST /subscription/change` returns
`overCameraLimit: true` rather than blocking the downgrade or deleting
cameras) — nothing here auto-deletes a customer's cameras because they
downgraded. The tenant just can't add new ones until back under the new
limit.

## Usage reporting

`GET /subscription` returns live `cameraCount` and `storageBytesUsed`
(same storage definition as `GET /storage/usage` — COMPLETE + EXPIRED
segments) against the current plan's limits — this is read at request
time, not from a periodic snapshot. The `UsageRecord` table exists in the
schema for periodic historical snapshots but nothing writes to it yet; it's
not implemented, only reserved.

## What's not implemented

- A real payment provider of any kind.
- Payment failure handling (`PAST_DUE` status exists in the schema/enum but
  nothing ever sets it — there's no real payment to fail).
- Per-camera cost estimates shown before upgrading/choosing a longer
  retention period (docs/retention-and-storage.md's same gap).
- Historical `UsageRecord` snapshots (schema-only, as above).
- Proration, invoicing, or any notion of "paid until" beyond the single
  `currentPeriodEnd` field.
