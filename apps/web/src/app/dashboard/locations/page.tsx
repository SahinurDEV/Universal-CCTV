"use client";

import { useEffect, useState } from "react";
import {
  createLocation,
  deleteLocation,
  errorMessage,
  listCameras,
  listLocations,
  setCameraLocation,
  updateLocation,
  type Camera,
  type Location,
} from "@/lib/api";
import { useSession } from "@/lib/useSession";

const input = "w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm";

function timezones(): string[] {
  try {
    return (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf("timeZone");
  } catch {
    return ["UTC"];
  }
}

export default function LocationsPage() {
  const session = useSession();
  const [locations, setLocations] = useState<Location[] | null>(null);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<Location | "new" | null>(null);

  const role =
    session.status === "authenticated"
      ? session.session.tenants.find((t) => t.id === session.session.activeTenantId)?.role
      : undefined;
  const canManage = role === "OWNER" || role === "ADMIN";
  const canAssign = canManage || role === "OPERATOR";

  async function load() {
    try {
      const [l, c] = await Promise.all([listLocations(), listCameras()]);
      setLocations(l.locations);
      setCameras(c.cameras);
    } catch {
      setError("Could not load locations.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onDelete(loc: Location) {
    if (!confirm(`Delete "${loc.name}"? Its cameras are kept and become unassigned.`)) return;
    try {
      await deleteLocation(loc.id);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Could not delete location."));
    }
  }

  async function onAssign(cameraId: string, locationId: string) {
    try {
      await setCameraLocation(cameraId, locationId || null);
      await load();
    } catch (err) {
      setError(errorMessage(err, "Could not move camera."));
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Locations</h1>
          <p className="text-sm text-slate-400">Group cameras by site, e.g. &quot;Home&quot;, &quot;Shop&quot;, &quot;Warehouse&quot;.</p>
        </div>
        {canManage && (
          <button onClick={() => setEditing("new")} className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white">
            Add location
          </button>
        )}
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {editing && (
        <LocationForm
          initial={editing === "new" ? null : editing}
          onCancel={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}

      {!locations && !error && <p className="text-slate-400">Loading...</p>}

      {locations && locations.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-700 p-8 text-center text-slate-400">
          No locations yet.{canManage ? " Add your first site to organise cameras." : ""}
        </div>
      )}

      {locations && locations.length > 0 && (
        <div className="grid gap-4 md:grid-cols-2">
          {locations.map((loc) => (
            <div key={loc.id} className="rounded-lg border border-slate-800 p-4">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{loc.name}</p>
                  {loc.address && <p className="text-sm text-slate-400">{loc.address}</p>}
                  <p className="text-xs text-slate-500">
                    {loc.timezone} · {loc.cameraCount} camera{loc.cameraCount === 1 ? "" : "s"}
                  </p>
                </div>
                {canManage && (
                  <div className="flex gap-3 text-xs">
                    <button onClick={() => setEditing(loc)} className="text-slate-300 hover:underline">
                      Edit
                    </button>
                    <button onClick={() => onDelete(loc)} className="text-red-400 hover:underline">
                      Delete
                    </button>
                  </div>
                )}
              </div>
              <ul className="mt-3 space-y-1 text-sm">
                {cameras
                  .filter((c) => c.locationId === loc.id)
                  .map((c) => (
                    <li key={c.id} className="text-slate-300">
                      • {c.name}
                    </li>
                  ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      {cameras.length > 0 && locations && locations.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-lg font-medium">Assign cameras</h2>
          <div className="overflow-x-auto rounded-lg border border-slate-800">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-900 text-slate-400">
                <tr>
                  <th className="px-4 py-2">Camera</th>
                  <th className="px-4 py-2">Location</th>
                </tr>
              </thead>
              <tbody>
                {cameras.map((c) => (
                  <tr key={c.id} className="border-t border-slate-800">
                    <td className="px-4 py-2">{c.name}</td>
                    <td className="px-4 py-2">
                      <select
                        disabled={!canAssign}
                        value={c.locationId ?? ""}
                        onChange={(e) => onAssign(c.id, e.target.value)}
                        className="rounded border border-slate-700 bg-slate-900 px-2 py-1"
                        aria-label={`Location for ${c.name}`}
                      >
                        <option value="">No location</option>
                        {locations.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}

function LocationForm({ initial, onCancel, onSaved }: { initial: Location | null; onCancel: () => void; onSaved: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [address, setAddress] = useState(initial?.address ?? "");
  const [timezone, setTimezone] = useState(
    initial?.timezone ?? (typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC"),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const body = { name, address: address || null, timezone };
      if (initial) await updateLocation(initial.id, body);
      else await createLocation(body);
      onSaved();
    } catch (err) {
      setError(errorMessage(err, "Could not save location."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-slate-800 p-4">
      <h2 className="font-medium">{initial ? "Edit location" : "New location"}</h2>
      <label className="block text-sm">
        Name
        <input required maxLength={200} value={name} onChange={(e) => setName(e.target.value)} className={input} />
      </label>
      <label className="block text-sm">
        Address (optional)
        <input maxLength={500} value={address} onChange={(e) => setAddress(e.target.value)} className={input} />
      </label>
      <label className="block text-sm">
        Time zone
        <select value={timezone} onChange={(e) => setTimezone(e.target.value)} className={input}>
          {timezones().map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
      </label>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <div className="flex gap-2">
        <button disabled={saving} className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
          {saving ? "Saving..." : "Save"}
        </button>
        <button type="button" onClick={onCancel} className="rounded border border-slate-700 px-3 py-2 text-sm">
          Cancel
        </button>
      </div>
    </form>
  );
}
