import { loadEnv } from "../env.js";

export class MediaMtxError extends Error {}

function apiUrl(path: string): string {
  return `${loadEnv().MEDIAMTX_API_URL}${path}`;
}

function playbackUrl(path: string): string {
  return `${loadEnv().MEDIAMTX_PLAYBACK_URL}${path}`;
}

/**
 * Every camera being recorded gets its own MediaMTX path, named this way so
 * it can't collide with anything a user might name a manually-published
 * test path (see docker-compose.yml's `all_others` catch-all).
 */
export function mediamtxPathName(cameraId: string): string {
  return `cam-${cameraId}`;
}

/**
 * Starts MediaMTX pulling and recording a camera's stream. `rtspUrl` embeds
 * the camera's credential — this is sent to MediaMTX's own API over
 * plaintext HTTP on localhost (see the auth warning in
 * infra/mediamtx/mediamtx.yml) and is never logged by this function.
 */
export async function addRecordingPath(
  cameraId: string,
  rtspUrl: string,
  opts: { segmentDurationSeconds: number },
): Promise<void> {
  const res = await fetch(apiUrl(`/v3/config/paths/add/${mediamtxPathName(cameraId)}`), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      source: rtspUrl,
      sourceOnDemand: false, // keep recording even with nobody viewing live
      record: true,
      recordPath: `/recordings/%path/%Y-%m-%d_%H-%M-%S-%f_%z`,
      recordFormat: "fmp4",
      recordSegmentDuration: `${opts.segmentDurationSeconds}s`,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new MediaMtxError(`Failed to add recording path (${res.status}): ${scrub(body, rtspUrl)}`);
  }
}

/**
 * Turns off recording for an already-added path WITHOUT removing the path
 * itself. Confirmed behavior: this finalizes whatever segment MediaMTX was
 * actively writing (it becomes immediately safe to ingest, not truncated or
 * corrupt) rather than leaving it in a half-written state. This is the
 * required first step before fully removing a path — see
 * `removeRecordingPath`'s warning.
 */
export async function stopRecordingPath(cameraId: string): Promise<void> {
  const res = await fetch(apiUrl(`/v3/config/paths/patch/${mediamtxPathName(cameraId)}`), {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ record: false }),
  });
  if (!res.ok && res.status !== 404) {
    throw new MediaMtxError(`Failed to stop recording on path (${res.status})`);
  }
}

/**
 * Stops recording and removes the path. IMPORTANT: this also deletes any
 * not-yet-ingested recording segments on MediaMTX's own disk (confirmed
 * behavior, not documented upstream) — callers MUST drain all pending
 * segments via `listSegments`/`fetchSegment` and persist them before
 * calling this, or that footage is lost. See the recording worker.
 */
export async function removeRecordingPath(cameraId: string): Promise<void> {
  const res = await fetch(apiUrl(`/v3/config/paths/delete/${mediamtxPathName(cameraId)}`), {
    method: "DELETE",
  });
  // 404 means the path is already gone — fine, not an error for our purposes.
  if (!res.ok && res.status !== 404) {
    throw new MediaMtxError(`Failed to remove recording path (${res.status})`);
  }
}

/**
 * Runtime connection status for an already-added path — `ready: true` means
 * MediaMTX currently has a live, readable stream from the camera's RTSP
 * source; `ready: false` means it's configured but not currently connected
 * (camera off, network down, wrong credentials, etc — MediaMTX retries the
 * pull internally, this just reports its current state). Returns `null` if
 * the path doesn't exist at all (e.g. recording was never started, or was
 * removed outside the normal stop flow).
 */
export async function getPathStatus(cameraId: string): Promise<{ ready: boolean } | null> {
  const res = await fetch(apiUrl(`/v3/paths/get/${mediamtxPathName(cameraId)}`));
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new MediaMtxError(`Failed to get path status (${res.status})`);
  }
  const body = (await res.json()) as { ready?: boolean };
  return { ready: body.ready === true };
}

/**
 * Bulk equivalent of `getPathStatus`, keyed by path name — one HTTP round
 * trip to MediaMTX regardless of how many cameras are being recorded,
 * instead of one per camera. This exists specifically for
 * `recording/health.ts`'s periodic health-check job: with N
 * actively-recording cameras, calling `getPathStatus` in a loop means N
 * HTTP requests to MediaMTX every health-check interval, which scales
 * linearly with camera count for no reason — MediaMTX's own `/v3/paths/list`
 * already returns every path's status in one response (confirmed against
 * the real running MediaMTX instance, not assumed from the docs). Handles
 * pagination defensively even though a real deployment's camera count is
 * expected to stay well under one page.
 */
export async function listAllPathStatuses(): Promise<Map<string, { ready: boolean }>> {
  const statuses = new Map<string, { ready: boolean }>();
  let page = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const res = await fetch(apiUrl(`/v3/paths/list?page=${page}&itemsPerPage=100`));
    if (!res.ok) {
      throw new MediaMtxError(`Failed to list path statuses (${res.status})`);
    }
    const body = (await res.json()) as {
      pageCount?: number;
      items?: { name: string; ready?: boolean }[];
    };
    for (const item of body.items ?? []) {
      statuses.set(item.name, { ready: item.ready === true });
    }
    page += 1;
    if (!body.pageCount || page >= body.pageCount) break;
  }
  return statuses;
}

export interface RecordingSegmentRef {
  /** Raw start timestamp as returned by MediaMTX, e.g. "2026-10-20T06:22:43.877559Z" */
  start: string;
}

/**
 * Lists individual recorded segment files for a camera, oldest first. Each
 * entry corresponds to one real file on MediaMTX's disk — NOT the same as
 * the playback API's merged "time span" list.
 */
export async function listSegments(cameraId: string): Promise<RecordingSegmentRef[]> {
  const res = await fetch(apiUrl(`/v3/recordings/get/${mediamtxPathName(cameraId)}`));
  if (res.status === 404) return [];
  if (!res.ok) {
    throw new MediaMtxError(`Failed to list segments (${res.status})`);
  }
  const body = (await res.json()) as { segments?: RecordingSegmentRef[] };
  return (body.segments ?? []).sort((a, b) => a.start.localeCompare(b.start));
}

/**
 * Downloads one segment's video bytes via the playback API. `durationSeconds`
 * should be computed by the caller as the gap to the NEXT segment's start
 * (the configured recordSegmentDuration is a target, not an exact value —
 * fMP4 segments cut on keyframe boundaries, so actual durations vary).
 */
export async function fetchSegment(
  cameraId: string,
  start: string,
  durationSeconds: number,
): Promise<Buffer> {
  const url = `${playbackUrl("/get")}?path=${encodeURIComponent(mediamtxPathName(cameraId))}&start=${encodeURIComponent(
    start,
  )}&duration=${durationSeconds}&format=mp4`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new MediaMtxError(`Failed to fetch segment (${res.status})`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export async function deleteSegment(cameraId: string, start: string): Promise<void> {
  const res = await fetch(
    apiUrl(`/v3/recordings/segments/delete?path=${encodeURIComponent(mediamtxPathName(cameraId))}&start=${encodeURIComponent(start)}`),
    { method: "DELETE" },
  );
  if (!res.ok && res.status !== 404) {
    throw new MediaMtxError(`Failed to delete segment (${res.status})`);
  }
}

function scrub(text: string, secretUrl: string): string {
  return text.split(secretUrl).join("[rtsp url redacted]");
}
