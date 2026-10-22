"use client";

import { useEffect, useMemo, useState } from "react";
import {
  getPlaybackUrl,
  listCameras,
  listRecordingDates,
  listRecordings,
  type Camera,
  type RecordingSegmentSummary,
} from "@/lib/api";

export default function RecordingsPage() {
  const [cameras, setCameras] = useState<Camera[] | null>(null);
  const [cameraId, setCameraId] = useState<string>("");
  const [dates, setDates] = useState<string[] | null>(null);
  const [date, setDate] = useState<string>("");
  const [segments, setSegments] = useState<RecordingSegmentSummary[] | null>(null);
  const [loadingSegments, setLoadingSegments] = useState(false);
  const [selectedSegment, setSelectedSegment] = useState<RecordingSegmentSummary | null>(null);
  const [playbackUrl, setPlaybackUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCameras()
      .then((res) => {
        setCameras(res.cameras);
        if (res.cameras.length > 0) setCameraId(res.cameras[0].id);
      })
      .catch(() => setError("Could not load cameras."));
  }, []);

  useEffect(() => {
    if (!cameraId) return;
    setDates(null);
    setDate("");
    setSegments(null);
    setSelectedSegment(null);
    setPlaybackUrl(null);
    listRecordingDates(cameraId)
      .then((res) => {
        setDates(res.dates);
        if (res.dates.length > 0) setDate(res.dates[0]);
      })
      .catch(() => setError("Could not load recording dates."));
  }, [cameraId]);

  useEffect(() => {
    if (!cameraId || !date) return;
    setLoadingSegments(true);
    setSelectedSegment(null);
    setPlaybackUrl(null);
    listRecordings(cameraId, date)
      .then((res) => setSegments(res.segments))
      .catch(() => setError("Could not load recordings for that date."))
      .finally(() => setLoadingSegments(false));
  }, [cameraId, date]);

  async function play(segment: RecordingSegmentSummary) {
    setSelectedSegment(segment);
    setPlaybackUrl(null);
    try {
      const res = await getPlaybackUrl(cameraId, segment.id);
      setPlaybackUrl(res.url);
    } catch {
      setError("Could not get a playback URL for that segment.");
    }
  }

  async function download(segment: RecordingSegmentSummary) {
    try {
      const res = await getPlaybackUrl(cameraId, segment.id, true);
      window.open(res.url, "_blank");
    } catch {
      setError("Could not get a download URL for that segment.");
    }
  }

  function playAdjacent(direction: -1 | 1) {
    if (!segments || !selectedSegment) return;
    const index = segments.findIndex((s) => s.id === selectedSegment.id);
    const next = segments[index + direction];
    if (next) play(next);
  }

  const completeSegments = useMemo(() => segments?.filter((s) => s.status === "COMPLETE") ?? [], [segments]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Recordings</h1>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {cameras && cameras.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-700 p-8 text-center text-slate-400">
          No cameras yet — add one first.
        </div>
      )}

      {cameras && cameras.length > 0 && (
        <div className="flex flex-wrap gap-4">
          <label className="block space-y-1">
            <span className="text-sm text-slate-400">Camera</span>
            <select
              value={cameraId}
              onChange={(e) => setCameraId(e.target.value)}
              className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
            >
              {cameras.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>

          <label className="block space-y-1">
            <span className="text-sm text-slate-400">Date</span>
            <select
              value={date}
              onChange={(e) => setDate(e.target.value)}
              disabled={!dates || dates.length === 0}
              className="rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm disabled:opacity-50"
            >
              {(!dates || dates.length === 0) && <option value="">No recordings</option>}
              {dates?.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}

      {dates && dates.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-700 p-6 text-sm text-slate-400">
          No recordings exist yet for this camera. Start recording from the camera's detail page.
        </div>
      )}

      {loadingSegments && <p className="text-slate-400">Loading recordings...</p>}

      {segments && segments.length > 0 && date && (
        <>
          <DayTimeline date={date} segments={segments} selectedId={selectedSegment?.id ?? null} onSelect={play} />

          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="border-b border-slate-800 text-slate-400">
                <tr>
                  <th className="p-3">Start (UTC)</th>
                  <th className="p-3">Duration</th>
                  <th className="p-3">Size</th>
                  <th className="p-3">Status</th>
                  <th className="p-3" />
                </tr>
              </thead>
              <tbody>
                {segments.map((segment) => (
                  <tr
                    key={segment.id}
                    className={`border-b border-slate-900 ${selectedSegment?.id === segment.id ? "bg-slate-900" : ""}`}
                  >
                    <td className="p-3">{new Date(segment.startedAt).toLocaleTimeString("en-US", { timeZone: "UTC" })}</td>
                    <td className="p-3 text-slate-400">{segment.durationSec ?? "—"}s</td>
                    <td className="p-3 text-slate-400">
                      {segment.fileSizeBytes ? `${(Number(segment.fileSizeBytes) / 1024).toFixed(0)} KB` : "—"}
                    </td>
                    <td className="p-3 text-slate-400">{segment.status}</td>
                    <td className="p-3 text-right">
                      {segment.status === "COMPLETE" ? (
                        <div className="flex justify-end gap-3">
                          <button onClick={() => play(segment)} className="text-emerald-400 hover:underline">
                            Play
                          </button>
                          <button onClick={() => download(segment)} className="text-slate-400 hover:underline">
                            Download
                          </button>
                        </div>
                      ) : (
                        <span className="text-xs text-slate-500">not available</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {selectedSegment && (
        <section className="rounded-lg border border-slate-800 p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="text-sm font-medium text-slate-400">
              Playing segment started{" "}
              {new Date(selectedSegment.startedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC
            </h2>
            <div className="flex gap-2">
              <button
                onClick={() => playAdjacent(-1)}
                disabled={completeSegments[0]?.id === selectedSegment.id}
                className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-40"
              >
                ← Previous
              </button>
              <button
                onClick={() => playAdjacent(1)}
                disabled={completeSegments[completeSegments.length - 1]?.id === selectedSegment.id}
                className="rounded border border-slate-700 px-2 py-1 text-xs hover:bg-slate-800 disabled:opacity-40"
              >
                Next →
              </button>
            </div>
          </div>
          {playbackUrl ? (
            <video src={playbackUrl} controls autoPlay className="w-full rounded bg-black" />
          ) : (
            <p className="text-sm text-slate-400">Loading video...</p>
          )}
          <p className="mt-2 text-xs text-slate-500">
            This is a stored recording, not a live view — URLs expire after a few minutes.
          </p>
        </section>
      )}
    </div>
  );
}

const SECONDS_PER_DAY = 24 * 60 * 60;

function DayTimeline({
  date,
  segments,
  selectedId,
  onSelect,
}: {
  date: string;
  segments: RecordingSegmentSummary[];
  selectedId: string | null;
  onSelect: (segment: RecordingSegmentSummary) => void;
}) {
  const dayStart = new Date(`${date}T00:00:00.000Z`).getTime();

  return (
    <div>
      <div className="relative h-10 w-full overflow-hidden rounded border border-slate-800 bg-slate-900">
        {segments
          .filter((s) => s.status === "COMPLETE" && s.durationSec)
          .map((segment) => {
            const startOffsetSec = (new Date(segment.startedAt).getTime() - dayStart) / 1000;
            const leftPct = (startOffsetSec / SECONDS_PER_DAY) * 100;
            const widthPct = Math.max((segment.durationSec! / SECONDS_PER_DAY) * 100, 0.3);
            return (
              <button
                key={segment.id}
                onClick={() => onSelect(segment)}
                title={`${new Date(segment.startedAt).toLocaleTimeString("en-US", { timeZone: "UTC" })} UTC — ${segment.durationSec}s`}
                className={`absolute top-0 h-full ${
                  selectedId === segment.id ? "bg-emerald-400" : "bg-emerald-700 hover:bg-emerald-600"
                }`}
                style={{ left: `${leftPct}%`, width: `${widthPct}%` }}
              />
            );
          })}
      </div>
      <div className="mt-1 flex justify-between text-xs text-slate-500">
        <span>00:00</span>
        <span>06:00</span>
        <span>12:00</span>
        <span>18:00</span>
        <span>24:00</span>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        Green = recorded. Empty gaps = no recording for that time (gaps are real — nothing fills them in).
      </p>
    </div>
  );
}
