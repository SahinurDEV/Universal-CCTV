"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { LivePlayer } from "@/components/LivePlayer";
import { listCameras, listLocations, type Camera, type Location } from "@/lib/api";

const LAYOUTS = [
  { key: 1, label: "1", cols: "grid-cols-1" },
  { key: 4, label: "2×2", cols: "grid-cols-1 md:grid-cols-2" },
  { key: 9, label: "3×3", cols: "grid-cols-1 md:grid-cols-2 xl:grid-cols-3" },
  { key: 16, label: "4×4", cols: "grid-cols-2 xl:grid-cols-4" },
] as const;

export default function LiveViewPage() {
  const [cameras, setCameras] = useState<Camera[] | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [locationFilter, setLocationFilter] = useState<string>("all");
  const [layout, setLayout] = useState<(typeof LAYOUTS)[number]["key"]>(4);
  const [page, setPage] = useState(0);

  useEffect(() => {
    Promise.all([listCameras(), listLocations()])
      .then(([c, l]) => {
        setCameras(c.cameras);
        setLocations(l.locations);
      })
      .catch(() => setError("Could not load cameras. Is the API running?"));
  }, []);

  const filtered = useMemo(() => {
    if (!cameras) return [];
    if (locationFilter === "all") return cameras;
    if (locationFilter === "none") return cameras.filter((c) => !c.locationId);
    return cameras.filter((c) => c.locationId === locationFilter);
  }, [cameras, locationFilter]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / layout));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * layout, safePage * layout + layout);
  const cols = LAYOUTS.find((l) => l.key === layout)!.cols;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-semibold">Live View</h1>
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <select
            value={locationFilter}
            onChange={(e) => {
              setLocationFilter(e.target.value);
              setPage(0);
            }}
            className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
            aria-label="Filter by location"
          >
            <option value="all">All locations</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
            <option value="none">No location</option>
          </select>
          <div className="flex overflow-hidden rounded border border-slate-700" role="group" aria-label="Grid layout">
            {LAYOUTS.map((l) => (
              <button
                key={l.key}
                onClick={() => {
                  setLayout(l.key);
                  setPage(0);
                }}
                className={`px-2 py-1 ${layout === l.key ? "bg-slate-700 text-white" : "text-slate-400 hover:bg-slate-800"}`}
              >
                {l.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {error && <p className="text-red-400">{error}</p>}
      {!cameras && !error && <p className="text-slate-400">Loading cameras...</p>}

      {cameras && filtered.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-700 p-8 text-center text-slate-400">
          No cameras here yet.{" "}
          <Link href="/dashboard/cameras" className="text-emerald-400 hover:underline">
            Add a camera
          </Link>{" "}
          to watch it live.
        </div>
      )}

      {visible.length > 0 && (
        <div className={`grid gap-3 ${cols}`}>
          {visible.map((c) => (
            <LivePlayer key={c.id} cameraId={c.id} name={c.name} />
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button disabled={safePage === 0} onClick={() => setPage(safePage - 1)} className="rounded border border-slate-700 px-3 py-1 disabled:opacity-40">
            Previous
          </button>
          <span className="text-slate-400">
            Page {safePage + 1} of {pageCount}
          </span>
          <button
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage(safePage + 1)}
            className="rounded border border-slate-700 px-3 py-1 disabled:opacity-40"
          >
            Next
          </button>
        </div>
      )}

      <p className="text-xs text-slate-500">
        Live video is delayed a few seconds (HLS). Cameras connect only while someone is watching, unless they are
        recording.
      </p>
    </div>
  );
}
