# Playback

## How it works

```
Web app: Recordings page
  │ 1. GET /cameras/:id/recordings/dates        → which UTC dates have anything
  │ 2. GET /cameras/:id/recordings?date=YYYY-MM-DD → segment list for that day
  │ 3. GET /cameras/:id/recordings/:segmentId/url  → short-lived signed S3 URL
  ▼
Browser fetches the signed URL DIRECTLY from S3/LocalStack — the video
bytes never pass through the API process.
```

- **Dates endpoint exists so the date picker never lets you pick an empty
  day.** It's a `SELECT DISTINCT ... ::date` grouped by UTC calendar date
  (same grouping `buildRecordingObjectKey` already uses for the S3 key
  scheme), restricted to `status = 'COMPLETE'` segments.
- **The segment list never includes the S3 object key.** Only the
  dedicated `/url` route resolves a segment to an actual signed URL, and
  only for a segment tenant-scoped to the caller. This keeps the internal
  key structure (`tenants/{tenantId}/cameras/{cameraId}/...`) out of every
  response except the one that's explicitly handing out a URL.
- **Signed URLs expire after `SIGNED_URL_TTL_SECONDS`** (300s / 5 min by
  default) — verified by actually fetching a generated URL and confirming
  it serves the real video (see docs/testing.md), not just that
  `getSignedUrl()` didn't throw.
- **Download vs. play use the same mechanism**, differing only in
  `?download=true`, which adds `ResponseContentDisposition:
  attachment; filename="..."` to the presigned request — verified the
  resulting `Content-Disposition` header is actually present on the real
  response, not just passed as a parameter.
- A segment that exists but isn't `COMPLETE` (still `RECORDING`, or
  `UPLOAD_FAILED`) returns 404 from the `/url` route — there's nothing
  valid to hand back a URL for, and distinguishing that from "doesn't
  exist" isn't useful information to expose.

## The UI

`apps/web/src/app/dashboard/recordings/page.tsx`:
- Camera dropdown → date dropdown (populated only from dates that actually
  have recordings, not a blind calendar picker) → a day timeline (segments
  as green bars positioned/sized by real start time and duration, gaps
  rendered as empty space — "clearly show missing recording intervals" per
  the original product spec, not synthesized or hidden) → a segment table
  with Play/Download actions → an inline `<video>` player with
  Previous/Next buttons that step between adjacent **complete** segments
  (skipping anything not playable).
- The player explicitly labels what it's showing as a stored recording, not
  live video — live view doesn't exist yet (see docs/requirements.md), so
  there's no ambiguity to even create here.

## What's verified vs. not

**Verified for real**: dates listing against a camera that actually
recorded something today; segment listing excludes non-complete segments
and never leaks the object key; a generated signed URL independently
fetched and confirmed to be the real video (byte-length matches the DB's
`fileSizeBytes` exactly, `ffprobe`-equivalent content-type is `video/mp4`);
download mode's `Content-Disposition` header confirmed present on the
actual HTTP response; cross-tenant access to another tenant's recordings
404s. See `src/routes/playback.integration.test.ts`.

**Not implemented**:
- HLS / adaptive playback — MVP is direct MP4 segment playback only, per
  docs/requirements.md's stated stretch goal.
- Seeking *across* segment boundaries in one continuous timeline — today
  each segment is its own `<video>` element; Previous/Next jumps between
  them, but there's no single scrubber spanning a whole day.
- Any UI distinguishing `UPLOAD_FAILED` segments from ones that simply
  don't exist yet — both just don't show a Play/Download action.
