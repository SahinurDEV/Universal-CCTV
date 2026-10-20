"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { ApiError, register } from "@/lib/api";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await register({ email, password, tenantName });
      router.push("/dashboard");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(
          err.status === 409
            ? "That email is already registered."
            : err.status === 400
              ? "Check your inputs — password must be at least 8 characters."
              : "Registration failed. Please try again.",
        );
      } else {
        setError("Could not reach the server. Is the API running?");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-800 p-6">
        <h1 className="text-xl font-semibold">Create your workspace</h1>

        <div className="space-y-1">
          <label className="block text-sm text-slate-400">Workspace name</label>
          <input
            required
            value={tenantName}
            onChange={(e) => setTenantName(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2"
            placeholder="Acme Security"
          />
        </div>

        <div className="space-y-1">
          <label className="block text-sm text-slate-400">Email</label>
          <input
            required
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2"
          />
        </div>

        <div className="space-y-1">
          <label className="block text-sm text-slate-400">Password</label>
          <input
            required
            minLength={8}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2"
          />
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="w-full rounded bg-emerald-600 px-3 py-2 font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Creating..." : "Create workspace"}
        </button>

        <p className="text-sm text-slate-400">
          Already have an account?{" "}
          <Link href="/login" className="text-emerald-400 hover:underline">
            Log in
          </Link>
        </p>
      </form>
    </main>
  );
}
