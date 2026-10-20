"use client";

import { useCallback, useEffect, useState } from "react";
import { ApiError, fetchMe, type SessionInfo } from "./api";

export type SessionState =
  | { status: "loading" }
  | { status: "authenticated"; session: SessionInfo }
  | { status: "unauthenticated" };

export function useSession() {
  const [state, setState] = useState<SessionState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const session = await fetchMe();
      setState({ status: "authenticated", session });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setState({ status: "unauthenticated" });
      } else {
        // Treat any other failure (network error, 500, etc.) as
        // unauthenticated for routing purposes, but this is a real failure,
        // not a confirmed "not logged in" — surfaced via console so it isn't
        // silently swallowed.
        console.error("Failed to load session", err);
        setState({ status: "unauthenticated" });
      }
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { ...state, refresh };
}
