"use client";

import { useEffect, useState } from "react";
import { getSnapshotUrl } from "@/lib/api";

/** Thumbnail of a motion-event snapshot (signed, short-lived URL). */
export function SnapshotThumb({ eventId, className = "h-16 w-28" }: { eventId: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    getSnapshotUrl(eventId)
      .then((r) => alive && setUrl(r.url))
      .catch(() => alive && setFailed(true));
    return () => {
      alive = false;
    };
  }, [eventId]);
  if (failed) return null;
  if (!url) return <div className={`${className} animate-pulse rounded bg-slate-800`} />;
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" title="Open snapshot">
      {/* eslint-disable-next-line @next/next/no-img-element -- signed external URL, not optimizable */}
      <img src={url} alt="Motion snapshot" className={`${className} rounded object-cover`} loading="lazy" />
    </a>
  );
}
