"use client";

import { useEffect, useState } from "react";
import { listCameras, type Camera } from "@/lib/api";

export default function OverviewPage() {
  const [cameras, setCameras] = useState<Camera[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    listCameras()
      .then((res) => setCameras(res.cameras))
      .catch(() => setError("Could not load cameras."));
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Overview</h1>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatTile label="Total cameras" value={cameras ? String(cameras.length) : "..."} />
        {/* No connector has ever actually connected to a camera yet (Phase 4),
            so there is no real online/offline signal to show — showing a
            fabricated count here would violate "never claim what hasn't been
            tested." */}
        <StatTile label="Online / Offline" value="Not tracked yet" muted />
        <StatTile label="Active recordings" value="Not implemented yet" muted />
        <StatTile label="Storage used" value="Not implemented yet" muted />
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      <section>
        <h2 className="mb-2 text-lg font-medium">Recent activity</h2>
        <div className="rounded-lg border border-dashed border-slate-700 p-6 text-sm text-slate-400">
          No recording or alert activity to show — the recording pipeline isn't
          built yet (see docs/requirements.md Phase 5).
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
