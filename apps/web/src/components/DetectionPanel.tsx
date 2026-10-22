"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  errorMessage,
  fetchCameraSnapshot,
  getDetectionConfig,
  setDetectionConfig,
  type AlertSchedule,
  type DetectionConfig,
  type DetectionZone,
  type ScheduleWindow,
} from "@/lib/api";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const ZONE_COLORS = ["#22c55e", "#3b82f6", "#f59e0b", "#ec4899", "#a855f7", "#14b8a6", "#ef4444", "#eab308"];
const input = "rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm";

/** Detection zones (drawn on a live snapshot), alert schedule and per-class
 * confidence thresholds for one camera. */
export function DetectionPanel({ cameraId, canEdit }: { cameraId: string; canEdit: boolean }) {
  const [cfg, setCfg] = useState<DetectionConfig | null>(null);
  const [zones, setZones] = useState<DetectionZone[]>([]);
  const [draft, setDraft] = useState<[number, number][]>([]);
  const [snapshot, setSnapshot] = useState<string | null>(null);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [schedule, setSchedule] = useState<AlertSchedule>({ enabled: false, windows: [] });
  const [thresholds, setThresholds] = useState<{ person: number; vehicle: number }>({ person: 0.5, vehicle: 0.5 });
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const svgRef = useRef<SVGSVGElement>(null);

  useEffect(() => {
    getDetectionConfig(cameraId)
      .then((c) => {
        setCfg(c);
        setZones(c.zones);
        setSchedule(c.schedule ?? { enabled: false, windows: [] });
        setThresholds({ person: c.thresholds.person ?? c.defaultThreshold, vehicle: c.thresholds.vehicle ?? c.defaultThreshold });
      })
      .catch((err) => setMsg(errorMessage(err, "Could not load detection settings.")));
  }, [cameraId]);

  const loadSnapshot = useCallback(async () => {
    setSnapError(null);
    try {
      const url = await fetchCameraSnapshot(cameraId);
      setSnapshot((old) => {
        if (old) URL.revokeObjectURL(old);
        return url;
      });
    } catch (err) {
      setSnapError(errorMessage(err, "Could not grab a frame from the camera."));
    }
  }, [cameraId]);

  useEffect(() => {
    void loadSnapshot();
  }, [loadSnapshot]);

  function addPoint(e: React.MouseEvent<SVGSVGElement>) {
    if (!canEdit || zones.length >= 8) return;
    const r = svgRef.current!.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const y = Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
    setDraft((d) => (d.length >= 20 ? d : [...d, [Number(x.toFixed(4)), Number(y.toFixed(4))]]));
  }

  function finishZone() {
    if (draft.length < 3) return;
    const n = zones.length + 1;
    setZones([...zones, { id: `zone-${Date.now().toString(36)}`, name: `Zone ${n}`, points: draft }]);
    setDraft([]);
  }

  async function save() {
    setBusy(true);
    setMsg(null);
    try {
      const d = cfg?.defaultThreshold ?? 0.5;
      const t: { person?: number; vehicle?: number } = {};
      if (thresholds.person !== d) t.person = thresholds.person;
      if (thresholds.vehicle !== d) t.vehicle = thresholds.vehicle;
      const saved = await setDetectionConfig(cameraId, {
        zones,
        schedule: schedule.enabled || schedule.windows.length ? schedule : null,
        thresholds: Object.keys(t).length ? t : null,
      });
      setCfg(saved);
      setMsg("Saved.");
    } catch (err) {
      setMsg(errorMessage(err, "Could not save."));
    } finally {
      setBusy(false);
    }
  }

  function updateWindow(i: number, patch: Partial<ScheduleWindow>) {
    setSchedule((s) => ({ ...s, windows: s.windows.map((w, j) => (j === i ? { ...w, ...patch } : w)) }));
  }

  if (!cfg) return <section className="rounded-lg border border-slate-800 p-4 text-sm text-slate-400">{msg ?? "Loading detection settings…"}</section>;

  return (
    <section className="space-y-5 rounded-lg border border-slate-800 p-4" aria-label="Detection zones and schedule">
      <div>
        <h2 className="text-sm font-medium text-slate-400">Detection zones</h2>
        <p className="text-xs text-slate-500">
          Only motion and people/vehicles inside a zone count (a person counts where their feet are). No zones = whole frame.
          {canEdit && " Click on the image to add points, then “Finish zone”."}
        </p>
        <div className="relative mt-2 w-full max-w-2xl overflow-hidden rounded bg-black" style={{ aspectRatio: "16 / 9" }}>
          {snapshot ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={snapshot} alt="Camera snapshot" className="absolute inset-0 h-full w-full object-fill" />
          ) : (
            <div className="absolute inset-0 flex items-center justify-center text-xs text-slate-500">{snapError ?? "Loading snapshot…"}</div>
          )}
          <svg
            ref={svgRef}
            data-testid="zone-canvas"
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            className={`absolute inset-0 h-full w-full ${canEdit ? "cursor-crosshair" : ""}`}
            onClick={addPoint}
          >
            {zones.map((z, i) => (
              <polygon
                key={z.id}
                points={z.points.map((p) => p.join(",")).join(" ")}
                fill={ZONE_COLORS[i % ZONE_COLORS.length]}
                fillOpacity={0.25}
                stroke={ZONE_COLORS[i % ZONE_COLORS.length]}
                strokeWidth={0.004}
              />
            ))}
            {draft.length > 0 && (
              <polyline points={draft.map((p) => p.join(",")).join(" ")} fill="none" stroke="#fff" strokeWidth={0.004} strokeDasharray="0.01" />
            )}
            {draft.map((p, i) => (
              <circle key={i} cx={p[0]} cy={p[1]} r={0.008} fill="#fff" />
            ))}
          </svg>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-xs">
          <button onClick={() => void loadSnapshot()} className="rounded border border-slate-700 px-2 py-1">Refresh snapshot</button>
          {canEdit && (
            <>
              <button onClick={finishZone} disabled={draft.length < 3} className="rounded border border-emerald-700 px-2 py-1 text-emerald-300 disabled:opacity-40">
                Finish zone ({draft.length} pts)
              </button>
              <button onClick={() => setDraft([])} disabled={!draft.length} className="rounded border border-slate-700 px-2 py-1 disabled:opacity-40">Cancel drawing</button>
            </>
          )}
        </div>
        <ul className="mt-2 space-y-1 text-sm">
          {zones.map((z, i) => (
            <li key={z.id} className="flex items-center gap-2">
              <span className="inline-block h-3 w-3 rounded-sm" style={{ background: ZONE_COLORS[i % ZONE_COLORS.length] }} />
              <input
                aria-label="Zone name"
                disabled={!canEdit}
                maxLength={60}
                value={z.name}
                onChange={(e) => setZones(zones.map((x) => (x.id === z.id ? { ...x, name: e.target.value } : x)))}
                className={input}
              />
              {canEdit && (
                <button onClick={() => setZones(zones.filter((x) => x.id !== z.id))} className="text-xs text-red-400">Remove</button>
              )}
            </li>
          ))}
        </ul>
      </div>

      <div>
        <h2 className="text-sm font-medium text-slate-400">Alert schedule</h2>
        <p className="text-xs text-slate-500">
          When alerts are sent (workspace timezone: <span className="text-slate-300">{cfg.timezone}</span>, change it in Settings).
          Outside these times detections are still recorded, but no alert or push is sent.
          {" "}Right now alerts are <b className={cfg.alertsActiveNow ? "text-emerald-400" : "text-amber-400"}>{cfg.alertsActiveNow ? "active" : "paused"}</b>.
        </p>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input type="checkbox" disabled={!canEdit} checked={schedule.enabled} onChange={(e) => setSchedule({ ...schedule, enabled: e.target.checked })} />
          Only alert during these times
        </label>
        {schedule.windows.map((w, i) => (
          <div key={i} className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            {DAYS.map((d, di) => (
              <label key={d} className="flex items-center gap-1 text-xs">
                <input
                  type="checkbox"
                  disabled={!canEdit}
                  checked={w.days.includes(di)}
                  onChange={(e) => updateWindow(i, { days: e.target.checked ? [...w.days, di].sort() : w.days.filter((x) => x !== di) })}
                />
                {d}
              </label>
            ))}
            <input aria-label="Start time" type="time" disabled={!canEdit} value={w.start} onChange={(e) => updateWindow(i, { start: e.target.value })} className={input} />
            –
            <input aria-label="End time" type="time" disabled={!canEdit} value={w.end} onChange={(e) => updateWindow(i, { end: e.target.value })} className={input} />
            {w.end <= w.start && <span className="text-xs text-slate-500">(overnight)</span>}
            {canEdit && (
              <button onClick={() => setSchedule({ ...schedule, windows: schedule.windows.filter((_, j) => j !== i) })} className="text-xs text-red-400">Remove</button>
            )}
          </div>
        ))}
        {canEdit && (
          <button
            onClick={() => setSchedule({ ...schedule, enabled: true, windows: [...schedule.windows, { days: [1, 2, 3, 4, 5], start: "22:00", end: "06:00" }] })}
            className="mt-2 rounded border border-slate-700 px-2 py-1 text-xs"
          >
            + Add time window
          </button>
        )}
      </div>

      <div>
        <h2 className="text-sm font-medium text-slate-400">Confidence thresholds</h2>
        <p className="text-xs text-slate-500">
          Higher = fewer false alarms but may miss things. Detector: {cfg.model.name}
          {!cfg.model.enabled && " (disabled on this server)"}.
        </p>
        {(["person", "vehicle"] as const).map((k) => (
          <label key={k} className="mt-2 flex items-center gap-3 text-sm">
            <span className="w-16 capitalize">{k}</span>
            <input
              type="range"
              min={0.2}
              max={0.95}
              step={0.05}
              disabled={!canEdit}
              value={thresholds[k]}
              onChange={(e) => setThresholds({ ...thresholds, [k]: Number(e.target.value) })}
            />
            <span className="w-12 text-slate-300">{Math.round(thresholds[k] * 100)}%</span>
          </label>
        ))}
      </div>

      {canEdit && (
        <div className="flex items-center gap-3">
          <button onClick={save} disabled={busy} className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
            Save detection settings
          </button>
          {msg && <span className="text-sm text-slate-400">{msg}</span>}
        </div>
      )}
    </section>
  );
}
