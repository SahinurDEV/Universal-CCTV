"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { acceptInvite, errorMessage, fetchMe, previewInvite, type Role } from "@/lib/api";

type Preview = { email: string; role: Role; workspaceName: string; expiresAt: string; accountExists: boolean };

export default function AcceptInvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const [preview, setPreview] = useState<Preview | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [signedInAs, setSignedInAs] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    previewInvite(token).then(setPreview).catch(() => setInvalid(true));
    fetchMe()
      .then((me) => setSignedInAs(me.user.email))
      .catch(() => setSignedInAs(null));
  }, [token]);

  async function onAccept(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await acceptInvite({
        token,
        ...(preview?.accountExists ? {} : { password, displayName: displayName || undefined }),
      });
      router.push("/dashboard");
    } catch (err) {
      setError(errorMessage(err, "Could not accept the invite."));
    } finally {
      setBusy(false);
    }
  }

  const loginHref = `/login?next=${encodeURIComponent(`/invite/${token}`)}`;
  const input = "w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm";

  return (
    <main className="flex min-h-screen items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-sm space-y-4 rounded-lg border border-slate-800 p-6">
        <h1 className="text-xl font-semibold">Workspace invitation</h1>
        {invalid && (
          <p className="text-sm text-red-400">
            This invite link is invalid, expired, revoked or already used. Ask the person who invited you for a new one.
          </p>
        )}
        {!invalid && !preview && <p className="text-sm text-slate-400">Checking invite...</p>}
        {preview && (
          <form onSubmit={onAccept} className="space-y-4">
            <p className="text-sm">
              You&apos;ve been invited to join <strong>{preview.workspaceName}</strong> as{" "}
              <strong>{preview.role.toLowerCase()}</strong>.
            </p>
            <p className="text-xs text-slate-500">
              For {preview.email} · expires {new Date(preview.expiresAt).toLocaleString()}
            </p>

            {preview.accountExists ? (
              signedInAs === preview.email ? (
                <button disabled={busy} className="w-full rounded bg-emerald-600 py-2 text-sm font-medium text-white disabled:opacity-50">
                  {busy ? "Joining..." : "Join workspace"}
                </button>
              ) : (
                <p className="text-sm text-slate-300">
                  {signedInAs ? `You're signed in as ${signedInAs}. ` : ""}
                  <Link href={loginHref} className="text-emerald-400 hover:underline">
                    Sign in as {preview.email}
                  </Link>{" "}
                  to accept.
                </p>
              )
            ) : signedInAs ? (
              <p className="text-sm text-slate-300">
                You&apos;re signed in as {signedInAs}. Log out first to create an account for {preview.email}.
              </p>
            ) : (
              <>
                <label className="block space-y-1 text-sm">
                  <span className="text-slate-400">Your name (optional)</span>
                  <input value={displayName} maxLength={100} onChange={(e) => setDisplayName(e.target.value)} className={input} />
                </label>
                <label className="block space-y-1 text-sm">
                  <span className="text-slate-400">Choose a password</span>
                  <input
                    type="password"
                    required
                    minLength={8}
                    maxLength={72}
                    autoComplete="new-password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className={input}
                  />
                </label>
                <button disabled={busy} className="w-full rounded bg-emerald-600 py-2 text-sm font-medium text-white disabled:opacity-50">
                  {busy ? "Creating account..." : "Create account & join"}
                </button>
              </>
            )}
            {error && <p className="text-sm text-red-400">{error}</p>}
          </form>
        )}
      </div>
    </main>
  );
}
