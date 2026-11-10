/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

// 7 column widths in px.
export const ZOOM_LEVELS: readonly number[] = [
  180, 240, 320, 400, 500, 700, 1000,
];
const STORAGE_KEY = "gallery-zoom";
const DEFAULT_INDEX = 2; // 320px

function readStored(): number {
  // Reading localStorage throws when the browser blocks site data; this
  // runs in useState's initializer, so a throw would take the app down.
  let raw: string | null;
  try {
    raw = localStorage.getItem(STORAGE_KEY);
  } catch {
    return DEFAULT_INDEX;
  }
  if (raw === null) return DEFAULT_INDEX;
  const n = Number.parseInt(raw, 10);
  return Number.isInteger(n) && n >= 0 && n < ZOOM_LEVELS.length
    ? n
    : DEFAULT_INDEX;
}

function writeStored(n: number) {
  try {
    localStorage.setItem(STORAGE_KEY, String(n));
  } catch {
    // localStorage may be disabled (private mode, quota exceeded). Zoom is a
    // preference, not data — silently fall back to in-memory only.
  }
}

type GalleryZoomValue = {
  zoomIndex: number;
  zoomWidth: number;
  setZoomIndex: (i: number) => void;
  step: (delta: number) => void;
};

const GalleryZoomContext = createContext<GalleryZoomValue | null>(null);

export function GalleryZoomProvider({ children }: { children: ReactNode }) {
  const [zoomIndex, setZoomIndexState] = useState(readStored);

  const setZoomIndex = useCallback((i: number) => {
    setZoomIndexState((prev) => {
      const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, i));
      if (next === prev) return prev;
      writeStored(next);
      return next;
    });
  }, []);

  const step = useCallback((delta: number) => {
    setZoomIndexState((prev) => {
      const next = Math.max(0, Math.min(ZOOM_LEVELS.length - 1, prev + delta));
      if (next === prev) return prev;
      writeStored(next);
      return next;
    });
  }, []);

  const value = useMemo<GalleryZoomValue>(
    () => ({
      zoomIndex,
      zoomWidth: ZOOM_LEVELS[zoomIndex],
      setZoomIndex,
      step,
    }),
    [zoomIndex, setZoomIndex, step]
  );

  return (
    <GalleryZoomContext.Provider value={value}>
      {children}
    </GalleryZoomContext.Provider>
  );
}

export function useGalleryZoom(): GalleryZoomValue {
  const ctx = useContext(GalleryZoomContext);
  if (!ctx) throw new Error("useGalleryZoom requires <GalleryZoomProvider>");
  return ctx;
}
