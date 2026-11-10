/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";

// Mirror of server.js ftStatus() return shape. "outdated" disables sync
// (ft predates flags we depend on); "untested" warns but stays enabled
// (newer than verified, behaviour unknown); "compatible" is in-range.
export type FtStatus = "compatible" | "untested" | "outdated";

// Client-derived state used by UI consumers: server-side `FtStatus` plus
// "missing" to represent `ft: null` from the API. Keeps the UI normalized
// on a single string union so badges / disabled gates / tooltip selectors
// can switch over one type rather than nullable-chains.
export type FtClientStatus = FtStatus | "missing";

export type FtInfo = {
  version: string;
  status: FtStatus;
  testedMin: string;
  testedMax: string;
};

export type AppInfo = {
  name: string;
  version: string;
  description?: string;
  license?: string;
  author?: string | { name?: string; email?: string; url?: string };
  ft: FtInfo | null;
  hasData: boolean;
  // ft's media directory, home-relative ("~/.ft-bookmarks/media"); used by
  // Markdown export to emit local file paths. Absent on older servers.
  mediaDir?: string;
};

type AppInfoState = {
  info: AppInfo | null;
  loaded: boolean;
};

const AppInfoContext = createContext<AppInfoState | null>(null);

export function AppInfoProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AppInfoState>({ info: null, loaded: false });

  useEffect(() => {
    fetch("/api/info")
      .then((r) => r.json())
      .then((data: AppInfo) => setState({ info: data, loaded: true }))
      .catch(() => setState({ info: null, loaded: true }));
  }, []);

  return (
    <AppInfoContext.Provider value={state}>
      {children}
    </AppInfoContext.Provider>
  );
}

export function useAppInfo(): AppInfoState {
  const ctx = useContext(AppInfoContext);
  if (!ctx) throw new Error("useAppInfo requires <AppInfoProvider>");
  return ctx;
}
