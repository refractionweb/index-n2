import { useCallback, useEffect, useRef, useState } from "react";

// A JSON document the server stores whole (archived.json, collections.json):
// the client loads it, applies changes optimistically, and POSTs the full
// document back. The server keeps whatever body it received last.
//
// - No write before a successful load. A failed load (server not up yet,
//   network error) would otherwise leave the in-memory copy empty, and the
//   next change would POST a document built from nothing over the user's
//   file. A change made before the load succeeds retries the load first,
//   and is dropped if that fails too.
// - One POST in flight, carrying the state as of when it is sent. Changes
//   made while it is out coalesce into the next POST. Requests can't land
//   out of order, and a POST queued before a failure can't overwrite the
//   resync that follows it.
// - A failed POST reloads from the server, so the UI shows what's on disk.
//
// `parse` and `serialize` must be stable (module-level functions).
export function useServerDocument<T>({
  url,
  label,
  empty,
  parse,
  serialize,
}: {
  url: string;
  // For console messages: "archive", "collections".
  label: string;
  empty: T;
  // Throws on a malformed response.
  parse: (json: unknown) => T;
  serialize: (value: T) => unknown;
}) {
  const [value, setValue] = useState<T>(empty);
  // Ref mirror so two synchronous mutations both build on the latest state;
  // React state alone would hand the second one a stale closure value.
  const ref = useRef<T>(empty);
  const loadedRef = useRef(false);
  const loadingRef = useRef<Promise<void> | null>(null);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);

  const load = useCallback((): Promise<void> => {
    if (!loadingRef.current) {
      loadingRef.current = (async () => {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const next = parse(await res.json());
        ref.current = next;
        setValue(next);
        loadedRef.current = true;
      })().finally(() => {
        loadingRef.current = null;
      });
    }
    return loadingRef.current;
  }, [url, parse]);

  useEffect(() => {
    load().catch((e) => console.error(`Failed to load ${label}:`, e));
  }, [load, label]);

  const flush = useCallback(async () => {
    if (savingRef.current) return; // the running loop sends the change
    savingRef.current = true;
    try {
      while (dirtyRef.current) {
        dirtyRef.current = false;
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(serialize(ref.current)),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (e) {
          console.error(`Failed to save ${label}:`, e);
          // Snap back to disk truth: the change visibly reverts, which is
          // an honest signal without a toast surface. If the reload fails
          // too (server unreachable), the optimistic state stays and the
          // next change retries the save.
          try {
            await load();
            dirtyRef.current = false;
          } catch (e2) {
            console.error(`Failed to reload ${label} after save error:`, e2);
          }
          return;
        }
      }
    } finally {
      savingRef.current = false;
    }
  }, [url, label, serialize, load]);

  const apply = useCallback(
    (fn: (current: T) => T) => {
      const next = fn(ref.current);
      if (next === ref.current) return;
      ref.current = next;
      setValue(next);
      dirtyRef.current = true;
      void flush();
    },
    [flush],
  );

  const reportDropped = useCallback(
    (e: unknown) => console.error(`${label} not loaded; change not saved:`, e),
    [label],
  );

  const mutate = useCallback(
    (fn: (current: T) => T) => {
      if (loadedRef.current) {
        apply(fn);
        return;
      }
      load().then(() => apply(fn), reportDropped);
    },
    [load, apply, reportDropped],
  );

  const current = useCallback(() => ref.current, []);

  return { value, mutate, current };
}
