"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { errorMessage, getRetention, setCameraRetention, setWorkspaceRetention, type RetentionInfo } from "@/lib/api";

function formatBytes(bytesStr: string): string {
  const bytes = Number(bytesStr);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

const input = "w-24 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-sm";

export default function StoragePage() {
  const [info, setInfo] = useState<RetentionInfo | null>(null);
  const [wsDays, setWsDays] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await getRetention();
      setInfo(r);
      setWsDays(r.workspaceRetentionDays?.toString() ?? "");
    } catch {
      setError("Could not load storage and retention.");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function parseDays(v: string): number | null | "invalid" {
    if (v.trim() === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= 1 && n <= 3650 ? n : "invalid";
  }

  async function saveWorkspace(e: React.FormEvent) {
    e.preventDefault();
    const days = parseDays(wsDays);
    if (days === "invalid") return setMsg("Enter whole days between 1 and 3650, or leave empty.");
    try {
      await setWorkspaceRetention(days);
      setMsg("Saved. Older recordings are removed on the next cleanup run (within a minute or so).");
      await load();
    } catch (err) {
      setMsg(errorMessage(err, "Could not save."));
    }
  }

  async function saveCamera(cameraId: string, value: string) {
    const days = parseDays(value);
    if (days === "invalid") return setMsg("Enter whole days between 1 and 3650, or leave empty to use the workspace setting.");
    try {
      await setCameraRetention(cameraId, days);
      setMsg("Camera retention saved.");
      await load();
    } catch (err) {
      setMsg(errorMessage(err, "Could not save."));
    }
  }

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Storage &amp; retention</h1>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {info && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-800 p-4">
              <p className="text-xs text-slate-400">Total storage in use</p>
              <p className="mt-1 text-2xl font-semibold">{formatBytes(info.totalBytes)}</p>
              <p className="mt-2 text-xs text-slate-500">Recordings currently kept in cloud storage.</p>
            </div>
            <form onSubmit={saveWorkspace} className="space-y-2 rounded-lg border border-slate-800 p-4">
              <label className="block text-xs text-slate-400" htmlFor="ws-days">
                Keep recordings for (whole workspace)
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  id="ws-days"
                  inputMode="numeric"
                  placeholder="policy"
                  value={wsDays}
                  disabled={!info.canEdit}
                  onChange={(e) => setWsDays(e.target.value)}
                  className={input}
                />
                <span className="text-sm text-slate-400">days</span>
                {info.canEdit && <button className="rounded bg-emerald-600 px-3 py-1 text-sm text-white">Save</button>}
              </div>
              <p className="text-xs text-slate-500">
                Empty = use each camera&apos;s retention policy.
                {info.planMaxRetentionDays !== null && <> Your plan allows up to {info.planMaxRetentionDays} days.</>}
                {!info.canEdit && <> Only owners and admins can change this.</>}
              </p>
            </form>
          </div>
          {msg && <p className="text-sm text-slate-300">{msg}</p>}

          {info.cameras.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-700 p-8 text-center text-slate-400">No cameras yet.</div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="border-b border-slate-800 text-slate-400">
                  <tr>
                    <th className="p-3">Camera</th>
                    <th className="p-3">Storage used</th>
                    <th className="p-3">Oldest recording</th>
                    <th className="p-3">Keep for (override)</th>
                  </tr>
                </thead>
                <tbody>
                  {info.cameras.map((c) => (
                    <CameraRow key={c.cameraId} c={c} canEdit={info.canEdit} onSave={saveCamera} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function CameraRow({
  c,
  canEdit,
  onSave,
}: {
  c: RetentionInfo["cameras"][number];
  canEdit: boolean;
  onSave: (id: string, v: string) => void;
}) {
  const [v, setV] = useState(c.overrideDays?.toString() ?? "");
  return (
    <tr className="border-b border-slate-900">
      <td className="p-3">
        <Link href={`/dashboard/cameras/${c.cameraId}`} className="text-emerald-400 hover:underline">
          {c.cameraName}
        </Link>
      </td>
      <td className="p-3 text-slate-400">
        {formatBytes(c.bytes)} <span className="text-xs">({c.segmentCount} segments)</span>
      </td>
      <td className="p-3 text-slate-400">{c.oldestRecordingAt ? new Date(c.oldestRecordingAt).toLocaleDateString() : "—"}</td>
      <td className="p-3">
        <div className="flex items-center gap-2">
          <input
            aria-label={`Retention days for ${c.cameraName}`}
            inputMode="numeric"
            placeholder={c.effectiveDays ? `${c.effectiveDays}` : "policy"}
            value={v}
            disabled={!canEdit}
            onChange={(e) => setV(e.target.value)}
            className={input}
          />
          {canEdit && v !== (c.overrideDays?.toString() ?? "") && (
            <button onClick={() => onSave(c.cameraId, v)} className="text-xs text-emerald-400 hover:underline">
              Save
            </button>
          )}
        </div>
        <p className="mt-1 text-xs text-slate-500">
          {c.overrideDays ? "camera override" : c.effectiveDays ? `workspace: ${c.effectiveDays} days` : "uses policy"}
        </p>
      </td>
    </tr>
  );
}
