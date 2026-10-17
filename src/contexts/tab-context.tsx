/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import type { TabId } from "@/lib/tabs";

type TabValue = {
  activeTab: TabId;
  setTab: (tab: TabId) => void;
};

const TabContext = createContext<TabValue | null>(null);

export function TabProvider({ children }: { children: ReactNode }) {
  const [activeTab, setActiveTab] = useState<TabId>("home");
  const setTab = useCallback((tab: TabId) => setActiveTab(tab), []);
  const value = useMemo<TabValue>(
    () => ({ activeTab, setTab }),
    [activeTab, setTab],
  );
  return <TabContext.Provider value={value}>{children}</TabContext.Provider>;
}

export function useTab(): TabValue {
  const ctx = useContext(TabContext);
  if (!ctx) throw new Error("useTab requires <TabProvider>");
  return ctx;
}
