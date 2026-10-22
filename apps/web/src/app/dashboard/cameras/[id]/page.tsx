"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { LivePlayer } from "@/components/LivePlayer";
import { useParams, useRouter } from "next/navigation";
import {
  ApiError,
  deleteCamera,
  getCamera,
  getRecordingStatus,
  listRetentionPolicies,
  startRecording,
  stopRecording,
  testCameraConnection,
  updateCameraRetentionPolicy,
  type Camera,
  type RecordingStatus,
  type RetentionPolicy,
  type TestConnectionResult,
} from "@/lib/api";

type State = { status: "loading" } | { status: "error" } | { status: "ready"; camera: Camera };

const CAPABILITY_LABELS: Record<string, string> = {
  liveView: "Live view",
  cloudRecording: "Cloud recording",
  playback: "Playback",
  ptz: "PTZ control",
  zoom: "Zoom",
  motionEvents: "Motion events",
  imageSettings: "Image settings",
  audio: "Audio",
  firmwareUpdate: "Firmware update",
};

export default function CameraDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const [state, setState] = useState<State>({ status: "loading" });
  const [deleting, setDeleting] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestConnectionResult | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const [recording, setRecording] = useState<RecordingStatus | null>(null);
  const [recordingBusy, setRecordingBusy] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [policies, setPolicies] = useState<RetentionPolicy[] | null>(null);
  const [savingPolicy, setSavingPolicy] = useState(false);

  async function load() {
    try {
      const camera = await getCamera(params.id);
      setState({ status: "ready", camera });
    } catch {
      setState({ status: "error" });
    }
  }

  useEffect(() => {
    listRetentionPolicies()
      .then((res) => setPolicies(res.policies))
      .catch(() => {
        /* non-fatal — retention section just won't render a selector */
      });
  }, []);

  async function onChangeRetentionPolicy(policyId: string) {
    setSavingPolicy(true);
    try {
      await updateCameraRetentionPolicy(params.id, policyId);
      await load();
    } catch {
      alert("Could not update the retention policy.");
    } finally {
      setSavingPolicy(false);
    }
  }

  async function loadRecordingStatus() {
    try {
      setRecording(await getRecordingStatus(params.id));
    } catch {
      // Non-fatal — the rest of the page still works without this.
    }
  }

  useEffect(() => {
    load();
    loadRecordingStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.id]);

  useEffect(() => {
    if (!recording?.active) return;
    // Poll while actively recording so the segment count updates live —
    // matches the background worker's own 15s ingestion interval.
    const interval = setInterval(loadRecordingStatus, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recording?.active]);

  async function onDelete() {
    if (!confirm("Delete this camera? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await deleteCamera(params.id);
      router.push("/dashboard/cameras");
    } catch {
      alert("Could not delete the camera.");
      setDeleting(false);
    }
  }

  async function onTestConnection() {
    setTesting(true);
    setTestError(null);
    setTestResult(null);
    try {
      const result = await testCameraConnection(params.id);
      setTestResult(result);
      await load(); // refresh the camera's stored capability record to match
    } catch (err) {
      setTestError(err instanceof ApiError ? "The test request failed." : "Could not reach the server.");
    } finally {
      setTesting(false);
    }
  }

  async function onStartRecording() {
    setRecordingBusy(true);
    setRecordingError(null);
    try {
      await startRecording(params.id, 60);
      await loadRecordingStatus();
    } catch (err) {
      setRecordingError(
        err instanceof ApiError && err.status === 502
          ? "Could not reach the camera to start recording."
          : "Could not start recording.",
      );
    } finally {
      setRecordingBusy(false);
    }
  }

  async function onStopRecording() {
    setRecordingBusy(true);
    setRecordingError(null);
    try {
      await stopRecording(params.id);
      await loadRecordingStatus();
    } catch {
      setRecordingError("Could not stop recording cleanly — check server logs.");
    } finally {
      setRecordingBusy(false);
    }
  }

  if (state.status === "loading") return <p className="text-slate-400">Loading...</p>;
  if (state.status === "error") return <p className="text-red-400">Camera not found.</p>;

  const { camera } = state;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{camera.name}</h1>
        <div className="flex gap-2">
          <button
            onClick={onTestConnection}
            disabled={testing}
            className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
          >
            {testing ? "Testing..." : "Test Connection"}
          </button>
          <button
            onClick={onDelete}
            disabled={deleting}
            className="rounded border border-red-800 px-3 py-2 text-sm text-red-400 hover:bg-red-950 disabled:opacity-50"
          >
            {deleting ? "Deleting..." : "Delete"}
          </button>
        </div>
      </div>

      <LivePlayer cameraId={camera.id} name={`${camera.name} — live`} />

      {testError && <p className="text-sm text-red-400">{testError}</p>}

      {testResult && (
        <div
          className={`rounded-lg border p-4 text-sm ${
            testResult.ok ? "border-emerald-800 bg-emerald-950/30" : "border-red-800 bg-red-950/30"
          }`}
        >
          {testResult.ok ? (
            <>
              <p className="font-medium text-emerald-300">Connected successfully.</p>
              <p className="mt-1 text-slate-300">
                Found {testResult.streams.length} stream{testResult.streams.length === 1 ? "" : "s"}:{" "}
                {testResult.streams
                  .map((s) => `${s.codecType} (${s.codecName}${s.width ? `, ${s.width}x${s.height}` : ""})`)
                  .join(", ")}
              </p>
            </>
          ) : (
            <>
              <p className="font-medium text-red-300">Connection failed.</p>
              <p className="mt-1 text-slate-300">{testResult.error?.message}</p>
            </>
          )}
        </div>
      )}

      <section className="rounded-lg border border-slate-800 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-medium text-slate-400">Recording</h2>
          {recording?.active ? (
            <button
              onClick={onStopRecording}
              disabled={recordingBusy}
              className="rounded border border-red-800 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950 disabled:opacity-50"
            >
              {recordingBusy ? "Stopping..." : "Stop Recording"}
            </button>
          ) : (
            <button
              onClick={onStartRecording}
              disabled={recordingBusy}
              className="rounded bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
            >
              {recordingBusy ? "Starting..." : "Start Recording"}
            </button>
          )}
        </div>

        {recordingError && <p className="mb-2 text-sm text-red-400">{recordingError}</p>}

        {recording?.active ? (
          <p className="text-sm text-emerald-300">
            Recording since {recording.startedAt ? new Date(recording.startedAt).toLocaleTimeString() : "—"} —{" "}
            {recording.segmentCount} segment{recording.segmentCount === 1 ? "" : "s"} saved so far
            (~{recording.segmentSeconds}s each).
          </p>
        ) : (
          <p className="text-sm text-slate-400">Not currently recording.</p>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Recordings upload to cloud storage via a background worker that runs separately
          (<code>pnpm --filter @cctv/api worker</code> in local dev) — see docs/video-recording.md.
          Visit the <Link href="/dashboard/recordings" className="underline">Recordings</Link> page to
          play back what's been saved.
        </p>
      </section>

      <section className="rounded-lg border border-slate-800 p-4">
        <h2 className="mb-3 text-sm font-medium text-slate-400">Connection</h2>
        <dl className="grid grid-cols-2 gap-y-2 text-sm">
          <dt className="text-slate-400">Connector type</dt>
          <dd>{camera.connectorType}</dd>
          <dt className="text-slate-400">Host</dt>
          <dd>
            {camera.host}:{camera.port}
          </dd>
          <dt className="text-slate-400">ONVIF port</dt>
          <dd>{camera.onvifPort ?? "—"}</dd>
          <dt className="text-slate-400">Credential stored</dt>
          <dd>{camera.hasCredential ? "Yes (encrypted)" : "No"}</dd>
        </dl>
        <p className="mt-3 text-xs text-slate-500">
          "Test Connection" probes the RTSP stream, and for ONVIF cameras also connects to the
          device's ONVIF service to check its real PTZ/motion-event/imaging/firmware capabilities.
          No physical ONVIF camera has been tested against this build yet — don't assume a specific
          model/firmware works until it's been verified and documented.
        </p>
      </section>

      <section className="rounded-lg border border-slate-800 p-4">
        <h2 className="mb-3 text-sm font-medium text-slate-400">Retention</h2>
        {policies ? (
          <label className="block space-y-1">
            <span className="text-sm text-slate-400">Delete recordings after</span>
            <select
              value={camera.retentionPolicyId ?? ""}
              onChange={(e) => onChangeRetentionPolicy(e.target.value)}
              disabled={savingPolicy}
              className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm disabled:opacity-50"
            >
              {!camera.retentionPolicyId && <option value="">No policy set</option>}
              {policies.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.isDefault ? " (tenant default)" : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <p className="text-sm text-slate-400">Loading retention policies...</p>
        )}
        <p className="mt-2 text-xs text-slate-500">
          Applies to recordings made after this is changed — existing segments keep whatever policy
          was in effect when they were recorded. A camera with no policy keeps its recordings
          indefinitely until one is set; it's never auto-deleted "just in case."
        </p>
      </section>

      <section className="rounded-lg border border-slate-800 p-4">
        <h2 className="mb-3 text-sm font-medium text-slate-400">Capabilities</h2>
        <p className="mb-3 text-xs text-slate-500">
          Support tier: <span className="text-slate-300">{camera.capability?.supportTier ?? "UNSUPPORTED"}</span>
          {camera.capability && (
            <> — last checked {new Date(camera.capability.detectedAt).toLocaleString()}</>
          )}
        </p>
        <ul className="grid grid-cols-2 gap-2 text-sm">
          {Object.entries(CAPABILITY_LABELS).map(([key, label]) => {
            const supported = camera.capability
              ? Boolean((camera.capability as unknown as Record<string, unknown>)[key])
              : false;
            return (
              <li
                key={key}
                className={`flex items-center justify-between rounded border px-3 py-2 ${
                  supported ? "border-emerald-800 text-emerald-300" : "border-slate-800 text-slate-500"
                }`}
                title={supported ? undefined : "Not confirmed supported for this camera"}
              >
                <span>{label}</span>
                <span className="text-xs">{supported ? "Supported" : "Not confirmed"}</span>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
