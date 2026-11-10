import { useCallback, useEffect, useRef, useState } from "react";

export type SyncState = {
  running: boolean;
  step: string | null;
  unfetchedCount: number;
  // True while an ft child process is alive. False during the post-ft
  // rebuildCaches phase — cancel button disables itself there since there's
  // no subprocess to kill and the rebuild is short enough (~1s cached,
  // ~30s cold) that waiting through it is fine.
  canCancel: boolean;
  // Cancel was sent and ft is still saving its progress before it exits.
  // The UI shows "Cancelling..." instead of a second Cancel: another SIGINT
  // would kill ft mid-save.
  cancelling: boolean;
  // ft holds a resume cursor from a sync that stopped early (cancel, rate
  // limit, max runtime). The next Sync runs `ft sync --continue` first.
  resumePending: boolean;
  // Failure line from the last run ("ft sync: exited with code 1"), or
  // null. Server-side state, cleared when the next run starts. Also carries
  // a rejected /api/sync request (see startSync), which the server never
  // sees as a run.
  error: string | null;
};

const INITIAL: SyncState = {
  running: false,
  step: null,
  unfetchedCount: 0,
  canCancel: false,
  cancelling: false,
  resumePending: false,
  error: null,
};

export function useSync() {
  const [state, setState] = useState<SyncState>(INITIAL);
  // A request the server refused or never received. Kept apart from the
  // streamed state so the next SSE frame doesn't erase it.
  const [requestError, setRequestError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/sync-stream");
    esRef.current = es;
    es.onmessage = (e) => {
      try {
        const next = JSON.parse(e.data) as Partial<SyncState>;
        setState({ ...INITIAL, ...next });
      } catch {
        // ignore malformed messages
      }
    };
    es.onerror = () => {
      // EventSource auto-reconnects; nothing to do
    };
    return () => {
      es.close();
      esRef.current = null;
    };
  }, []);

  // Never throws: callers are click handlers with nothing useful to do with
  // a rejection. A 409 means a run is already going (double-click before
  // the stream reports `running`) and needs no message — the stream shows
  // that run.
  const startSync = useCallback(
    async (mode: "all" | "bookmarks-rebuild" | "media" | "gaps" = "all") => {
      setRequestError(null);
      let res: Response;
      try {
        res = await fetch(`/api/sync?mode=${mode}`, { method: "POST" });
      } catch {
        setRequestError("Sync request failed: server unreachable.");
        return;
      }
      if (res.ok || res.status === 409) return;
      const body = await res.json().catch(() => ({}));
      setRequestError(
        `Sync request failed: ${body.error || `HTTP ${res.status}`}.`
      );
    },
    []
  );

  // Fire-and-forget: the server emits the state change via SSE, so the local
  // state updates through the same path as normal progress events. No need to
  // wait on the POST response.
  const cancelSync = useCallback(async () => {
    await fetch("/api/sync/cancel", { method: "POST" }).catch(() => {});
  }, []);

  return {
    ...state,
    error: requestError ?? state.error,
    startSync,
    cancelSync,
  };
}
