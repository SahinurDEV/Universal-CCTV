"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ApiError, createCamera, discoverCameras, listCameras, type Camera, type DiscoveredDevice } from "@/lib/api";

type LoadState = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; cameras: Camera[] };

export default function CamerasPage() {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [showForm, setShowForm] = useState(false);

  async function load() {
    setState({ status: "loading" });
    try {
      const res = await listCameras();
      setState({ status: "ready", cameras: res.cameras });
    } catch {
      setState({ status: "error", message: "Could not load cameras. Is the API running?" });
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Cameras</h1>
        <button
          onClick={() => setShowForm((v) => !v)}
          className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white"
        >
          {showForm ? "Cancel" : "Add camera"}
        </button>
      </div>

      {showForm && (
        <AddCameraForm
          onCreated={() => {
            setShowForm(false);
            load();
          }}
        />
      )}

      {state.status === "loading" && <p className="text-slate-400">Loading cameras...</p>}

      {state.status === "error" && <p className="text-red-400">{state.message}</p>}

      {state.status === "ready" && state.cameras.length === 0 && (
        <div className="rounded-lg border border-dashed border-slate-700 p-8 text-center text-slate-400">
          No cameras yet. Add one to get started.
        </div>
      )}

      {state.status === "ready" && state.cameras.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-800">
          <table className="w-full text-left text-sm">
            <thead className="border-b border-slate-800 text-slate-400">
              <tr>
                <th className="p-3">Name</th>
                <th className="p-3">Connector</th>
                <th className="p-3">Host</th>
                <th className="p-3">Support tier</th>
                <th className="p-3" />
              </tr>
            </thead>
            <tbody>
              {state.cameras.map((camera) => (
                <tr key={camera.id} className="border-b border-slate-900">
                  <td className="p-3">{camera.name}</td>
                  <td className="p-3">{camera.connectorType}</td>
                  <td className="p-3 text-slate-400">
                    {camera.host}:{camera.port}
                  </td>
                  <td className="p-3">
                    <SupportTierBadge tier={camera.capability?.supportTier ?? "UNSUPPORTED"} />
                  </td>
                  <td className="p-3 text-right">
                    <Link href={`/dashboard/cameras/${camera.id}`} className="text-emerald-400 hover:underline">
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function SupportTierBadge({ tier }: { tier: string }) {
  const labels: Record<string, string> = {
    FULLY_SUPPORTED: "Fully supported",
    PARTIALLY_SUPPORTED: "Partially supported",
    CONNECTED_MISSING_CAPABILITIES: "Connected, missing capabilities",
    UNSUPPORTED: "Not yet connected",
  };
  return <span className="rounded bg-slate-800 px-2 py-1 text-xs text-slate-300">{labels[tier] ?? tier}</span>;
}

type DiscoveryState =
  | { status: "idle" }
  | { status: "scanning" }
  | { status: "done"; devices: DiscoveredDevice[]; note: string }
  | { status: "error" };

function DiscoverySection({ onPick }: { onPick: (device: DiscoveredDevice) => void }) {
  const [state, setState] = useState<DiscoveryState>({ status: "idle" });

  async function scan() {
    setState({ status: "scanning" });
    try {
      const res = await discoverCameras(5000);
      setState({ status: "done", devices: res.devices, note: res.note });
    } catch {
      setState({ status: "error" });
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-800 bg-slate-900/40 p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="text-sm font-medium">Find cameras automatically</p>
          <p className="text-xs text-slate-500">
            Scans the local network for ONVIF cameras (takes a few seconds). Only finds cameras on the
            same network as this server — won't work if the API is hosted elsewhere.
          </p>
        </div>
        <button
          type="button"
          onClick={scan}
          disabled={state.status === "scanning"}
          className="shrink-0 rounded border border-slate-700 px-3 py-2 text-sm hover:bg-slate-800 disabled:opacity-50"
        >
          {state.status === "scanning" ? "Scanning..." : "Scan network"}
        </button>
      </div>

      {state.status === "error" && <p className="text-sm text-red-400">Scan failed. Is the API running?</p>}

      {state.status === "done" && state.devices.length === 0 && (
        <p className="text-sm text-slate-400">No cameras found on this network.</p>
      )}

      {state.status === "done" && state.devices.length > 0 && (
        <ul className="space-y-2">
          {state.devices.map((device) => (
            <li
              key={`${device.host}:${device.port}`}
              className="flex items-center justify-between rounded border border-slate-800 px-3 py-2 text-sm"
            >
              <span>
                {device.host}:{device.port}
              </span>
              <button
                type="button"
                onClick={() => onPick(device)}
                className="text-emerald-400 hover:underline"
              >
                Use this
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AddCameraForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [connectorType, setConnectorType] = useState<"RTSP" | "ONVIF" | "SIMULATED">("RTSP");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("554");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function applyDiscoveredDevice(device: DiscoveredDevice) {
    setConnectorType("ONVIF");
    setHost(device.host);
    setPort(String(device.port));
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await createCamera({
        name,
        connectorType,
        host,
        port: Number(port),
        credential: username || password || path ? { username, password, path } : undefined,
      });
      onCreated();
    } catch (err) {
      if (err instanceof ApiError && err.body && typeof err.body === "object" && "error" in err.body) {
        const body = err.body as { error: string; message?: string };
        setError(
          body.error === "unsafe_host"
            ? body.message ?? "That host is not allowed."
            : `Could not create camera (${body.error}).`,
        );
      } else {
        setError("Could not create camera.");
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <DiscoverySection onPick={applyDiscoveredDevice} />

      <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-slate-800 p-4">
        <p className="text-sm text-slate-400">
          This registers the camera's connection details. After adding it, use{" "}
          <span className="text-slate-300">Test Connection</span> on the camera's page to actually verify
          it — nothing connects automatically yet when you just add a camera here.
        </p>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Name">
            <input required value={name} onChange={(e) => setName(e.target.value)} className={inputClass} />
          </Field>
          <Field label="Connector type">
            <select
              value={connectorType}
              onChange={(e) => setConnectorType(e.target.value as typeof connectorType)}
              className={inputClass}
            >
              <option value="RTSP">RTSP</option>
              <option value="ONVIF">ONVIF</option>
              <option value="SIMULATED">Simulated (dev only)</option>
            </select>
          </Field>
          <Field label="Host">
            <input
              required
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.50"
              className={inputClass}
            />
          </Field>
          <Field label="Port">
            <input
              required
              type="number"
              value={port}
              onChange={(e) => setPort(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="RTSP username (optional)">
            <input value={username} onChange={(e) => setUsername(e.target.value)} className={inputClass} />
          </Field>
          <Field label="RTSP password (optional)">
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={inputClass}
            />
          </Field>
          <Field label="Stream path (optional)">
            <input
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/stream1"
              className={inputClass}
            />
          </Field>
        </div>

        {error && <p className="text-sm text-red-400">{error}</p>}

        <button
          type="submit"
          disabled={submitting}
          className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {submitting ? "Adding..." : "Add camera"}
        </button>
      </form>
    </div>
  );
}

const inputClass = "w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-sm text-slate-400">{label}</span>
      {children}
    </label>
  );
}
