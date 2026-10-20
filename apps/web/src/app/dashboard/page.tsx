"use client";

import { useEffect, useState } from "react";
import { getStorageUsage, listCameras, type Camera } from "@/lib/api";

function formatBytes(bytesStr: string): string {
  const bytes = Number(bytesStr);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export default function OverviewPage() {
  const [cameras, setCameras] = useState<Camera[] | null>(null);
  const [storageBytes, setStorageBytes] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCameras()
      .then((res) => setCameras(res.cameras))
      .catch(() => setError("Could not load cameras."));
    getStorageUsage()
      .then((res) => setStorageBytes(res.totalBytes))
      .catch(() => {
        /* non-fatal — the rest of the page still works */
      });
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Overview</h1>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Total cameras" value={cameras ? String(cameras.length) : "..."} />
        {/* No connector reports a persistent online/offline signal yet (that
            needs recording-health monitoring, not built) — showing a
            fabricated status here would violate "never claim what hasn't
            been tested." */}
        <StatTile label="Online / Offline" value="Not tracked yet" muted />
        <StatTile label="Active recordings" value="Not implemented yet" muted />
        <StatTile
          label="Storage used"
          value={storageBytes !== null ? formatBytes(storageBytes) : "..."}
        />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <section>
        <h2 className="mb-2 text-lg font-medium">Recent activity</h2>
        <div className="rounded-lg border border-dashed border-slate-700 p-6 text-sm text-slate-400">
          No activity feed yet — check the Recordings page for what's actually been recorded.
        </div>
      </section>
    </div>
  );
}

function StatTile({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <div className="rounded-lg border border-slate-800 p-4">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`mt-1 text-xl font-semibold ${muted ? "text-slate-500" : ""}`}>{value}</p>
    </div>
  );
}
