"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { deleteCamera, getCamera, type Camera } from "@/lib/api";

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

  useEffect(() => {
    getCamera(params.id)
      .then((camera) => setState({ status: "ready", camera }))
      .catch(() => setState({ status: "error" }));
  }, [params.id]);

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

  if (state.status === "loading") return <p className="text-slate-400">Loading...</p>;
  if (state.status === "error") return <p className="text-red-400">Camera not found.</p>;

  const { camera } = state;

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">{camera.name}</h1>
        <button
          onClick={onDelete}
          disabled={deleting}
          className="rounded border border-red-800 px-3 py-2 text-sm text-red-400 hover:bg-red-950 disabled:opacity-50"
        >
          {deleting ? "Deleting..." : "Delete"}
        </button>
      </div>

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
        {!camera.connectionImplemented && (
          <p className="mt-3 text-xs text-amber-400">
            No connector has actually connected to this camera yet — RTSP/ONVIF connectivity is Phase 4,
            not implemented.
          </p>
        )}
      </section>

      <section className="rounded-lg border border-slate-800 p-4">
        <h2 className="mb-3 text-sm font-medium text-slate-400">Capabilities</h2>
        <p className="mb-3 text-xs text-slate-500">
          Support tier: <span className="text-slate-300">{camera.capability?.supportTier ?? "UNSUPPORTED"}</span> —
          nothing below has actually been confirmed yet (capability detection is Phase 4).
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
