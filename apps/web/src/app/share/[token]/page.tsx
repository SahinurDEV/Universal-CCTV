"use client";

import { useEffect, useRef, useState } from "react";
import { useParams } from "next/navigation";
import Hls from "hls.js";
import { API_BASE_URL, ApiError, fetchSharedClip, openShare, type OpenedShare, type SharedClip } from "@/lib/api";

/** Public viewer for a share link. No login; cookies are never sent. */
export default function SharePage() {
  const { token } = useParams<{ token: string }>();
  const [share, setShare] = useState<OpenedShare | null>(null);
  const [needPassword, setNeedPassword] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const opened = useRef(false);

  const open = async (pw?: string) => {
    setLoading(true);
    setError(null);
    try {
      setShare(await openShare(token, pw));
      setNeedPassword(false);
    } catch (e) {
      const code = e instanceof ApiError ? (e.body as { error?: string })?.error : undefined;
      if (code === "password_required") setNeedPassword(true);
      else if (code === "wrong_password") { setNeedPassword(true); setError("Wrong password."); }
      else if (code === "too_many_requests") setError("Too many attempts. Try again later.");
      else setError("This link has expired, was revoked, or doesn't exist.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Opening counts as a view, so do it once (React strict mode runs effects twice in dev).
    if (opened.current) return;
    opened.current = true;
    void open();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  return (
    <main className="min-h-screen bg-slate-950 px-4 py-8 text-slate-100">
      <div className="mx-auto max-w-4xl space-y-4">
        <p className="text-xs uppercase tracking-wide text-slate-500">Universal CCTV · shared view</p>
        {loading && <p className="text-sm text-slate-400">Loading…</p>}
        {needPassword && !share && (
          <form onSubmit={(e) => { e.preventDefault(); void open(password); }} className="max-w-sm space-y-3 rounded-lg border border-slate-800 p-4">
            <p className="text-sm">This shared video is protected by a password.</p>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Password" autoFocus className="w-full rounded border border-slate-700 bg-slate-900 px-3 py-2 text-sm" />
            <button className="rounded bg-emerald-700 px-4 py-2 text-sm text-white">View</button>
          </form>
        )}
        {error && <p className="text-sm text-red-400" data-testid="share-error">{error}</p>}
        {share && (
          <>
            <div>
              <h1 className="text-xl font-semibold">{share.cameraName}</h1>
              <p className="text-xs text-slate-400">
                {share.kind === "LIVE" ? "Live view" : `Recording ${new Date(share.clipStart!).toLocaleString()} – ${new Date(share.clipEnd!).toLocaleTimeString()}`}
                {" · "}link expires {new Date(share.expiresAt).toLocaleString()}
              </p>
            </div>
            {share.kind === "LIVE" ? <SharedLive url={`${API_BASE_URL}${share.playlistUrl}`} /> : <SharedClipPlayer clipUrl={share.clipUrl!} />}
          </>
        )}
      </div>
    </main>
  );
}

function SharedLive({ url }: { url: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let hls: Hls | null = null;
    if (Hls.isSupported()) {
      hls = new Hls({ lowLatencyMode: true });
      hls.on(Hls.Events.ERROR, (_e, d) => d.fatal && setErr("The live stream stopped (the link may have expired)."));
      hls.loadSource(url);
      hls.attachMedia(video);
    } else {
      video.src = url;
    }
    void video.play().catch(() => undefined);
    return () => hls?.destroy();
  }, [url]);
  return (
    <div className="space-y-2">
      <video ref={ref} data-testid="share-video" muted autoPlay playsInline controls className="aspect-video w-full rounded bg-black" />
      {err && <p className="text-sm text-amber-400">{err}</p>}
    </div>
  );
}

function SharedClipPlayer({ clipUrl }: { clipUrl: string }) {
  const ref = useRef<HTMLVideoElement>(null);
  const [clip, setClip] = useState<SharedClip | null>(null);
  const [idx, setIdx] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    fetchSharedClip(clipUrl).then(setClip).catch(() => setErr("This clip is no longer available."));
  }, [clipUrl]);
  const seg = clip?.segments[idx];
  if (err) return <p className="text-sm text-red-400">{err}</p>;
  if (!clip) return <p className="text-sm text-slate-400">Loading clip…</p>;
  if (!seg) return <p className="text-sm text-slate-400">No recording exists for this time range.</p>;
  return (
    <div className="space-y-2">
      <video
        key={seg.url}
        ref={ref}
        data-testid="share-video"
        src={seg.url}
        controls
        autoPlay
        muted
        playsInline
        className="aspect-video w-full rounded bg-black"
        onLoadedMetadata={(e) => { if (seg.offsetSec > 0) e.currentTarget.currentTime = seg.offsetSec; }}
        onTimeUpdate={(e) => {
          if (e.currentTarget.currentTime >= seg.untilSec) {
            e.currentTarget.pause();
            if (idx + 1 < clip.segments.length) setIdx(idx + 1);
          }
        }}
        onEnded={() => idx + 1 < clip.segments.length && setIdx(idx + 1)}
      />
      <p className="text-xs text-slate-500">Part {idx + 1} of {clip.segments.length}</p>
    </div>
  );
}
