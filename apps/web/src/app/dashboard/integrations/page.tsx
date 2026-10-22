"use client";

import { useEffect, useState } from "react";
import {
  createWebhook,
  deleteIntegration,
  errorMessage,
  listIntegrations,
  testIntegration,
  updateIntegration,
  type Integration,
  type IntegrationCatalogItem,
} from "@/lib/api";
import { useSession } from "@/lib/useSession";

const input = "w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm";
const STATUS_LABEL: Record<IntegrationCatalogItem["status"], string> = {
  available: "Available",
  built_in: "Built in",
  planned: "Coming later",
};

export default function IntegrationsPage() {
  const session = useSession();
  const [data, setData] = useState<{ catalog: IntegrationCatalogItem[]; eventTypes: string[]; integrations: Integration[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [secret, setSecret] = useState<{ name: string; value: string } | null>(null);
  const [testResult, setTestResult] = useState<Record<string, string>>({});

  const role =
    session.status === "authenticated"
      ? session.session.tenants.find((t) => t.id === session.session.activeTenantId)?.role
      : undefined;
  const canManage = role === "OWNER" || role === "ADMIN";

  async function load() {
    try {
      setData(await listIntegrations());
    } catch {
      setError("Could not load integrations.");
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function run(id: string, fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      await load();
    } catch (err) {
      setError(errorMessage(err, "Action failed."));
    }
    void id;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Integrations</h1>
        <p className="text-sm text-slate-400">Send alerts to other tools.</p>
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}

      {secret && (
        <div className="rounded-lg border border-amber-700 bg-amber-950/30 p-4 text-sm">
          <p className="font-medium text-amber-300">Signing secret for “{secret.name}” — copy it now, it will not be shown again.</p>
          <code className="mt-2 block break-all rounded bg-slate-900 p-2">{secret.value}</code>
          <p className="mt-2 text-slate-400">
            Each request has headers <code>X-CCTV-Timestamp</code> and <code>X-CCTV-Signature: sha256=HMAC(secret, timestamp + &quot;.&quot; + body)</code>.
          </p>
          <button onClick={() => setSecret(null)} className="mt-2 text-xs text-slate-300 hover:underline">
            I saved it
          </button>
        </div>
      )}

      <section className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-medium">Webhooks</h2>
          {canManage && (
            <button onClick={() => setShowForm((v) => !v)} className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white">
              {showForm ? "Cancel" : "Add webhook"}
            </button>
          )}
        </div>

        {showForm && data && (
          <WebhookForm
            eventTypes={data.eventTypes}
            onCreated={(i) => {
              setShowForm(false);
              if (i.signingSecret) setSecret({ name: i.name, value: i.signingSecret });
              load();
            }}
          />
        )}

        {data && data.integrations.length === 0 && (
          <div className="rounded-lg border border-dashed border-slate-700 p-6 text-center text-sm text-slate-400">
            No webhooks yet. A webhook receives every new alert (camera offline, recording stopped, storage almost full...).
          </div>
        )}

        {data?.integrations.map((i) => (
          <div key={i.id} className="rounded-lg border border-slate-800 p-4 text-sm">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-medium">
                  {i.name}{" "}
                  <span className={`ml-2 rounded px-1.5 py-0.5 text-xs ${i.isEnabled ? "bg-emerald-900 text-emerald-300" : "bg-slate-800 text-slate-400"}`}>
                    {i.isEnabled ? "On" : "Off"}
                  </span>
                </p>
                <p className="break-all text-slate-400">{i.url}</p>
                <p className="text-xs text-slate-500">
                  Events: {i.events.length ? i.events.join(", ") : "all alerts"}
                  {i.lastDeliveryAt && ` · Last delivery ${new Date(i.lastDeliveryAt).toLocaleString()}: ${i.lastDeliveryStatus}`}
                </p>
                {testResult[i.id] && <p className="text-xs text-slate-300">Test: {testResult[i.id]}</p>}
              </div>
              {canManage && (
                <div className="flex flex-wrap gap-3 text-xs">
                  <button
                    onClick={async () => {
                      try {
                        const r = await testIntegration(i.id);
                        setTestResult((t) => ({ ...t, [i.id]: r.ok ? `OK (HTTP ${r.status})` : `Failed (${r.status ?? r.error})` }));
                        await load();
                      } catch (err) {
                        setTestResult((t) => ({ ...t, [i.id]: errorMessage(err, "failed") }));
                      }
                    }}
                    className="text-slate-300 hover:underline"
                  >
                    Send test
                  </button>
                  <button onClick={() => run(i.id, () => updateIntegration(i.id, { isEnabled: !i.isEnabled }))} className="text-slate-300 hover:underline">
                    {i.isEnabled ? "Turn off" : "Turn on"}
                  </button>
                  <button
                    onClick={() =>
                      run(i.id, async () => {
                        if (!confirm("Create a new signing secret? The old one stops working immediately.")) return;
                        const r = await updateIntegration(i.id, { rotateSecret: true });
                        if (r.signingSecret) setSecret({ name: r.name, value: r.signingSecret });
                      })
                    }
                    className="text-slate-300 hover:underline"
                  >
                    New secret
                  </button>
                  <button
                    onClick={() =>
                      run(i.id, async () => {
                        if (confirm(`Delete webhook "${i.name}"?`)) await deleteIntegration(i.id);
                      })
                    }
                    className="text-red-400 hover:underline"
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
      </section>

      {data && (
        <section className="space-y-3">
          <h2 className="text-lg font-medium">All integrations</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {data.catalog.map((c) => (
              <div key={c.key} className="rounded-lg border border-slate-800 p-4 text-sm">
                <div className="flex items-center justify-between">
                  <p className="font-medium">{c.name}</p>
                  <span className={`rounded px-1.5 py-0.5 text-xs ${c.status === "planned" ? "bg-slate-800 text-slate-400" : "bg-emerald-900 text-emerald-300"}`}>
                    {STATUS_LABEL[c.status]}
                  </span>
                </div>
                <p className="mt-1 text-slate-400">{c.description}</p>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

function WebhookForm({ eventTypes, onCreated }: { eventTypes: string[]; onCreated: (i: Integration) => void }) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      onCreated(await createWebhook({ name, url, events }));
    } catch (err) {
      setError(errorMessage(err, "Could not create webhook."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="space-y-3 rounded-lg border border-slate-800 p-4">
      <label className="block text-sm">
        Name
        <input required maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className={input} placeholder="e.g. Zapier" />
      </label>
      <label className="block text-sm">
        URL
        <input required type="url" value={url} onChange={(e) => setUrl(e.target.value)} className={input} placeholder="https://hooks.example.com/..." />
      </label>
      <fieldset className="text-sm">
        <legend className="mb-1">Events (none selected = all)</legend>
        <div className="flex flex-wrap gap-3">
          {eventTypes.map((t) => (
            <label key={t} className="flex items-center gap-1">
              <input
                type="checkbox"
                checked={events.includes(t)}
                onChange={(e) => setEvents((ev) => (e.target.checked ? [...ev, t] : ev.filter((x) => x !== t)))}
              />
              {t.replace(/_/g, " ").toLowerCase()}
            </label>
          ))}
        </div>
      </fieldset>
      {error && <p className="text-sm text-red-400">{error}</p>}
      <button disabled={saving} className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
        {saving ? "Saving..." : "Create webhook"}
      </button>
    </form>
  );
}
