"use client";

import { useEffect, useRef, useState } from "react";
import {
  errorMessage,
  getMotionSettings,
  listCameraMotionEvents,
  setMotionSettings,
  type MotionEvent,
  type MotionSettings,
} from "@/lib/api";

/** Motion-detection toggle, sensitivity slider and recent detections for one camera. */
export function MotionPanel({ cameraId, canEdit }: { cameraId: string; canEdit: boolean }) {
  const [settings, setSettings] = useState<MotionSettings | null>(null);
  const [sensitivity, setSensitivity] = useState(50);
  const [events, setEvents] = useState<MotionEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Periodic refreshes must not overwrite a slider value the user is editing.
  const sliderInitialized = useRef(false);

  useEffect(() => {
    let alive = true;
    async function load() {
      try {
        const [s, e] = await Promise.all([getMotionSettings(cameraId), listCameraMotionEvents(cameraId)]);
        if (!alive) return;
        setSettings(s);
        if (!sliderInitialized.current) {
          setSensitivity(s.sensitivity);
          sliderInitialized.current = true;
        }
        setEvents(e.events);
      } catch (err) {
        if (alive) setError(errorMessage(err, "Could not load motion settings."));
      }
    }
    load();
    const t = setInterval(load, 15000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [cameraId]);

  async function save(enabled: boolean) {
    setBusy(true);
    setError(null);
    try {
      setSettings(await setMotionSettings(cameraId, { enabled, sensitivity }));
    } catch (err) {
      setError(errorMessage(err, "Could not save motion settings."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-lg border border-slate-800 p-4">
      <h2 className="mb-3 text-sm font-medium text-slate-400">Motion detection</h2>
      {!settings && !error && <p className="text-sm text-slate-400">Loading...</p>}
      {error && <p className="mb-2 text-sm text-red-400">{error}</p>}
      {settings && (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <span className={settings.enabled ? "text-emerald-400" : "text-slate-400"}>
              {settings.enabled ? "On" : "Off"}
            </span>
            {canEdit && (
              <button
                onClick={() => save(!settings.enabled)}
                disabled={busy}
                className={`rounded px-3 py-1.5 text-sm font-medium disabled:opacity-50 ${
                  settings.enabled ? "border border-slate-700 text-slate-300" : "bg-emerald-600 text-white"
                }`}
              >
                {settings.enabled ? "Turn off" : "Turn on"}
              </button>
            )}
          </div>
          <label className="block">
            <span className="text-slate-400">
              Sensitivity: <span className="text-slate-200">{sensitivity}</span> / 100
            </span>
            <input
              type="range"
              min={1}
              max={100}
              value={sensitivity}
              disabled={!canEdit}
              onChange={(e) => setSensitivity(Number(e.target.value))}
              className="mt-1 w-full"
            />
          </label>
          {canEdit && sensitivity !== settings.sensitivity && (
            <button onClick={() => save(settings.enabled)} disabled={busy} className="text-emerald-400 hover:underline">
              Save sensitivity
            </button>
          )}
          <p className="text-xs text-slate-500">
            Higher sensitivity catches smaller movements but may alert on light changes or rain. You get at most one
            &quot;Motion detected&quot; alert every few minutes per camera; every detection is listed below.
            {settings.lastCheckedAt && <> Last checked {new Date(settings.lastCheckedAt).toLocaleString()}.</>}
          </p>
          {settings.enabled && settings.lastError && (
            <p className="text-xs text-amber-400">Last check failed: {settings.lastError}</p>
          )}
          <div>
            <h3 className="mb-1 text-xs font-medium uppercase text-slate-500">Recent detections</h3>
            {events.length === 0 ? (
              <p className="text-xs text-slate-500">No motion detected yet.</p>
            ) : (
              <ul className="max-h-48 space-y-1 overflow-y-auto text-xs">
                {events.map((e) => (
                  <li key={e.id} className="flex justify-between gap-2 rounded border border-slate-800 px-2 py-1">
                    <span>{new Date(e.detectedAt).toLocaleString()}</span>
                    <span className="text-slate-500">score {e.score.toFixed(3)}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
