"use client";

import { useEffect, useState } from "react";
import {
  ApiError,
  cancelSubscription,
  changeSubscriptionPlan,
  getSubscription,
  listPublicPlans,
  type SubscriptionInfo,
  type SubscriptionPlan,
} from "@/lib/api";

function formatBytes(bytesStr: string): string {
  const bytes = Number(bytesStr);
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
  const over = used > limit;
  return (
    <div>
      <div className="flex justify-between text-sm">
        <span className="text-slate-400">{label}</span>
        <span className={over ? "text-red-400" : "text-slate-300"}>
          {used} / {limit}
        </span>
      </div>
      <div className="mt-1 h-2 overflow-hidden rounded bg-slate-800">
        <div
          className={`h-full ${over ? "bg-red-500" : "bg-emerald-500"}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function SubscriptionPage() {
  const [info, setInfo] = useState<SubscriptionInfo | null>(null);
  const [plans, setPlans] = useState<SubscriptionPlan[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const [sub, planList] = await Promise.all([getSubscription(), listPublicPlans()]);
      setInfo(sub);
      setPlans(planList.plans);
    } catch {
      setError("Could not load subscription info.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function onSwitchPlan(planKey: string) {
    if (!confirm(`Switch to this plan? This uses the development billing provider — no real payment is made.`)) {
      return;
    }
    setBusy(true);
    setActionError(null);
    try {
      await changeSubscriptionPlan(planKey);
      await load();
    } catch (err) {
      setActionError(err instanceof ApiError ? "Could not switch plans." : "Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function onCancel() {
    if (!confirm("Cancel your subscription?")) return;
    setBusy(true);
    setActionError(null);
    try {
      await cancelSubscription();
      await load();
    } catch {
      setActionError("Could not cancel the subscription.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Subscription</h1>

      <div className="rounded-lg border border-amber-800 bg-amber-950/30 p-3 text-sm text-amber-300">
        Development billing provider — plan changes here are simulated. No real payment is ever
        charged. See docs/subscriptions-and-billing.md.
      </div>

      {error && <p className="text-sm text-red-400">{error}</p>}
      {actionError && <p className="text-sm text-red-400">{actionError}</p>}

      {info && !info.subscription && (
        <div className="rounded-lg border border-dashed border-slate-700 p-6 text-sm text-slate-400">
          No subscription found for this workspace (subscription plans may not have been seeded).
        </div>
      )}

      {info?.subscription && info.usage && (
        <section className="space-y-4 rounded-lg border border-slate-800 p-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-lg font-medium">{info.subscription.plan.name}</p>
              <p className="text-sm text-slate-400">
                Status: {info.subscription.status}
                {info.subscription.currentPeriodEnd &&
                  ` · renews ${new Date(info.subscription.currentPeriodEnd).toLocaleDateString()}`}
              </p>
            </div>
            {info.subscription.status !== "CANCELED" && (
              <button
                onClick={onCancel}
                disabled={busy}
                className="rounded border border-red-800 px-3 py-1.5 text-sm text-red-400 hover:bg-red-950 disabled:opacity-50"
              >
                Cancel subscription
              </button>
            )}
          </div>

          <UsageBar label="Cameras" used={info.usage.cameraCount} limit={info.usage.cameraLimit} />
          <div>
            <div className="flex justify-between text-sm">
              <span className="text-slate-400">Storage</span>
              <span className="text-slate-300">
                {formatBytes(info.usage.storageBytesUsed)} / {formatBytes(info.usage.storageQuotaBytes)}
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded bg-slate-800">
              <div
                className="h-full bg-emerald-500"
                style={{
                  width: `${Math.min((Number(info.usage.storageBytesUsed) / Number(info.usage.storageQuotaBytes)) * 100, 100)}%`,
                }}
              />
            </div>
          </div>
        </section>
      )}

      {plans && (
        <section>
          <h2 className="mb-3 text-lg font-medium">Available plans</h2>
          <div className="grid gap-4 sm:grid-cols-3">
            {plans.map((plan) => {
              const isCurrent = info?.subscription?.plan.id === plan.id;
              return (
                <div
                  key={plan.id}
                  className={`rounded-lg border p-4 ${isCurrent ? "border-emerald-600" : "border-slate-800"}`}
                >
                  <p className="font-medium">{plan.name}</p>
                  <p className="mt-1 text-2xl font-semibold">
                    ${(plan.priceCentsMonthly / 100).toFixed(0)}
                    <span className="text-sm font-normal text-slate-400">/mo</span>
                  </p>
                  <ul className="mt-3 space-y-1 text-sm text-slate-400">
                    <li>{plan.cameraLimit} cameras</li>
                    <li>{plan.storageQuotaGb} GB storage</li>
                    <li>Up to {plan.maxRetentionDays} days retention</li>
                  </ul>
                  <button
                    onClick={() => onSwitchPlan(plan.key)}
                    disabled={busy || isCurrent}
                    className="mt-4 w-full rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-40"
                  >
                    {isCurrent ? "Current plan" : "Switch to this plan"}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
