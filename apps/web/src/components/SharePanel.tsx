"use client";

import { useCallback, useEffect, useState } from "react";
import { createShareLink, errorMessage, listShareLinks, revokeShareLink, type ShareLink } from "@/lib/api";

const EXPIRY_OPTIONS = [
  { label: "1 hour", minutes: 60 },
  { label: "24 hours", minutes: 60 * 24 },
  { label: "7 days", minutes: 60 * 24 * 7 },
  { label: "15 minutes", minutes: 15 },
];

function toLocalInput(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const STATUS_STYLE: Record<ShareLink["status"], string> = {
  active: "bg-emerald-900/60 text-emerald-300",
  expired: "bg-slate-800 text-slate-400",
  revoked: "bg-red-950 text-red-300",
  used_up: "bg-amber-950 text-amber-300",
};

/** Create and manage public share links for one camera (Operator+). */
export function SharePanel({ cameraId }: { cameraId: string }) {
  const [links, setLinks] = useState<ShareLink[]>([]);
  const [kind, setKind] = useState<"LIVE" | "CLIP">("LIVE");
  const [expiry, setExpiry] = useState(60);
  const [password, setPassword] = useState("");
  const [maxViews, setMaxViews] = useState("");
  const [label, setLabel] = useState("");
  const [start, setStart] = useState(() => toLocalInput(new Date(Date.now() - 15 * 60_000)));
  const [end, setEnd] = useState(() => toLocalInput(new Date(Date.now() - 5 * 60_000)));
  const [created, setCreated] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => {
    listShareLinks(cameraId).then((r) => setLinks(r.links)).catch(() => undefined);
  }, [cameraId]);
  useEffect(refresh, [refresh]);

  const create = async () => {
    setBusy(true);
    setError(null);
    setCreated(null);
    try {
      const r = await createShareLink(cameraId, {
        kind,
        expiresInMinutes: expiry,
        ...(kind === "CLIP" ? { clipStart: new Date(start).toISOString(), clipEnd: new Date(end).toISOString() } : {}),
        ...(password ? { password } : {}),
        ...(maxViews ? { maxViews: Number(maxViews) } : {}),
        ...(label.trim() ? { label: label.trim() } : {}),
      });
      setCreated(r.url);
      setPassword("");
      refresh();
    } catch (e) {
      setError(errorMessage(e, "Could not create link"));
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    await navigator.clipboard?.writeText(created).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const input = "rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm text-slate-100";
  return (
    <section className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/40 p-4" aria-label="Share links" data-testid="share-panel">
      <div>
        <h3 className="text-sm font-semibold text-slate-200">Share</h3>
        <p className="text-xs text-slate-400">Anyone with the link can watch only this camera (or only this clip) until it expires or you revoke it. No login needed.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-slate-400">What to share
          <select value={kind} onChange={(e) => setKind(e.target.value as "LIVE" | "CLIP")} className={`${input} block w-full`}>
            <option value="LIVE">Live view</option>
            <option value="CLIP">Recording clip</option>
          </select>
        </label>
        <label className="space-y-1 text-xs text-slate-400">Expires after
          <select value={expiry} onChange={(e) => setExpiry(Number(e.target.value))} className={`${input} block w-full`}>
            {EXPIRY_OPTIONS.map((o) => <option key={o.minutes} value={o.minutes}>{o.label}</option>)}
          </select>
        </label>
        {kind === "CLIP" && (
          <>
            <label className="space-y-1 text-xs text-slate-400">Clip start
              <input type="datetime-local" value={start} onChange={(e) => setStart(e.target.value)} className={`${input} block w-full`} />
            </label>
            <label className="space-y-1 text-xs text-slate-400">Clip end (max 1 hour)
              <input type="datetime-local" value={end} onChange={(e) => setEnd(e.target.value)} className={`${input} block w-full`} />
            </label>
          </>
        )}
        <label className="space-y-1 text-xs text-slate-400">Password (optional)
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} autoComplete="new-password" className={`${input} block w-full`} />
        </label>
        <label className="space-y-1 text-xs text-slate-400">Max views (optional)
          <input type="number" min={1} max={1000} value={maxViews} onChange={(e) => setMaxViews(e.target.value)} className={`${input} block w-full`} />
        </label>
        <label className="space-y-1 text-xs text-slate-400 sm:col-span-2">Note (only you see this)
          <input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={80} placeholder="e.g. For the insurance company" className={`${input} block w-full`} />
        </label>
      </div>
      <button onClick={create} disabled={busy} className="rounded bg-emerald-700 px-3 py-2 text-sm text-white hover:bg-emerald-600 disabled:opacity-50">
        {busy ? "Creating…" : "Create share link"}
      </button>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {created && (
        <div className="space-y-1 rounded border border-emerald-800 bg-emerald-950/30 p-3">
          <p className="text-xs text-emerald-300">Copy this link now — it is only shown once.</p>
          <div className="flex gap-2">
            <input readOnly value={created} data-testid="share-url" className={`${input} flex-1 font-mono text-xs`} onFocus={(e) => e.target.select()} />
            <button onClick={copy} className="rounded border border-slate-600 px-3 text-sm text-slate-200">{copied ? "Copied" : "Copy"}</button>
          </div>
        </div>
      )}
      {links.length > 0 && (
        <table className="w-full text-left text-xs">
          <thead className="text-slate-500">
            <tr><th className="py-1">Type</th><th>Note</th><th>Views</th><th>Expires</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id} className="border-t border-slate-800 text-slate-300">
                <td className="py-1">{l.kind === "LIVE" ? "Live" : "Clip"}{l.hasPassword ? " 🔒" : ""}</td>
                <td>{l.label ?? "—"}</td>
                <td>{l.viewCount}{l.maxViews ? ` / ${l.maxViews}` : ""}</td>
                <td>{new Date(l.expiresAt).toLocaleString()}</td>
                <td><span className={`rounded px-2 py-0.5 ${STATUS_STYLE[l.status]}`}>{l.status.replace("_", " ")}</span></td>
                <td className="text-right">
                  {l.status === "active" && (
                    <button onClick={() => revokeShareLink(l.id).then(refresh).catch((e) => setError(errorMessage(e, "Could not revoke")))} className="text-red-400 hover:underline">Revoke</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
