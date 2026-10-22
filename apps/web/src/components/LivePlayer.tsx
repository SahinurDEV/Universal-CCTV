"use client";

import { useEffect, useRef, useState } from "react";
import Hls from "hls.js";
import { API_BASE_URL, errorMessage, startLive } from "@/lib/api";

type Status = "starting" | "connecting" | "playing" | "error";

/**
 * Plays one camera's live stream. The API checks the session + workspace and
 * proxies MediaMTX's HLS output; the session cookie is sent with every
 * playlist/segment request (withCredentials), so the stream stops as soon as
 * the session is revoked.
 */
export function LivePlayer({ cameraId, name }: { cameraId: string; name: string }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [status, setStatus] = useState<Status>("starting");
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let hls: Hls | null = null;
    let cancelled = false;
    const video = videoRef.current;
    if (!video) return;

    setStatus("starting");
    setError(null);

    startLive(cameraId)
      .then(({ playlistUrl }) => {
        if (cancelled) return;
        setStatus("connecting");
        const src = `${API_BASE_URL}${playlistUrl}`;
        if (Hls.isSupported()) {
          hls = new Hls({
            liveSyncDurationCount: 2,
            manifestLoadingMaxRetry: 20,
            manifestLoadingRetryDelay: 1000,
            levelLoadingMaxRetry: 20,
            xhrSetup: (xhr) => {
              xhr.withCredentials = true;
            },
          });
          hls.on(Hls.Events.ERROR, (_e, data) => {
            if (data.fatal) {
              setStatus("error");
              setError("The stream stopped. Check that the camera is online.");
              hls?.destroy();
            }
          });
          hls.loadSource(src);
          hls.attachMedia(video);
        } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
          // Safari plays HLS natively and sends cookies for same-site requests.
          video.src = src;
        } else {
          setStatus("error");
          setError("This browser cannot play live video.");
        }
      })
      .catch((err) => {
        if (cancelled) return;
        setStatus("error");
        setError(errorMessage(err, "Could not start the live stream."));
      });

    const onPlaying = () => setStatus("playing");
    video.addEventListener("playing", onPlaying);

    return () => {
      cancelled = true;
      video.removeEventListener("playing", onPlaying);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [cameraId, attempt]);

  return (
    <div className="overflow-hidden rounded-lg border border-slate-800 bg-black">
      <div className="relative aspect-video">
        <video ref={videoRef} className="h-full w-full" muted autoPlay playsInline controls={status === "playing"} />
        {status !== "playing" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 p-4 text-center text-sm text-slate-400">
            {status === "error" ? (
              <>
                <p className="text-red-400">{error}</p>
                <button onClick={() => setAttempt((n) => n + 1)} className="rounded border border-slate-600 px-2 py-1 text-xs text-slate-200">
                  Retry
                </button>
              </>
            ) : (
              <p>{status === "starting" ? "Starting stream..." : "Connecting to camera..."}</p>
            )}
          </div>
        )}
      </div>
      <div className="flex items-center justify-between px-3 py-2 text-sm">
        <span className="truncate">{name}</span>
        <span className={`flex items-center gap-1 text-xs ${status === "playing" ? "text-red-400" : "text-slate-500"}`}>
          <span className={`h-2 w-2 rounded-full ${status === "playing" ? "bg-red-500" : "bg-slate-600"}`} />
          {status === "playing" ? "LIVE" : status === "error" ? "Offline" : "..."}
        </span>
      </div>
    </div>
  );
}
