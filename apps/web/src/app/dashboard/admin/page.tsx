"use client";

import { useCallback, useEffect, useState } from "react";
import {
  adminAudit,
  adminCameras,
  adminSetSuspended,
  adminStats,
  adminTenants,
  adminUsers,
  errorMessage,
  type AdminAuditEntry,
  type AdminCamera,
  type AdminStats,
  type AdminTenant,
  type AdminUser,
} from "@/lib/api";
import { useSession } from "@/lib/useSession";

type Tab = "overview" | "workspaces" | "users" | "cameras" | "audit";
const TABS: { key: Tab; label: string }[] = [
  { key: "overview", label: "Overview" },
  { key: "workspaces", label: "Workspaces" },
  { key: "users", label: "Users" },
  { key: "cameras", label: "Cameras" },
  { key: "audit", label: "Audit log" },
];

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

const card = "rounded border border-slate-800 bg-slate-900 p-4";
const btn = "rounded border px-2 py-1 text-xs";

function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className={card}>
      <p className="text-xs uppercase text-slate-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold">{value}</p>
      {sub && <p className="text-xs text-slate-400">{sub}</p>}
    </div>
  );
}

function SuspendButton({ kind, id, suspended, name, onDone, disabled }: {
  kind: "tenants" | "users"; id: string; suspended: boolean; name: string; onDone: () => void; disabled?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  async function run() {
    let reason: string | undefined;
    if (!suspended) {
      reason = window.prompt(`Reason for suspending ${name}? (recorded in the audit log)`)?.trim();
      if (!reason) return;
    } else if (!window.confirm(`Restore access for ${name}?`)) return;
    setBusy(true);
    try {
      await adminSetSuspended(kind, id, !suspended, reason);
      onDone();
    } catch (err) {
      window.alert(errorMessage(err, "Action failed."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <button
      onClick={run}
      disabled={busy || disabled}
      className={`${btn} ${suspended ? "border-emerald-700 text-emerald-300" : "border-red-800 text-red-300"} disabled:opacity-40`}
    >
      {suspended ? "Unsuspend" : "Suspend"}
    </button>
  );
}

function useList<T>(fetcher: (q: string, page: number) => Promise<{ total: number } & Record<string, unknown>>, key: string) {
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: T[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      const r = await fetcher(q, page);
      setData({ items: r[key] as T[], total: r.total });
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load."));
    }
  }, [fetcher, key, q, page]);
  useEffect(() => {
    void load();
  }, [load]);
  return { q, setQ: (v: string) => { setQ(v); setPage(1); }, page, setPage, data, error, reload: load };
}

function Pager({ page, total, setPage }: { page: number; total: number; setPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / 25));
  return (
    <div className="mt-3 flex items-center gap-2 text-xs text-slate-400">
      <button className={`${btn} border-slate-700`} disabled={page <= 1} onClick={() => setPage(page - 1)}>Prev</button>
      <span>Page {page} / {pages} · {total} total</span>
      <button className={`${btn} border-slate-700`} disabled={page >= pages} onClick={() => setPage(page + 1)}>Next</button>
    </div>
  );
}

function Search({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className="mb-3 w-full max-w-sm rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm"
    />
  );
}

function Overview() {
  const [s, setS] = useState<AdminStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    adminStats().then(setS).catch((e) => setError(errorMessage(e, "Could not load stats.")));
  }, []);
  if (error) return <p className="text-red-400">{error}</p>;
  if (!s) return <p className="text-slate-400">Loading…</p>;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="Workspaces" value={s.tenants.total} sub={`${s.tenants.suspended} suspended`} />
      <Stat label="Users" value={s.users.total} sub={`${s.users.suspended} suspended`} />
      <Stat label="Cameras" value={s.cameras.total} sub={`${s.cameras.recording} recording now`} />
      <Stat label="Storage" value={formatBytes(s.storage.bytes)} sub={`${s.recordings.segments} recording segments`} />
      <Stat label="Alerts" value={s.alerts.total} sub={`${s.alerts.last24h} in last 24h`} />
      <Stat label="Active sessions" value={s.sessions.active} sub={`${s.sessions.mobile} mobile`} />
    </div>
  );
}

function Workspaces() {
  const l = useList<AdminTenant>(adminTenants, "tenants");
  return (
    <div>
      <Search value={l.q} onChange={l.setQ} placeholder="Search workspaces" />
      {l.error && <p className="text-red-400">{l.error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500">
            <tr><th className="p-2">Name</th><th>Members</th><th>Cameras</th><th>Storage</th><th>Alerts</th><th>Created</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {l.data?.items.map((t) => (
              <tr key={t.id} className="border-t border-slate-800">
                <td className="p-2">{t.name}</td>
                <td>{t.members}</td>
                <td>{t.cameras}</td>
                <td>{formatBytes(t.storageBytes)}</td>
                <td>{t.alerts}</td>
                <td>{new Date(t.createdAt).toLocaleDateString()}</td>
                <td>{t.suspendedAt ? <span className="text-red-400" title={t.suspendedReason ?? ""}>Suspended</span> : <span className="text-emerald-400">Active</span>}</td>
                <td><SuspendButton kind="tenants" id={t.id} name={t.name} suspended={!!t.suspendedAt} onDone={l.reload} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {l.data && <Pager page={l.page} total={l.data.total} setPage={l.setPage} />}
    </div>
  );
}

function Users({ selfId }: { selfId: string }) {
  const l = useList<AdminUser>(adminUsers, "users");
  return (
    <div>
      <Search value={l.q} onChange={l.setQ} placeholder="Search by email or name" />
      {l.error && <p className="text-red-400">{l.error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500">
            <tr><th className="p-2">Email</th><th>Workspaces</th><th>Sessions</th><th>Created</th><th>Status</th><th /></tr>
          </thead>
          <tbody>
            {l.data?.items.map((u) => (
              <tr key={u.id} className="border-t border-slate-800">
                <td className="p-2">
                  {u.email}
                  {u.isPlatformAdmin && <span className="ml-2 rounded bg-violet-900 px-1 text-xs text-violet-200">platform admin</span>}
                </td>
                <td className="text-xs text-slate-400">{u.workspaces.map((w) => `${w.name} (${w.role.toLowerCase()})`).join(", ") || "—"}</td>
                <td>{u.activeSessions}</td>
                <td>{new Date(u.createdAt).toLocaleDateString()}</td>
                <td>{u.suspendedAt ? <span className="text-red-400" title={u.suspendedReason ?? ""}>Suspended</span> : <span className="text-emerald-400">Active</span>}</td>
                <td>
                  <SuspendButton kind="users" id={u.id} name={u.email} suspended={!!u.suspendedAt} onDone={l.reload}
                    disabled={u.id === selfId || (u.isPlatformAdmin && !u.suspendedAt)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {l.data && <Pager page={l.page} total={l.data.total} setPage={l.setPage} />}
    </div>
  );
}

function Cameras() {
  const l = useList<AdminCamera>(adminCameras, "cameras");
  return (
    <div>
      <Search value={l.q} onChange={l.setQ} placeholder="Search cameras" />
      {l.error && <p className="text-red-400">{l.error}</p>}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="text-xs text-slate-500">
            <tr><th className="p-2">Camera</th><th>Workspace</th><th>Type</th><th>Recording</th><th>Motion</th><th>Events</th></tr>
          </thead>
          <tbody>
            {l.data?.items.map((c) => (
              <tr key={c.id} className="border-t border-slate-800">
                <td className="p-2">{c.name}<span className="block text-xs text-slate-500">{[c.manufacturer, c.model].filter(Boolean).join(" ")}</span></td>
                <td>{c.tenant.name}{c.tenant.suspendedAt && <span className="ml-1 text-xs text-red-400">(suspended)</span>}</td>
                <td>{c.connectorType}</td>
                <td>{c.recording ? "● yes" : "no"}</td>
                <td>{c.motionEnabled ? "on" : "off"}</td>
                <td>{c.motionEvents}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {l.data && <Pager page={l.page} total={l.data.total} setPage={l.setPage} />}
    </div>
  );
}

function Audit() {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AdminAuditEntry[] | null>(null);
  useEffect(() => {
    adminAudit(page).then((r) => setRows(r.entries)).catch(() => setRows([]));
  }, [page]);
  if (!rows) return <p className="text-slate-400">Loading…</p>;
  return (
    <div>
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-slate-500"><tr><th className="p-2">When</th><th>Admin</th><th>Action</th><th>Target</th><th>Details</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-slate-800">
              <td className="p-2 whitespace-nowrap">{new Date(r.createdAt).toLocaleString()}</td>
              <td>{r.actorEmail ?? "CLI"}</td>
              <td className="font-mono text-xs">{r.action}</td>
              <td className="text-xs">{r.targetType} {String(r.metadata?.name ?? r.metadata?.email ?? r.targetId)}</td>
              <td className="text-xs text-slate-400">{r.metadata?.reason ? String(r.metadata.reason) : ""}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length === 0 && <p className="mt-2 text-slate-400">No admin actions yet.</p>}
      <div className="mt-3 flex gap-2">
        <button className={`${btn} border-slate-700`} disabled={page <= 1} onClick={() => setPage(page - 1)}>Newer</button>
        <button className={`${btn} border-slate-700`} disabled={rows.length < 25} onClick={() => setPage(page + 1)}>Older</button>
      </div>
    </div>
  );
}

export default function PlatformAdminPage() {
  const session = useSession();
  const [tab, setTab] = useState<Tab>("overview");
  if (session.status !== "authenticated") return null;
  if (!session.session.user.isPlatformAdmin) {
    return <p className="text-slate-400">This page is only for platform administrators.</p>;
  }
  return (
    <div>
      <h1 className="text-xl font-semibold">Platform admin</h1>
      <p className="mb-4 text-sm text-slate-400">All workspaces on this deployment. Every action here is recorded in the audit log.</p>
      <div className="mb-4 flex flex-wrap gap-2">
        {TABS.map((t) => (
          <button key={t.key} onClick={() => setTab(t.key)}
            className={`rounded px-3 py-1 text-sm ${tab === t.key ? "bg-violet-800 text-white" : "border border-slate-700 text-slate-300"}`}>
            {t.label}
          </button>
        ))}
      </div>
      {tab === "overview" && <Overview />}
      {tab === "workspaces" && <Workspaces />}
      {tab === "users" && <Users selfId={session.session.user.id} />}
      {tab === "cameras" && <Cameras />}
      {tab === "audit" && <Audit />}
    </div>
  );
}
