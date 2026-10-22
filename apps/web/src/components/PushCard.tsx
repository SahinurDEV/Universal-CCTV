"use client";

import { useCallback, useEffect, useState } from "react";
import {
  errorMessage,
  getPushConfig,
  listPushDevices,
  removePushDevice,
  savePushSubscription,
  sendTestPush,
  type PushDevice,
} from "@/lib/api";

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function deviceName(ua: string | null): string {
  if (!ua) return "Unknown device";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone/iPad" : /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Device";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  return `${browser} on ${os}`;
}

/** Settings card: subscribe this device to Web Push, list/remove devices. */
export function PushCard() {
  const [serverEnabled, setServerEnabled] = useState<boolean | null>(null);
  const [publicKey, setPublicKey] = useState<string | null>(null);
  const [devices, setDevices] = useState<PushDevice[]>([]);
  const [thisEndpointHost, setThisEndpointHost] = useState<string | null>(null);
  const [subscribedHere, setSubscribedHere] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const supported = typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

  const load = useCallback(async () => {
    try {
      const [cfg, list] = await Promise.all([getPushConfig(), listPushDevices()]);
      setServerEnabled(cfg.enabled);
      setPublicKey(cfg.publicKey);
      setDevices(list.subscriptions);
      if (supported) {
        const reg = await navigator.serviceWorker.getRegistration("/");
        const sub = await reg?.pushManager.getSubscription();
        setSubscribedHere(Boolean(sub));
        setThisEndpointHost(sub ? new URL(sub.endpoint).hostname : null);
      }
    } catch (err) {
      setMsg(errorMessage(err, "Could not load push settings."));
    }
  }, [supported]);

  useEffect(() => {
    load();
  }, [load]);

  async function enable() {
    if (!publicKey) return;
    setBusy(true);
    setMsg(null);
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setMsg("Notifications are blocked for this site. Allow them in your browser settings and try again.");
        return;
      }
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" });
      await navigator.serviceWorker.ready;
      const sub =
        (await reg.pushManager.getSubscription()) ??
        (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) }));
      await savePushSubscription(sub.toJSON(), navigator.userAgent);
      setMsg("Push notifications are on for this device.");
      await load();
    } catch (err) {
      setMsg(errorMessage(err, "Could not turn on push notifications on this device."));
    } finally {
      setBusy(false);
    }
  }

  async function disableHere() {
    setBusy(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const sub = await reg?.pushManager.getSubscription();
      await sub?.unsubscribe();
      setMsg("Turned off on this device. Remove it from the list below too if it's still shown.");
      await load();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3 rounded-lg border border-slate-800 p-4">
      <h2 className="font-medium">Phone &amp; browser notifications</h2>
      <p className="text-sm text-slate-400">
        Get alerts as push notifications on this device, even when the app is closed. Which alerts you get follows your
        Alert preferences above.
      </p>
      {serverEnabled === false && (
        <p className="text-sm text-amber-400">Push notifications are not set up on this server (VAPID keys missing).</p>
      )}
      {serverEnabled && !supported && (
        <p className="text-sm text-amber-400">
          This browser doesn&apos;t support push notifications. On iPhone, first add the site to your Home Screen (Share →
          Add to Home Screen) and open it from there.
        </p>
      )}
      {serverEnabled && supported && (
        <div className="flex flex-wrap gap-2">
          {!subscribedHere ? (
            <button onClick={enable} disabled={busy} className="rounded bg-emerald-600 px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
              Turn on for this device
            </button>
          ) : (
            <button onClick={disableHere} disabled={busy} className="rounded border border-slate-700 px-3 py-2 text-sm">
              Turn off for this device
            </button>
          )}
          {devices.length > 0 && (
            <button
              onClick={async () => {
                try {
                  const r = await sendTestPush();
                  setMsg(`Test sent to ${r.sent} of ${r.devices} device(s).`);
                } catch (err) {
                  setMsg(errorMessage(err, "Could not send a test."));
                }
              }}
              className="rounded border border-slate-700 px-3 py-2 text-sm"
            >
              Send test notification
            </button>
          )}
        </div>
      )}
      {devices.length > 0 && (
        <ul className="space-y-2 text-sm">
          {devices.map((d) => (
            <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-slate-800 px-3 py-2">
              <div>
                <p>
                  {deviceName(d.userAgent)}
                  {subscribedHere && thisEndpointHost === d.service && devices.length === 1 && (
                    <span className="ml-1 text-xs text-emerald-400">(this device)</span>
                  )}
                </p>
                <p className="text-xs text-slate-500">
                  Added {new Date(d.createdAt).toLocaleDateString()}
                  {d.lastSuccessAt && <> · last delivered {new Date(d.lastSuccessAt).toLocaleString()}</>}
                </p>
              </div>
              <button
                onClick={async () => {
                  await removePushDevice(d.id);
                  await load();
                }}
                className="text-xs text-red-400 hover:underline"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="text-sm text-slate-400">{msg}</p>}
    </div>
  );
}
