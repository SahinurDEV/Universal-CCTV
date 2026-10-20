"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

type ApiStatus = { state: "loading" } | { state: "ok" } | { state: "error"; message: string };

const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:4100";

export default function Home() {
  const [status, setStatus] = useState<ApiStatus>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;

    fetch(`${API_BASE_URL}/health`)
      .then((res) => {
        if (!res.ok) throw new Error(`API responded with ${res.status}`);
        return res.json();
      })
      .then(() => {
        if (!cancelled) setStatus({ state: "ok" });
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setStatus({
            state: "error",
            message: err instanceof Error ? err.message : "Unknown error",
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <div className="text-center">
        <h1 className="text-2xl font-semibold">Universal CCTV Platform</h1>
        <p className="mt-1 text-slate-400">Manufacturer-agnostic cloud CCTV recording and management.</p>
      </div>

      <div className="flex gap-3">
        <Link href="/login" className="rounded border border-slate-700 px-4 py-2 text-sm hover:bg-slate-900">
          Log in
        </Link>
        <Link href="/register" className="rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white">
          Create a workspace
        </Link>
      </div>

      <div className="rounded-lg border border-slate-800 px-4 py-3 text-sm">
        Backend API status:{" "}
        {status.state === "loading" && <span className="text-slate-400">checking...</span>}
        {status.state === "ok" && <span className="text-emerald-400">connected ({API_BASE_URL})</span>}
        {status.state === "error" && (
          <span className="text-red-400">unreachable — {status.message}</span>
        )}
      </div>
    </main>
  );
}
