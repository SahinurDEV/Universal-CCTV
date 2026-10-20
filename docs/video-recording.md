# Video Recording

## How it actually works

```
Camera (RTSP) ──────────► MediaMTX pulls it as path "cam-{cameraId}"
                              │
                              ├── records fMP4 segments to its own volume
                              │   (stream-copy — no transcoding, no ffmpeg
                              │   in this path at all)
                              │
apps/api/src/worker.ts  ◄────┘ polls MediaMTX's recordings-list API every 15s
     │
     ├── fetches each finished segment over HTTP (MediaMTX's playback API)
     ├── uploads it to S3 (tenants/{tenantId}/cameras/{cameraId}/recordings/{date}/{recordingId}.mp4)
     ├── writes a RecordingSegment row (status COMPLETE)
     └── deletes the segment from MediaMTX's own disk
```

No ffmpeg process is spawned for recording itself — MediaMTX does the
RTSP-pull and fMP4 segmentation natively (Go, in-process), which is also why
this is a true stream-copy: MediaMTX repackages the camera's existing H.264/
AAC packets into MP4 containers without decoding/re-encoding them. ffmpeg
(via `ffprobe`) is only used elsewhere — camera connection testing
(docs/camera-integration.md) and the one duration edge case below.

## Why polling, not a webhook

MediaMTX has no "segment finished" event/webhook. Its two relevant HTTP APIs
(both enabled in `infra/mediamtx/mediamtx.yml`):
- **Config API** (`:9997`) — `POST /v3/config/paths/add/{name}` /
  `PATCH .../patch/{name}` / `DELETE .../delete/{name}` to start/stop
  recording a camera, and `GET /v3/recordings/get/{name}` to list individual
  segment files by start timestamp (one entry per real file on disk).
- **Playback API** (`:9996`) — `GET /get?path&start&duration&format=mp4`
  streams back the actual recorded bytes for an arbitrary start+duration
  window. Verified (see below) that requesting a duration longer than what's
  actually recorded returns only the real available bytes — no error, no
  padding — which is what makes the "unknown last segment" case below safe.

`apps/api/src/worker.ts` runs a BullMQ-scheduled poll every 15 seconds,
calling the config API's recordings list for every camera with a `RUNNING`
`RecordingJob`, then ingesting (download → S3 → DB row → delete-from-MediaMTX)
whatever's new.

## The "is this segment actually done?" problem

MediaMTX's recordings-list returns every segment file that currently exists
on disk — including the one it's actively writing right now. Ingesting a
segment mid-write would both race MediaMTX's own file handle and produce a
truncated/wrong-duration result.

The fix doesn't require any special "is it still open" check: MediaMTX only
ever writes to the single most recent file for a path. So during periodic
polling, every segment **except the last one in the list** is guaranteed
complete, because a newer file already exists after it. `drainPendingSegments`
(`src/recording/ingest.ts`) takes an `includeLast` flag specifically for this:
- Periodic worker polls: `includeLast: false` — always leave the newest one.
- Stop route: `includeLast: true` — but only after first calling
  `stopRecordingPath` (PATCHes `record: false`), which **finalizes** whatever
  segment was in progress (verified manually: patching mid-segment produced
  a clean, correctly-sized, playable file, not a truncated/corrupt one).

## Duration accuracy — a real bug found and fixed during manual verification

For every segment except the true last one, the real duration is `next
segment's start time − this segment's start time` — verified against actual
recordings to match reality (not just the configured target).

The true *last* segment of a stopped recording has no "next" to diff
against. The first implementation guessed `segmentSeconds × 2` as an upper
bound — this was caught by manually checking bytes-per-second across
segments: the guessed-duration segment showed ~9.4 KB/s against the real
~55 KB/s of every other segment, meaning the stored `durationSec` (20s) was
roughly 5-6× the actual footage length (~3-4s). **Fixed** by ffprobing the
actual downloaded file (`connectors/file-probe.ts`) whenever the exact
duration isn't already known from timestamp math, instead of ever trusting
an estimate. Re-verified afterward: bytes/sec became consistent (~51K–61K/s)
across all segments in the same recording.

## Stopping a recording — order matters

`removeRecordingPath` (full path deletion) was confirmed, by direct testing,
to delete not-yet-ingested recording files along with the path config —
this isn't documented upstream, so it was verified directly rather than
assumed. The stop route therefore does, strictly in this order:
1. `stopRecordingPath` — `record: false`, finalizes the in-progress segment.
2. `drainPendingSegments({ includeLast: true })` — ingest everything,
   including what was previously "the last, maybe-still-writing" one.
3. `removeRecordingPath` — only now is it safe to fully remove the path.

If step 2 fails partway, the route marks the `RecordingJob` `FAILED` and
does **not** proceed to step 3 — whatever wasn't ingested stays on
MediaMTX's disk rather than being silently deleted.

## What's verified vs. what isn't

**Verified for real** (see the manual testing notes in commit history / this
session): a full start → record (while a background worker, not just the
stop route, independently ingests segments every 15s) → stop → drain cycle
against the real MediaMTX+LocalStack stack, with every DB row's size/duration
cross-checked against the actual S3 object. Automated integration tests
(`src/routes/recording.integration.test.ts`) cover: successful recording
with real segment upload+verification, duplicate-start rejection, stopping
with nothing active, and tenant isolation.

**Not implemented**:
- Motion-based/event-triggered recording (continuous only).
- Retention enforcement / automatic deletion after N days (the schema has
  `RetentionPolicy` and `RecordingSegment.retentionExpiresAt`, but nothing
  sets or acts on them yet — Phase 7).
- Recording health/gap detection, reconnect-with-backoff on a dropped camera
  source (MediaMTX has its own internal reconnect behavior for the RTSP
  pull, but nothing in this app surfaces or acts on a prolonged camera
  outage yet).
- Horizontal scaling of the worker — it's a single process; running two
  would double-poll the same jobs. The `alreadyIngested` DB check in
  `drainPendingSegments` prevents double-uploading the same segment even if
  that happened, but true multi-worker coordination (locking/sharding jobs
  across workers) isn't built.
- Playback/timeline UI — recordings exist in S3 + the database now, but
  there's no dashboard page to browse or play them yet (Phase 6).

## Local dev: running the worker

```bash
pnpm --filter @cctv/api worker   # separate terminal from the API itself
```

Requires `docker compose up` (MediaMTX + LocalStack) and the API's normal
env setup (see README.md).
