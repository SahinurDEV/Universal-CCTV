"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity, ArrowLeft, Bell, Building2, Camera, ChevronLeft, ChevronRight, HardDrive, LayoutDashboard,
  Menu, Moon, ScrollText, Search, ShieldCheck, Sun, TrendingDown, TrendingUp, Users, X,
} from "lucide-react";
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from "recharts";
import {
  adminAudit, adminCameras, adminSetSuspended, adminStats, adminTenants, adminTimeseries, adminUsers, errorMessage,
  type AdminAuditEntry, type AdminCamera, type AdminListParams, type AdminStats, type AdminStatusFilter, type AdminTenant,
  type AdminTimeseries, type AdminUser,
} from "@/lib/api";

type Section = "overview" | "workspaces" | "users" | "cameras" | "audit";
const NAV: { key: Section; label: string; icon: typeof LayoutDashboard }[] = [
  { key: "overview", label: "Overview", icon: LayoutDashboard },
  { key: "workspaces", label: "Workspaces", icon: Building2 },
  { key: "users", label: "Users", icon: Users },
  { key: "cameras", label: "Cameras", icon: Camera },
  { key: "audit", label: "Audit log", icon: ScrollText },
];
const PAGE_SIZE = 25;

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
const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
const fmtDate = (d: string) => new Date(d).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

// ---------------------------------------------------------------- primitives

function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(" ");
}

const surface = "rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900/70";

function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx(surface, className)}>{children}</div>;
}

const AVATAR_COLORS = ["bg-violet-500", "bg-sky-500", "bg-emerald-500", "bg-amber-500", "bg-rose-500", "bg-indigo-500", "bg-teal-500", "bg-fuchsia-500"];
function Avatar({ name, square }: { name: string; square?: boolean }) {
  const initials = name.replace(/@.*/, "").split(/[\s._-]+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("") || "?";
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return (
    <span className={cx("inline-flex h-9 w-9 shrink-0 items-center justify-center text-xs font-semibold text-white", square ? "rounded-lg" : "rounded-full", AVATAR_COLORS[h % AVATAR_COLORS.length])}>
      {initials}
    </span>
  );
}

type Tone = "green" | "red" | "violet" | "slate" | "amber" | "sky";
const TONES: Record<Tone, string> = {
  green: "bg-emerald-50 text-emerald-700 ring-emerald-600/20 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-emerald-400/20",
  red: "bg-rose-50 text-rose-700 ring-rose-600/20 dark:bg-rose-500/10 dark:text-rose-300 dark:ring-rose-400/20",
  violet: "bg-violet-50 text-violet-700 ring-violet-600/20 dark:bg-violet-500/10 dark:text-violet-300 dark:ring-violet-400/20",
  slate: "bg-slate-100 text-slate-600 ring-slate-500/20 dark:bg-slate-500/10 dark:text-slate-300 dark:ring-slate-400/20",
  amber: "bg-amber-50 text-amber-700 ring-amber-600/20 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-amber-400/20",
  sky: "bg-sky-50 text-sky-700 ring-sky-600/20 dark:bg-sky-500/10 dark:text-sky-300 dark:ring-sky-400/20",
};
function Badge({ tone, children, dot, title }: { tone: Tone; children: ReactNode; dot?: boolean; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset", TONES[tone])}>
      {dot && <span className="h-1.5 w-1.5 rounded-full bg-current" />}
      {children}
    </span>
  );
}
const StatusBadge = ({ suspended, reason }: { suspended: boolean; reason?: string | null }) =>
  suspended ? <Badge tone="red" dot title={reason ?? undefined}>Suspended</Badge> : <Badge tone="green" dot>Active</Badge>;

function Trend({ value }: { value: number | null | undefined }) {
  if (value === undefined) return null;
  if (value === null) return <span className="text-xs font-medium text-emerald-600 dark:text-emerald-400">new</span>;
  const up = value > 0;
  const flat = value === 0;
  const Icon = up ? TrendingUp : TrendingDown;
  return (
    <span className={cx("inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium",
      flat ? "bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400" : up ? "bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-300" : "bg-rose-50 text-rose-700 dark:bg-rose-500/10 dark:text-rose-300")}>
      {!flat && <Icon className="h-3 w-3" />}
      {flat ? "0%" : `${up ? "+" : ""}${value}%`}
    </span>
  );
}

function Kpi({ icon: Icon, label, value, sub, trend, tone }: {
  icon: typeof Camera; label: string; value: string | number; sub: string; trend?: number | null; tone: string;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between">
        <span className={cx("inline-flex h-10 w-10 items-center justify-center rounded-xl", tone)}><Icon className="h-5 w-5" /></span>
        <Trend value={trend} />
      </div>
      <p className="mt-4 text-sm text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">{value}</p>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{sub}</p>
    </Card>
  );
}

function Btn({ children, onClick, disabled, variant = "ghost", className }: {
  children: ReactNode; onClick?: () => void; disabled?: boolean; variant?: "ghost" | "danger" | "success" | "primary"; className?: string;
}) {
  const v = {
    ghost: "border border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:text-slate-200 dark:hover:bg-slate-800",
    danger: "border border-rose-200 text-rose-700 hover:bg-rose-50 dark:border-rose-500/30 dark:text-rose-300 dark:hover:bg-rose-500/10",
    success: "border border-emerald-200 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-500/30 dark:text-emerald-300 dark:hover:bg-emerald-500/10",
    primary: "bg-violet-600 text-white hover:bg-violet-500",
  }[variant];
  return (
    <button onClick={onClick} disabled={disabled} className={cx("inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-40", v, className)}>
      {children}
    </button>
  );
}

// ---------------------------------------------------------------- suspend dialog

function SuspendDialog({ target, onClose, onDone }: {
  target: { kind: "tenants" | "users"; id: string; name: string; suspended: boolean } | null; onClose: () => void; onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setReason("");
    setError(null);
  }, [target]);
  if (!target) return null;
  const run = async () => {
    if (!target.suspended && !reason.trim()) return setError("A reason is required (it is recorded in the audit log).");
    setBusy(true);
    try {
      await adminSetSuspended(target.kind, target.id, !target.suspended, reason.trim() || undefined);
      onDone();
      onClose();
    } catch (e) {
      setError(errorMessage(e, "Action failed."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" role="dialog" aria-modal="true">
      <div className={cx(surface, "w-full max-w-md p-6")}>
        <div className="flex items-start justify-between">
          <h3 className="text-base font-semibold text-slate-900 dark:text-white">{target.suspended ? "Restore access" : "Suspend"} — {target.name}</h3>
          <button onClick={onClose} aria-label="Close" className="text-slate-400 hover:text-slate-600"><X className="h-4 w-4" /></button>
        </div>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          {target.suspended
            ? "Members will be able to sign in and use this again."
            : target.kind === "users"
              ? "The user is signed out everywhere and can't sign in until restored."
              : "All members lose access to this workspace and its cameras stop being analysed."}
        </p>
        {!target.suspended && (
          <textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (recorded in the audit log)" maxLength={500} rows={3} autoFocus
            className="mt-4 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-violet-500 dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
        )}
        {error && <p className="mt-2 text-sm text-rose-600 dark:text-rose-400">{error}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Btn onClick={onClose}>Cancel</Btn>
          <Btn variant={target.suspended ? "success" : "danger"} onClick={run} disabled={busy}>{busy ? "Working…" : target.suspended ? "Restore" : "Suspend"}</Btn>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- data table plumbing

function useList<T>(fetcher: (p: AdminListParams) => Promise<{ total: number } & Record<string, unknown>>, key: string) {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const [status, setStatus] = useState<AdminStatusFilter>("all");
  const [type, setType] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{ items: T[]; total: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 250);
    return () => clearTimeout(t);
  }, [q]);
  const load = useCallback(async () => {
    try {
      const r = await fetcher({ q: debounced, page, status, type: type || undefined });
      setData({ items: r[key] as T[], total: r.total });
      setError(null);
    } catch (err) {
      setError(errorMessage(err, "Could not load."));
    }
  }, [fetcher, key, debounced, page, status, type]);
  useEffect(() => {
    void load();
  }, [load]);
  const reset = <V,>(fn: (v: V) => void) => (v: V) => { fn(v); setPage(1); };
  return { q, setQ: reset(setQ), status, setStatus: reset(setStatus), type, setType: reset(setType), page, setPage, data, error, reload: load };
}

function Toolbar({ q, setQ, placeholder, status, setStatus, children }: {
  q: string; setQ: (v: string) => void; placeholder: string; status?: AdminStatusFilter; setStatus?: (s: AdminStatusFilter) => void; children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 border-b border-slate-200 p-4 sm:flex-row sm:items-center dark:border-slate-800">
      <div className="relative flex-1 sm:max-w-xs">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={placeholder} aria-label={placeholder}
          className="w-full rounded-lg border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm text-slate-900 outline-none focus:border-violet-400 focus:ring-2 focus:ring-violet-500/30 dark:border-slate-700 dark:bg-slate-950 dark:text-white" />
      </div>
      {status && setStatus && (
        <div className="inline-flex rounded-lg border border-slate-200 bg-slate-50 p-0.5 dark:border-slate-700 dark:bg-slate-950" role="tablist" aria-label="Status filter">
          {(["all", "active", "suspended"] as const).map((s) => (
            <button key={s} role="tab" aria-selected={status === s} onClick={() => setStatus(s)}
              className={cx("rounded-md px-3 py-1.5 text-xs font-medium capitalize transition", status === s ? "bg-white text-slate-900 shadow-sm dark:bg-slate-800 dark:text-white" : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-200")}>
              {s}
            </button>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty: boolean }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400">
            {head.map((h, i) => <th key={i} className="whitespace-nowrap px-4 py-3 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">{children}</tbody>
      </table>
      {empty && <p className="px-4 py-10 text-center text-sm text-slate-500">Nothing matches these filters.</p>}
    </div>
  );
}
const td = "px-4 py-3 text-slate-700 dark:text-slate-300";
const rowCls = "transition hover:bg-slate-50 dark:hover:bg-slate-800/40";

function Pagination({ page, total, setPage }: { page: number; total: number; setPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, page * PAGE_SIZE);
  const nums = Array.from(new Set([1, page - 1, page, page + 1, pages])).filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  return (
    <div className="flex flex-col items-center justify-between gap-3 border-t border-slate-200 px-4 py-3 text-xs text-slate-500 sm:flex-row dark:border-slate-800 dark:text-slate-400">
      <span>Showing <b className="text-slate-700 dark:text-slate-200">{from}–{to}</b> of <b className="text-slate-700 dark:text-slate-200">{total}</b></span>
      <div className="flex items-center gap-1">
        <button aria-label="Previous page" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-md p-1.5 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ChevronLeft className="h-4 w-4" /></button>
        {nums.map((n, i) => (
          <span key={n} className="flex items-center">
            {i > 0 && n - nums[i - 1]! > 1 && <span className="px-1">…</span>}
            <button onClick={() => setPage(n)} className={cx("min-w-8 rounded-md px-2 py-1 font-medium", n === page ? "bg-violet-600 text-white" : "hover:bg-slate-100 dark:hover:bg-slate-800")}>{n}</button>
          </span>
        ))}
        <button aria-label="Next page" disabled={page >= pages} onClick={() => setPage(page + 1)} className="rounded-md p-1.5 hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-slate-800"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- sections

function ChartCard({ title, subtitle, children }: { title: string; subtitle: string; children: ReactNode }) {
  return (
    <Card className="p-5">
      <p className="text-sm font-semibold text-slate-900 dark:text-white">{title}</p>
      <p className="text-xs text-slate-500 dark:text-slate-400">{subtitle}</p>
      <div className="mt-4 h-56">{children}</div>
    </Card>
  );
}

function Overview({ dark }: { dark: boolean }) {
  const [s, setS] = useState<AdminStats | null>(null);
  const [ts, setTs] = useState<AdminTimeseries | null>(null);
  const [days, setDays] = useState(30);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    adminStats().then(setS).catch((e) => setError(errorMessage(e, "Could not load stats.")));
  }, []);
  useEffect(() => {
    adminTimeseries(days).then(setTs).catch(() => setTs(null));
  }, [days]);
  const data = useMemo(() => ts?.points.map((p) => ({ ...p, label: fmtDay(p.day), storageMb: Math.round((p.storageBytes / 1048576) * 10) / 10 })) ?? [], [ts]);
  const axis = { stroke: dark ? "#64748b" : "#94a3b8", fontSize: 11, tickLine: false, axisLine: false } as const;
  const grid = dark ? "#1e293b" : "#e2e8f0";
  const tip = { contentStyle: { background: dark ? "#0f172a" : "#fff", border: `1px solid ${dark ? "#334155" : "#e2e8f0"}`, borderRadius: 12, fontSize: 12 }, labelStyle: { color: dark ? "#e2e8f0" : "#0f172a" } };
  if (error) return <p className="text-rose-500">{error}</p>;
  if (!s) return <p className="text-slate-500">Loading…</p>;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
        <Kpi icon={Building2} label="Workspaces" value={s.tenants.total} sub={`${s.tenants.suspended} suspended`} tone="bg-violet-100 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300" />
        <Kpi icon={Users} label="Users" value={s.users.total} sub={`${s.users.suspended} suspended`} trend={ts?.trends.users} tone="bg-sky-100 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300" />
        <Kpi icon={Camera} label="Cameras" value={s.cameras.total} sub={`${s.cameras.recording} recording now`} trend={ts?.trends.cameras} tone="bg-emerald-100 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300" />
        <Kpi icon={HardDrive} label="Storage" value={formatBytes(s.storage.bytes)} sub={`${s.recordings.segments.toLocaleString()} recording segments`} trend={ts?.trends.storage} tone="bg-amber-100 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300" />
        <Kpi icon={Bell} label="Alerts" value={s.alerts.total.toLocaleString()} sub={`${s.alerts.last24h} in the last 24 h`} trend={ts?.trends.alerts} tone="bg-rose-100 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300" />
        <Kpi icon={Activity} label="Active sessions" value={s.sessions.active} sub={`${s.sessions.mobile} on mobile`} tone="bg-indigo-100 text-indigo-600 dark:bg-indigo-500/15 dark:text-indigo-300" />
      </div>
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900 dark:text-white">Usage over time</h2>
        <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 dark:border-slate-700 dark:bg-slate-900">
          {[7, 30, 90].map((d) => (
            <button key={d} onClick={() => setDays(d)} className={cx("rounded-md px-3 py-1 text-xs font-medium", days === d ? "bg-violet-600 text-white" : "text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-white")}>{d}d</button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <ChartCard title="Cameras" subtitle="Total connected cameras">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ left: -20, right: 8, top: 4 }}>
              <defs><linearGradient id="gCam" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#10b981" stopOpacity={0.35} /><stop offset="100%" stopColor="#10b981" stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid stroke={grid} vertical={false} />
              <XAxis dataKey="label" {...axis} minTickGap={24} />
              <YAxis {...axis} allowDecimals={false} />
              <Tooltip {...tip} />
              <Area type="monotone" dataKey="cameras" name="Cameras" stroke="#10b981" strokeWidth={2} fill="url(#gCam)" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
        <ChartCard title="Storage" subtitle="Recorded video kept in object storage (MB)">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ left: -10, right: 8, top: 4 }}>
              <defs><linearGradient id="gSto" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#f59e0b" stopOpacity={0.35} /><stop offset="100%" stopColor="#f59e0b" stopOpacity={0} /></linearGradient></defs>
              <CartesianGrid stroke={grid} vertical={false} />
              <XAxis dataKey="label" {...axis} minTickGap={24} />
              <YAxis {...axis} />
              <Tooltip {...tip} formatter={(v) => [`${v} MB`, "Storage"]} />
              <Area type="monotone" dataKey="storageMb" name="Storage" stroke="#f59e0b" strokeWidth={2} fill="url(#gSto)" />
            </AreaChart>
          </ResponsiveContainer>
        </ChartCard>
        <div className="xl:col-span-2">
          <ChartCard title="Alerts and recordings" subtitle="Per day">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={data} margin={{ left: -20, right: 8, top: 4 }}>
                <CartesianGrid stroke={grid} vertical={false} />
                <XAxis dataKey="label" {...axis} minTickGap={24} />
                <YAxis {...axis} allowDecimals={false} />
                <Tooltip {...tip} cursor={{ fill: dark ? "#1e293b" : "#f1f5f9" }} />
                <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
                <Bar dataKey="alerts" name="Alerts" fill="#f43f5e" radius={[4, 4, 0, 0]} />
                <Bar dataKey="recordings" name="Recording segments" fill="#8b5cf6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>
      </div>
    </div>
  );
}

type SuspendTarget = { kind: "tenants" | "users"; id: string; name: string; suspended: boolean };

function Workspaces({ onSuspend, reloadKey }: { onSuspend: (t: SuspendTarget) => void; reloadKey: number }) {
  const l = useList<AdminTenant>(adminTenants, "tenants");
  const { reload } = l;
  useEffect(() => { if (reloadKey) void reload(); }, [reloadKey, reload]);
  return (
    <Card>
      <Toolbar q={l.q} setQ={l.setQ} placeholder="Search workspaces" status={l.status} setStatus={l.setStatus} />
      {l.error && <p className="p-4 text-sm text-rose-500">{l.error}</p>}
      <Table head={["Workspace", "Members", "Cameras", "Storage", "Alerts", "Created", "Status", ""]} empty={l.data?.items.length === 0}>
        {l.data?.items.map((t) => (
          <tr key={t.id} className={rowCls}>
            <td className={td}><div className="flex items-center gap-3"><Avatar name={t.name} square /><span className="font-medium text-slate-900 dark:text-white">{t.name}</span></div></td>
            <td className={td}>{t.members}</td>
            <td className={td}>{t.cameras}</td>
            <td className={td}>{formatBytes(t.storageBytes)}</td>
            <td className={td}>{t.alerts.toLocaleString()}</td>
            <td className={cx(td, "whitespace-nowrap")}>{fmtDate(t.createdAt)}</td>
            <td className={td}><StatusBadge suspended={!!t.suspendedAt} reason={t.suspendedReason} /></td>
            <td className={cx(td, "text-right")}>
              <Btn variant={t.suspendedAt ? "success" : "danger"} onClick={() => onSuspend({ kind: "tenants", id: t.id, name: t.name, suspended: !!t.suspendedAt })}>
                {t.suspendedAt ? "Unsuspend" : "Suspend"}
              </Btn>
            </td>
          </tr>
        ))}
      </Table>
      {l.data && <Pagination page={l.page} total={l.data.total} setPage={l.setPage} />}
    </Card>
  );
}

const ROLE_TONE: Record<string, Tone> = { OWNER: "violet", ADMIN: "sky", OPERATOR: "amber", VIEWER: "slate" };

function UsersSection({ selfId, onSuspend, reloadKey }: { selfId: string; onSuspend: (t: SuspendTarget) => void; reloadKey: number }) {
  const l = useList<AdminUser>(adminUsers, "users");
  const { reload } = l;
  useEffect(() => { if (reloadKey) void reload(); }, [reloadKey, reload]);
  return (
    <Card>
      <Toolbar q={l.q} setQ={l.setQ} placeholder="Search by email or name" status={l.status} setStatus={l.setStatus} />
      {l.error && <p className="p-4 text-sm text-rose-500">{l.error}</p>}
      <Table head={["User", "Workspaces", "Sessions", "Joined", "Status", ""]} empty={l.data?.items.length === 0}>
        {l.data?.items.map((u) => (
          <tr key={u.id} className={rowCls}>
            <td className={td}>
              <div className="flex items-center gap-3">
                <Avatar name={u.displayName || u.email} />
                <div className="min-w-0">
                  <p className="flex items-center gap-2 font-medium text-slate-900 dark:text-white">
                    <span className="truncate">{u.displayName || u.email.split("@")[0]}</span>
                    {u.isPlatformAdmin && <Badge tone="violet"><ShieldCheck className="h-3 w-3" />Admin</Badge>}
                  </p>
                  <p className="truncate text-xs text-slate-500 dark:text-slate-400">{u.email}</p>
                </div>
              </div>
            </td>
            <td className={td}>
              <div className="flex max-w-xs flex-wrap gap-1">
                {u.workspaces.length === 0 && <span className="text-slate-400">—</span>}
                {u.workspaces.slice(0, 3).map((w) => <Badge key={w.id} tone={ROLE_TONE[w.role] ?? "slate"}>{w.name} · {w.role.toLowerCase()}</Badge>)}
                {u.workspaces.length > 3 && <Badge tone="slate">+{u.workspaces.length - 3}</Badge>}
              </div>
            </td>
            <td className={td}>{u.activeSessions}</td>
            <td className={cx(td, "whitespace-nowrap")}>{fmtDate(u.createdAt)}</td>
            <td className={td}><StatusBadge suspended={!!u.suspendedAt} reason={u.suspendedReason} /></td>
            <td className={cx(td, "text-right")}>
              <Btn variant={u.suspendedAt ? "success" : "danger"} disabled={u.id === selfId || (u.isPlatformAdmin && !u.suspendedAt)}
                onClick={() => onSuspend({ kind: "users", id: u.id, name: u.email, suspended: !!u.suspendedAt })}>
                {u.suspendedAt ? "Unsuspend" : "Suspend"}
              </Btn>
            </td>
          </tr>
        ))}
      </Table>
      {l.data && <Pagination page={l.page} total={l.data.total} setPage={l.setPage} />}
    </Card>
  );
}

function CamerasSection() {
  const l = useList<AdminCamera>(adminCameras, "cameras");
  return (
    <Card>
      <Toolbar q={l.q} setQ={l.setQ} placeholder="Search cameras" status={l.status} setStatus={l.setStatus}>
        <select value={l.type} onChange={(e) => l.setType(e.target.value)} aria-label="Camera type"
          className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700 dark:border-slate-700 dark:bg-slate-950 dark:text-slate-200">
          <option value="">All types</option>
          <option value="RTSP">RTSP</option>
          <option value="ONVIF">ONVIF</option>
          <option value="SIMULATED">Simulated</option>
        </select>
      </Toolbar>
      {l.error && <p className="p-4 text-sm text-rose-500">{l.error}</p>}
      <Table head={["Camera", "Workspace", "Type", "Recording", "Motion", "Events", "Added"]} empty={l.data?.items.length === 0}>
        {l.data?.items.map((c) => (
          <tr key={c.id} className={rowCls}>
            <td className={td}>
              <div className="flex items-center gap-3">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-300"><Camera className="h-4 w-4" /></span>
                <div>
                  <p className="font-medium text-slate-900 dark:text-white">{c.name}</p>
                  <p className="text-xs text-slate-500 dark:text-slate-400">{[c.manufacturer, c.model].filter(Boolean).join(" ") || "—"}</p>
                </div>
              </div>
            </td>
            <td className={td}>
              <div className="flex items-center gap-2">{c.tenant.name}{c.tenant.suspendedAt && <Badge tone="red">suspended</Badge>}</div>
            </td>
            <td className={td}><Badge tone="sky">{c.connectorType}</Badge></td>
            <td className={td}>{c.recording ? <Badge tone="red" dot>Recording</Badge> : <Badge tone="slate">Idle</Badge>}</td>
            <td className={td}>{c.motionEnabled ? <Badge tone="green">On</Badge> : <Badge tone="slate">Off</Badge>}</td>
            <td className={td}>{c.motionEvents.toLocaleString()}</td>
            <td className={cx(td, "whitespace-nowrap")}>{fmtDate(c.createdAt)}</td>
          </tr>
        ))}
      </Table>
      {l.data && <Pagination page={l.page} total={l.data.total} setPage={l.setPage} />}
    </Card>
  );
}

function AuditSection({ reloadKey }: { reloadKey: number }) {
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AdminAuditEntry[] | null>(null);
  useEffect(() => {
    adminAudit(page).then((r) => setRows(r.entries)).catch(() => setRows([]));
  }, [page, reloadKey]);
  return (
    <Card>
      {!rows ? <p className="p-6 text-slate-500">Loading…</p> : (
        <Table head={["When", "Admin", "Action", "Target", "Reason"]} empty={rows.length === 0}>
          {rows.map((r) => (
            <tr key={r.id} className={rowCls}>
              <td className={cx(td, "whitespace-nowrap")}>{new Date(r.createdAt).toLocaleString()}</td>
              <td className={td}><div className="flex items-center gap-2"><Avatar name={r.actorEmail ?? "CLI"} /><span>{r.actorEmail ?? "CLI"}</span></div></td>
              <td className={td}><Badge tone={r.action.includes("unsuspend") ? "green" : r.action.includes("suspend") ? "red" : "violet"}>{r.action}</Badge></td>
              <td className={td}><span className="text-xs text-slate-500">{r.targetType}</span> {String(r.metadata?.name ?? r.metadata?.email ?? r.targetId)}</td>
              <td className={cx(td, "text-xs text-slate-500 dark:text-slate-400")}>{r.metadata?.reason ? String(r.metadata.reason) : "—"}</td>
            </tr>
          ))}
        </Table>
      )}
      <div className="flex justify-end gap-2 border-t border-slate-200 p-3 dark:border-slate-800">
        <Btn disabled={page <= 1} onClick={() => setPage(page - 1)}><ChevronLeft className="h-3 w-3" />Newer</Btn>
        <Btn disabled={!rows || rows.length < PAGE_SIZE} onClick={() => setPage(page + 1)}>Older<ChevronRight className="h-3 w-3" /></Btn>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- shell

const TITLES: Record<Section, [string, string]> = {
  overview: ["Overview", "Platform-wide health and usage. Every admin action is audit-logged."],
  workspaces: ["Workspaces", "All customer workspaces on this deployment."],
  users: ["Users", "Everyone with an account, across all workspaces."],
  cameras: ["Cameras", "Every connected camera and its current state."],
  audit: ["Audit log", "Suspensions and other platform-admin actions."],
};

export function AdminConsole({ self }: { self: { id: string; email: string } }) {
  const [section, setSection] = useState<Section>("overview");
  const [dark, setDark] = useState(true);
  const [navOpen, setNavOpen] = useState(false);
  const [suspend, setSuspend] = useState<SuspendTarget | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const saved = localStorage.getItem("admin-theme");
    setDark(saved ? saved === "dark" : !window.matchMedia("(prefers-color-scheme: light)").matches);
  }, []);
  const toggleTheme = () => {
    setDark((d) => {
      localStorage.setItem("admin-theme", d ? "light" : "dark");
      return !d;
    });
  };
  const [title, subtitle] = TITLES[section];

  return (
    <div className={cx(dark && "dark", "fixed inset-0 z-50")}>
      <div className="flex h-full bg-slate-50 font-sans text-slate-900 antialiased dark:bg-slate-950 dark:text-slate-100">
        {navOpen && <div className="fixed inset-0 z-40 bg-slate-950/40 lg:hidden" onClick={() => setNavOpen(false)} />}
        <aside className={cx(
          "fixed inset-y-0 left-0 z-50 flex w-64 flex-col border-r border-slate-200 bg-white transition-transform lg:static lg:translate-x-0 dark:border-slate-800 dark:bg-slate-900",
          navOpen ? "translate-x-0" : "-translate-x-full",
        )}>
          <div className="flex h-16 items-center gap-3 px-5">
            <span className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white shadow-sm"><ShieldCheck className="h-5 w-5" /></span>
            <div>
              <p className="text-sm font-semibold">Universal CCTV</p>
              <p className="text-xs text-slate-500 dark:text-slate-400">Platform admin</p>
            </div>
          </div>
          <nav className="flex-1 space-y-1 px-3 py-4">
            {NAV.map(({ key, label, icon: Icon }) => (
              <button key={key} onClick={() => { setSection(key); setNavOpen(false); }}
                className={cx("flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition",
                  section === key ? "bg-violet-50 text-violet-700 dark:bg-violet-500/10 dark:text-violet-300" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900 dark:text-slate-400 dark:hover:bg-slate-800 dark:hover:text-white")}>
                <Icon className="h-4 w-4" />{label}
              </button>
            ))}
          </nav>
          <div className="border-t border-slate-200 p-3 dark:border-slate-800">
            <Link href="/dashboard" className="flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800">
              <ArrowLeft className="h-4 w-4" />Back to app
            </Link>
          </div>
        </aside>

        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-16 shrink-0 items-center gap-3 border-b border-slate-200 bg-white/80 px-4 backdrop-blur md:px-8 dark:border-slate-800 dark:bg-slate-900/60">
            <button className="rounded-lg p-2 hover:bg-slate-100 lg:hidden dark:hover:bg-slate-800" aria-label="Open menu" onClick={() => setNavOpen(true)}><Menu className="h-5 w-5" /></button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold tracking-tight">{title}</h1>
              <p className="hidden truncate text-xs text-slate-500 sm:block dark:text-slate-400">{subtitle}</p>
            </div>
            <button onClick={toggleTheme} aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
              className="rounded-lg border border-slate-200 p-2 text-slate-600 hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800">
              {dark ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
            </button>
            <div className="flex items-center gap-2">
              <Avatar name={self.email} />
              <div className="hidden text-xs md:block">
                <p className="font-medium">{self.email}</p>
                <p className="text-slate-500 dark:text-slate-400">Super admin</p>
              </div>
            </div>
          </header>
          <main className="flex-1 overflow-y-auto px-4 py-6 md:px-8">
            <div className="mx-auto max-w-7xl">
              {section === "overview" && <Overview dark={dark} />}
              {section === "workspaces" && <Workspaces onSuspend={setSuspend} reloadKey={reloadKey} />}
              {section === "users" && <UsersSection selfId={self.id} onSuspend={setSuspend} reloadKey={reloadKey} />}
              {section === "cameras" && <CamerasSection />}
              {section === "audit" && <AuditSection reloadKey={reloadKey} />}
            </div>
          </main>
        </div>
      </div>
      <SuspendDialog target={suspend} onClose={() => setSuspend(null)} onDone={() => setReloadKey((k) => k + 1)} />
    </div>
  );
}
