"use client";

import { useEffect, useState } from "react";
import {
  changePassword,
  errorMessage,
  getAccount,
  getNotificationPreferences,
  listSessions,
  revokeOtherSessions,
  setNotificationPreferences,
  updateProfile,
  type AccountInfo,
  type Notification,
} from "@/lib/api";

const input = "w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm";
const card = "space-y-3 rounded-lg border border-slate-800 p-4";
const TYPE_LABELS: Record<Notification["type"], string> = {
  CAMERA_OFFLINE: "Camera goes offline",
  RECORDING_STOPPED: "Recording stops unexpectedly",
  STORAGE_QUOTA_WARNING: "Storage almost full",
  UPLOAD_FAILURE: "Recording upload failed",
  RETENTION_CLEANUP_FAILURE: "Old-recording cleanup failed",
};

export default function SettingsPage() {
  const [account, setAccount] = useState<AccountInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getAccount().then(setAccount).catch(() => setError("Could not load your account."));
  }, []);

  return (
    <div className="max-w-2xl space-y-6">
      <h1 className="text-2xl font-semibold">Settings</h1>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {account && <ProfileCard account={account} />}
      <PasswordCard />
      <NotificationsCard />
      <SessionsCard />
    </div>
  );
}

function ProfileCard({ account }: { account: AccountInfo }) {
  const [displayName, setDisplayName] = useState(account.user.displayName ?? "");
  const [msg, setMsg] = useState<string | null>(null);

  async function onSave(e: React.FormEvent) {
    e.preventDefault();
    try {
      await updateProfile(displayName.trim() || null);
      setMsg("Saved.");
    } catch (err) {
      setMsg(errorMessage(err, "Could not save."));
    }
  }

  return (
    <form onSubmit={onSave} className={card}>
      <h2 className="font-medium">Profile</h2>
      <p className="text-sm text-slate-400">Email: {account.user.email}</p>
      <p className="text-sm text-slate-400">
        Workspaces: {account.memberships.map((m) => `${m.tenantName} (${m.role.toLowerCase()})`).join(", ")}
      </p>
      <label className="block text-sm">
        Display name
        <input maxLength={100} value={displayName} onChange={(e) => setDisplayName(e.target.value)} className={input} />
      </label>
      <div className="flex items-center gap-3">
        <button className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white">Save</button>
        {msg && <span className="text-sm text-slate-400">{msg}</span>}
      </div>
    </form>
  );
}

function PasswordCard() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirmNext, setConfirmNext] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (next !== confirmNext) {
      setMsg({ ok: false, text: "The new passwords do not match." });
      return;
    }
    setSaving(true);
    try {
      const r = await changePassword(current, next);
      setMsg({ ok: true, text: `Password changed. Signed out ${r.otherSessionsRevoked} other device(s).` });
      setCurrent("");
      setNext("");
      setConfirmNext("");
    } catch (err) {
      const code = errorMessage(err, "Could not change password.");
      setMsg({ ok: false, text: code === "invalid_current_password" ? "Your current password is wrong." : code });
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className={card}>
      <h2 className="font-medium">Change password</h2>
      <label className="block text-sm">
        Current password
        <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} className={input} />
      </label>
      <label className="block text-sm">
        New password (at least 8 characters)
        <input type="password" autoComplete="new-password" required minLength={8} maxLength={72} value={next} onChange={(e) => setNext(e.target.value)} className={input} />
      </label>
      <label className="block text-sm">
        Repeat new password
        <input type="password" autoComplete="new-password" required value={confirmNext} onChange={(e) => setConfirmNext(e.target.value)} className={input} />
      </label>
      <div className="flex items-center gap-3">
        <button disabled={saving} className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
          Change password
        </button>
        {msg && <span className={`text-sm ${msg.ok ? "text-emerald-400" : "text-red-400"}`}>{msg.text}</span>}
      </div>
    </form>
  );
}

function NotificationsCard() {
  const [types, setTypes] = useState<Notification["type"][]>([]);
  const [muted, setMuted] = useState<Notification["type"][]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    getNotificationPreferences()
      .then((p) => {
        setTypes(p.types);
        setMuted(p.mutedTypes);
      })
      .catch(() => setMsg("Could not load preferences."));
  }, []);

  async function toggle(t: Notification["type"], on: boolean) {
    const nextMuted = on ? muted.filter((m) => m !== t) : [...muted, t];
    setMuted(nextMuted);
    try {
      await setNotificationPreferences(nextMuted);
      setMsg("Saved.");
    } catch (err) {
      setMsg(errorMessage(err, "Could not save."));
    }
  }

  return (
    <div className={card}>
      <h2 className="font-medium">Alert preferences</h2>
      <p className="text-sm text-slate-400">Choose which alerts you see on the Alerts page in this workspace. Other members are not affected.</p>
      {types.map((t) => (
        <label key={t} className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={!muted.includes(t)} onChange={(e) => toggle(t, e.target.checked)} />
          {TYPE_LABELS[t] ?? t}
        </label>
      ))}
      {msg && <p className="text-sm text-slate-400">{msg}</p>}
    </div>
  );
}

function SessionsCard() {
  const [sessions, setSessions] = useState<Awaited<ReturnType<typeof listSessions>>["sessions"]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  async function load() {
    try {
      setSessions((await listSessions()).sessions);
    } catch {
      setMsg("Could not load sessions.");
    }
  }
  useEffect(() => {
    load();
  }, []);

  return (
    <div className={card}>
      <h2 className="font-medium">Signed-in devices</h2>
      <ul className="space-y-1 text-sm text-slate-400">
        {sessions.map((s) => (
          <li key={s.id}>
            Signed in {new Date(s.createdAt).toLocaleString()} · last active {new Date(s.lastUsedAt).toLocaleString()}
            {s.current && <span className="ml-2 text-emerald-400">(this device)</span>}
          </li>
        ))}
      </ul>
      <button
        onClick={async () => {
          try {
            const r = await revokeOtherSessions();
            setMsg(`Signed out ${r.revoked} other device(s).`);
            await load();
          } catch (err) {
            setMsg(errorMessage(err, "Could not sign out other devices."));
          }
        }}
        className="rounded border border-slate-700 px-3 py-2 text-sm"
      >
        Sign out all other devices
      </button>
      {msg && <p className="text-sm text-slate-400">{msg}</p>}
    </div>
  );
}
