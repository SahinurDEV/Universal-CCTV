"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { getStorageUsage, type StorageUsage } from "@/lib/api";

function formatBytes(bytesStr: string): string {
  const bytes = Number(bytesStr);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(2)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export default function StoragePage() {
  const [usage, setUsage] = useState<StorageUsage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStorageUsage()
      .then(setUsage)
      .catch(() => setError("Could not load storage usage."));
  }, []);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Storage</h1>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {usage && (
        <>
          <div className="rounded-lg border border-slate-800 p-4">
            <p className="text-xs text-slate-400">Total storage in use</p>
            <p className="mt-1 text-2xl font-semibold">{formatBytes(usage.totalBytes)}</p>
            <p className="mt-2 text-xs text-slate-500">
              Real sizes of currently-stored recording segments (sums uploaded + not-yet-deleted
              segments). There's no storage quota or billing tied to this yet — see docs/requirements.md.
            </p>
          </div>

          {usage.byCamera.length === 0 ? (
            <div className="rounded-lg border border-dashed border-slate-700 p-8 text-center text-slate-400">
              No recordings stored yet.
            </div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-slate-800">
              <table className="w-full text-left text-sm">
                <thead className="border-b border-slate-800 text-slate-400">
                  <tr>
                    <th className="p-3">Camera</th>
                    <th className="p-3">Segments</th>
                    <th className="p-3">Storage used</th>
                    <th className="p-3" />
                  </tr>
                </thead>
                <tbody>
                  {usage.byCamera.map((c) => (
                    <tr key={c.cameraId} className="border-b border-slate-900">
                      <td className="p-3">{c.cameraName}</td>
                      <td className="p-3 text-slate-400">{c.segmentCount}</td>
                      <td className="p-3 text-slate-400">{formatBytes(c.bytes)}</td>
                      <td className="p-3 text-right">
                        <Link href={`/dashboard/cameras/${c.cameraId}`} className="text-emerald-400 hover:underline">
                          View camera
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
