"use client";

import { useCallback, useEffect, useState } from "react";
import {
  changeMemberRole,
  createInvite,
  errorMessage,
  listInvites,
  listMembers,
  removeMember,
  revokeInvite,
  type Invite,
  type Member,
  type Role,
} from "@/lib/api";

const ROLES: Role[] = ["OWNER", "ADMIN", "OPERATOR", "VIEWER"];
const ROLE_HELP: Record<Role, string> = {
  OWNER: "Everything, including billing and removing other owners",
  ADMIN: "Manage cameras, locations, integrations and team (not owners)",
  OPERATOR: "Add/edit cameras, start/stop recording, motion settings",
  VIEWER: "Watch live video and recordings only",
};
const input = "rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm";

function assignable(actor: Role): Role[] {
  if (actor === "OWNER") return ROLES;
  if (actor === "ADMIN") return ["ADMIN", "OPERATOR", "VIEWER"];
  return [];
}

export default function TeamPage() {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [me, setMe] = useState<{ id: string; role: Role } | null>(null);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [mailConfigured, setMailConfigured] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("VIEWER");
  const [lastLink, setLastLink] = useState<{ url: string; emailSent: boolean; email: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const canManage = me?.role === "OWNER" || me?.role === "ADMIN";

  const load = useCallback(async () => {
    try {
      const m = await listMembers();
      setMembers(m.members);
      setMe({ id: m.currentUserId, role: m.currentRole });
      if (m.currentRole === "OWNER" || m.currentRole === "ADMIN") {
        const i = await listInvites();
        setInvites(i.invites);
        setMailConfigured(i.mailConfigured);
      }
    } catch (err) {
      setError(errorMessage(err, "Could not load the team."));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errorMessage(err, "Something went wrong."));
    } finally {
      setBusy(false);
    }
  }

  async function onInvite(e: React.FormEvent) {
    e.preventDefault();
    await run(async () => {
      const res = await createInvite(email, role);
      setLastLink({ url: res.acceptUrl, emailSent: res.emailSent, email: res.invite.email });
      setEmail("");
    });
  }

  const pending = invites.filter((i) => i.state === "pending");
  const past = invites.filter((i) => i.state !== "pending").slice(0, 20);

  return (
    <div className="max-w-4xl space-y-6">
      <h1 className="text-2xl font-semibold">Team</h1>
      {error && <p className="text-sm text-red-400">{error}</p>}

      {canManage && me && (
        <form onSubmit={onInvite} className="space-y-3 rounded-lg border border-slate-800 p-4">
          <h2 className="text-lg font-medium">Invite someone</h2>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              type="email"
              required
              maxLength={254}
              placeholder="name@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={`${input} flex-1`}
              aria-label="Email address"
            />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} className={input} aria-label="Role">
              {assignable(me.role).map((r) => (
                <option key={r} value={r}>
                  {r.charAt(0) + r.slice(1).toLowerCase()}
                </option>
              ))}
            </select>
            <button disabled={busy} className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
              Send invite
            </button>
          </div>
          <p className="text-xs text-slate-500">{ROLE_HELP[role]}. Invite links expire after 72 hours by default.</p>
          {!mailConfigured && (
            <p className="text-xs text-amber-400">
              Email sending is not set up on this server (SMTP_URL), so copy the link below and send it yourself.
            </p>
          )}
          {lastLink && (
            <div className="space-y-1 rounded border border-emerald-800 bg-emerald-950/20 p-3 text-sm">
              <p>
                {lastLink.emailSent ? `Invite emailed to ${lastLink.email}.` : `Invite created for ${lastLink.email}.`} This
                link is shown only once:
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input readOnly value={lastLink.url} className={`${input} flex-1 font-mono text-xs`} onFocus={(e) => e.target.select()} />
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(lastLink.url)}
                  className="rounded border border-slate-700 px-3 py-2 text-xs"
                >
                  Copy link
                </button>
              </div>
            </div>
          )}
        </form>
      )}

      <section className="space-y-2">
        <h2 className="text-lg font-medium">Members</h2>
        {!members && <p className="text-sm text-slate-400">Loading...</p>}
        {members && (
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full min-w-[520px] text-left text-sm">
              <thead className="bg-slate-900 text-slate-400">
                <tr>
                  <th className="px-4 py-2">Person</th>
                  <th className="px-4 py-2">Role</th>
                  <th className="px-4 py-2">Joined</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {members.map((m) => {
                  const editable =
                    canManage && me && m.userId !== me.id && (me.role === "OWNER" || m.role !== "OWNER");
                  return (
                    <tr key={m.userId} className="border-t border-slate-800">
                      <td className="px-4 py-2">
                        <p>{m.displayName ?? m.email}</p>
                        {m.displayName && <p className="text-xs text-slate-500">{m.email}</p>}
                        {me && m.userId === me.id && <p className="text-xs text-slate-500">(you)</p>}
                      </td>
                      <td className="px-4 py-2">
                        {editable && me ? (
                          <select
                            value={m.role}
                            disabled={busy}
                            onChange={(e) => run(() => changeMemberRole(m.userId, e.target.value as Role))}
                            className="rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs"
                            aria-label={`Role for ${m.email}`}
                          >
                            {assignable(me.role).map((r) => (
                              <option key={r} value={r}>
                                {r}
                              </option>
                            ))}
                          </select>
                        ) : (
                          m.role
                        )}
                      </td>
                      <td className="px-4 py-2 text-slate-400">{new Date(m.joinedAt).toLocaleDateString()}</td>
                      <td className="px-4 py-2 text-right">
                        {editable && (
                          <button
                            disabled={busy}
                            onClick={() => {
                              if (confirm(`Remove ${m.email} from this workspace?`)) run(() => removeMember(m.userId));
                            }}
                            className="text-xs text-red-400 hover:underline"
                          >
                            Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canManage && (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Pending invites</h2>
          {pending.length === 0 ? (
            <p className="text-sm text-slate-500">No pending invites.</p>
          ) : (
            <ul className="space-y-2">
              {pending.map((i) => (
                <li key={i.id} className="flex flex-col gap-2 rounded-lg border border-slate-800 p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="truncate">{i.email}</p>
                    <p className="text-xs text-slate-500">
                      {i.role} · expires {new Date(i.expiresAt).toLocaleString()}
                      {i.invitedBy && <> · invited by {i.invitedBy}</>}
                    </p>
                  </div>
                  <button disabled={busy} onClick={() => run(() => revokeInvite(i.id))} className="self-start text-xs text-red-400 hover:underline sm:self-auto">
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          )}
          {past.length > 0 && (
            <details className="text-sm text-slate-400">
              <summary className="cursor-pointer">Past invites ({past.length})</summary>
              <ul className="mt-2 space-y-1 text-xs">
                {past.map((i) => (
                  <li key={i.id}>
                    {i.email} — {i.role} — {i.state}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </section>
      )}
    </div>
  );
}
