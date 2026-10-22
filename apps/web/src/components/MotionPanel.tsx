"use client";

import { useEffect, useRef, useState } from "react";
import {
  errorMessage,
  getMotionSettings,
  listCameraMotionEvents,
  setMotionSettings,
  type AlertClass,
  type MotionEvent,
  type MotionSettings,
} from "@/lib/api";
import { SnapshotThumb } from "./SnapshotThumb";

const CLASS_OPTIONS: { key: AlertClass; label: string }[] = [
  { key: "person", label: "People" },
  { key: "vehicle", label: "Vehicles" },
  { key: "any", label: "Any motion" },
];

/** Motion-detection toggle, sensitivity slider and recent detections for one camera. */
export function MotionPanel({ cameraId, canEdit }: { cameraId: string; canEdit: boolean }) {
  const [settings, setSettings] = useState<MotionSettings | null>(null);
  const [sensitivity, setSensitivity] = useState(50);
  const [classes, setClasses] = useState<AlertClass[]>(["any"]);
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
          setClasses(s.alertClasses);
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
      setSettings(await setMotionSettings(cameraId, { enabled, sensitivity, alertClasses: classes }));
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
          <fieldset>
            <legend className="text-slate-400">Alert me about</legend>
            <div className="mt-1 flex flex-wrap gap-4">
              {CLASS_OPTIONS.map((o) => (
                <label key={o.key} className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    disabled={!canEdit}
                    checked={classes.includes(o.key)}
                    onChange={(e) =>
                      setClasses((prev) => (e.target.checked ? [...prev, o.key] : prev.filter((c) => c !== o.key)))
                    }
                  />
                  {o.label}
                </label>
              ))}
            </div>
          </fieldset>
          {canEdit &&
            (sensitivity !== settings.sensitivity ||
              [...classes].sort().join() !== [...settings.alertClasses].sort().join()) && (
              <button
                onClick={() => save(settings.enabled)}
                disabled={busy || classes.length === 0}
                className="text-emerald-400 hover:underline disabled:opacity-50"
              >
                {classes.length === 0 ? "Pick at least one" : "Save changes"}
              </button>
            )}
          <p className="text-xs text-slate-500">
            Higher sensitivity catches smaller movements but may alert on light changes or rain. People/vehicle
            detection runs on the server; if it isn&apos;t available you still get plain motion alerts. You get at most one
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
              <ul className="max-h-72 space-y-1 overflow-y-auto text-xs">
                {events.map((e) => (
                  <li key={e.id} className="flex items-center gap-2 rounded border border-slate-800 px-2 py-1">
                    {e.hasSnapshot && <SnapshotThumb eventId={e.id} className="h-10 w-16" />}
                    <div className="min-w-0 flex-1">
                      <p>{new Date(e.detectedAt).toLocaleString()}</p>
                      <p className="text-slate-500">
                        {e.labels === null
                          ? "motion (detector unavailable)"
                          : e.labels.length
                            ? e.labels.map((l) => `${l.label} ${Math.round(l.score * 100)}%`).join(", ")
                            : "motion, no person/vehicle"}
                      </p>
                    </div>
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
