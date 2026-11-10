import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

// The one place the app touches the clipboard; eslint's no-restricted-syntax
// rule keeps it that way. A write can reject (document not focused,
// permission denied) and `navigator.clipboard` is absent outside secure
// contexts, so callers get the actual outcome instead of assuming success.

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export type CopyState = "idle" | "copied" | "failed";

function clearTimer(timer: RefObject<number | null>) {
  if (timer.current !== null) {
    window.clearTimeout(timer.current);
    timer.current = null;
  }
}

// Copy with transient feedback: `state` is "copied" or "failed" for `ms`,
// then "idle". A new copy restarts the timer, so an earlier click's timeout
// can't cut the latest feedback short. `reset` returns to idle at once, for
// when the value being copied changes under the control.
export function useCopyFeedback(ms = 1500) {
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    // Set in setup, not only at init: StrictMode runs cleanup then setup
    // again, and the cleanup below would otherwise leave it false.
    alive.current = true;
    return () => {
      alive.current = false;
      clearTimer(timer);
    };
  }, []);

  const reset = useCallback(() => {
    clearTimer(timer);
    setState("idle");
  }, []);

  const copy = useCallback(
    async (text: string) => {
      const ok = await copyText(text);
      if (!alive.current) return ok;
      clearTimer(timer);
      setState(ok ? "copied" : "failed");
      timer.current = window.setTimeout(() => {
        timer.current = null;
        setState("idle");
      }, ms);
      return ok;
    },
    [ms],
  );

  return { state, copy, reset };
}
