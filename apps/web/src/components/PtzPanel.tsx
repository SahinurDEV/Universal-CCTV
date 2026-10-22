"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  errorMessage,
  getAudioInfo,
  getPtz,
  ptzGotoPreset,
  ptzMove,
  ptzRemovePreset,
  ptzSetPreset,
  ptzStop,
  sendTalkClip,
  type AudioInfo,
  type PtzInfo,
} from "@/lib/api";

const SPEED = 0.5;
type Dir = { x?: number; y?: number; zoom?: number };
const PAD: { label: string; dir: Dir; aria: string }[] = [
  { label: "↖", dir: { x: -SPEED, y: SPEED }, aria: "Up left" },
  { label: "▲", dir: { y: SPEED }, aria: "Up" },
  { label: "↗", dir: { x: SPEED, y: SPEED }, aria: "Up right" },
  { label: "◀", dir: { x: -SPEED }, aria: "Left" },
  { label: "■", dir: {}, aria: "Stop" },
  { label: "▶", dir: { x: SPEED }, aria: "Right" },
  { label: "↙", dir: { x: -SPEED, y: -SPEED }, aria: "Down left" },
  { label: "▼", dir: { y: -SPEED }, aria: "Down" },
  { label: "↘", dir: { x: SPEED, y: -SPEED }, aria: "Down right" },
];

/**
 * PTZ joystick + presets and push-to-talk. Renders nothing unless the camera
 * reported PTZ (ONVIF capability probe) or a talk backchannel. Controls only
 * for Operator and above (the API enforces this too).
 */
export function PtzPanel({ cameraId }: { cameraId: string }) {
  const [ptz, setPtz] = useState<PtzInfo | null>(null);
  const [audio, setAudio] = useState<AudioInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [presetName, setPresetName] = useState("");
  const [talkState, setTalkState] = useState<"idle" | "recording" | "sending">("idle");
  const [talkMsg, setTalkMsg] = useState<string | null>(null);
  const holdTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const recorder = useRef<MediaRecorder | null>(null);

  const refresh = useCallback(() => {
    getPtz(cameraId).then(setPtz).catch((e) => setError(errorMessage(e, "Camera control failed")));
  }, [cameraId]);

  useEffect(() => {
    refresh();
    getAudioInfo(cameraId).then(setAudio).catch(() => setAudio(null));
    return () => {
      if (holdTimer.current) clearInterval(holdTimer.current);
    };
  }, [cameraId, refresh]);

  const start = (dir: Dir) => {
    setError(null);
    if (!dir.x && !dir.y && !dir.zoom) {
      void ptzStop(cameraId).catch((e) => setError(errorMessage(e, "Camera control failed")));
      return;
    }
    // The camera auto-stops after timeoutMs, so a lost "stop" (closed tab,
    // dropped network) can't leave it spinning. Re-send while held.
    const send = () => ptzMove(cameraId, { ...dir, timeoutMs: 1500 }).catch((e) => setError(errorMessage(e, "Camera control failed")));
    void send();
    if (holdTimer.current) clearInterval(holdTimer.current);
    holdTimer.current = setInterval(send, 1000);
  };
  const end = () => {
    if (!holdTimer.current) return;
    clearInterval(holdTimer.current);
    holdTimer.current = null;
    void ptzStop(cameraId).catch((e) => setError(errorMessage(e, "Camera control failed")));
  };

  const hold = (dir: Dir) => ({
    onPointerDown: (e: React.PointerEvent) => {
      e.preventDefault();
      start(dir);
    },
    onPointerUp: end,
    onPointerLeave: end,
  });

  const savePreset = async () => {
    if (!presetName.trim()) return;
    try {
      await ptzSetPreset(cameraId, presetName.trim());
      setPresetName("");
      refresh();
    } catch (e) {
      setError(errorMessage(e, "Camera control failed"));
    }
  };

  const startTalk = async () => {
    setTalkMsg(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const rec = new MediaRecorder(stream);
      const chunks: Blob[] = [];
      rec.ondataavailable = (ev) => chunks.push(ev.data);
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setTalkState("sending");
        try {
          const r = await sendTalkClip(cameraId, new Blob(chunks, { type: rec.mimeType || "audio/webm" }));
          setTalkMsg(`Played ${r.seconds}s on the camera speaker.`);
        } catch (e) {
          setTalkMsg(errorMessage(e, "Camera control failed"));
        } finally {
          setTalkState("idle");
        }
      };
      recorder.current = rec;
      rec.start();
      setTalkState("recording");
      setTimeout(() => rec.state === "recording" && rec.stop(), 30000);
    } catch {
      setTalkMsg("Microphone permission was denied (or this page is not served over HTTPS).");
    }
  };
  const stopTalk = () => recorder.current?.state === "recording" && recorder.current.stop();

  if (!ptz?.supported && !audio?.talk) return null;
  const canControl = Boolean(ptz?.canControl);

  return (
    <div className="space-y-4 rounded-lg border border-slate-800 bg-slate-900/40 p-4" data-testid="ptz-panel">
      {ptz?.supported && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold text-slate-200">Pan / tilt / zoom</h3>
          {!canControl ? (
            <p className="text-xs text-slate-400">Only Operators, Admins and Owners can move this camera.</p>
          ) : (
            <div className="flex flex-wrap items-start gap-6">
              <div className="grid w-36 grid-cols-3 gap-1 select-none">
                {PAD.map((b) => (
                  <button key={b.aria} aria-label={b.aria} {...hold(b.dir)} className="rounded bg-slate-800 py-2 text-slate-100 hover:bg-slate-700 active:bg-emerald-800">
                    {b.label}
                  </button>
                ))}
              </div>
              {ptz.zoom && (
                <div className="flex flex-col gap-1 select-none">
                  <button aria-label="Zoom in" {...hold({ zoom: SPEED })} className="rounded bg-slate-800 px-4 py-2 text-slate-100 hover:bg-slate-700">＋</button>
                  <button aria-label="Zoom out" {...hold({ zoom: -SPEED })} className="rounded bg-slate-800 px-4 py-2 text-slate-100 hover:bg-slate-700">－</button>
                </div>
              )}
              <div className="min-w-48 flex-1 space-y-2">
                <p className="text-xs uppercase text-slate-500">Presets</p>
                {ptz.presets.length === 0 && <p className="text-xs text-slate-500">No presets yet.</p>}
                <ul className="space-y-1">
                  {ptz.presets.map((p) => (
                    <li key={p.token} className="flex items-center gap-2 text-sm">
                      <button onClick={() => ptzGotoPreset(cameraId, p.token).catch((e) => setError(errorMessage(e, "Camera control failed")))} className="rounded border border-slate-700 px-2 py-1 text-slate-200 hover:bg-slate-800">
                        {p.name}
                      </button>
                      <button onClick={() => ptzRemovePreset(cameraId, p.token).then(refresh).catch((e) => setError(errorMessage(e, "Camera control failed")))} className="text-xs text-red-400">
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
                <div className="flex gap-2">
                  <input value={presetName} onChange={(e) => setPresetName(e.target.value)} maxLength={40} placeholder="Preset name" className="w-36 rounded border border-slate-700 bg-slate-950 px-2 py-1 text-sm" />
                  <button onClick={savePreset} className="rounded bg-emerald-700 px-3 py-1 text-sm text-white hover:bg-emerald-600">Save position</button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      {audio?.talk && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-slate-200">Talk</h3>
          {audio.canTalk ? (
            <>
              <button
                onPointerDown={startTalk}
                onPointerUp={stopTalk}
                disabled={talkState === "sending"}
                className={`rounded px-4 py-2 text-sm text-white ${talkState === "recording" ? "bg-red-700" : "bg-slate-700 hover:bg-slate-600"}`}
              >
                {talkState === "recording" ? "Recording… release to send" : talkState === "sending" ? "Sending…" : "Hold to talk"}
              </button>
              <p className="text-xs text-slate-500">
                Push-to-talk: your clip is sent when you release (max 30 s), so there is a delay of a few seconds. Not a live phone call.
              </p>
            </>
          ) : (
            <p className="text-xs text-slate-400">Only Operators, Admins and Owners can talk through this camera.</p>
          )}
          {talkMsg && <p className="text-xs text-slate-300">{talkMsg}</p>}
        </div>
      )}
      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
