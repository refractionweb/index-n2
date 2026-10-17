import { useEffect, useRef, type ReactNode } from "react";
import { RiLayoutLeft2Line, RiSideBarLine } from "@remixicon/react";
import { AppSidebar } from "@/components/app-sidebar";
import { BookmarkGrid } from "@/components/bookmark-grid";
import { DuplicatesView } from "@/components/duplicates-view";
import { FtNotInstalled } from "@/components/ft-not-installed";
import { GalleryGrid } from "@/components/gallery-grid";
import { Lightbox } from "@/components/lightbox";
import { ProgressiveBlur } from "@/components/progressive-blur";
import { SelectionBar } from "@/components/selection-bar";
import { SettingsView } from "@/components/settings-view";
import { ThemeApplier } from "@/components/theme-provider";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { SidebarInset, SidebarProvider, useSidebar } from "@/components/ui/sidebar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { AppInfoProvider, useAppInfo } from "@/contexts/app-info-context";
import { BookmarksProvider } from "@/contexts/bookmarks-context";
import { CollectionsProvider } from "@/contexts/collections-context";
import { FilterProvider, useFilter } from "@/contexts/filter-context";
import { GalleryZoomProvider } from "@/contexts/gallery-zoom-context";
import { HiddenProvider } from "@/contexts/hidden-context";
import { LightboxProvider, useLightbox } from "@/contexts/lightbox-context";
import { SelectionProvider, useSelection } from "@/contexts/selection-context";
import { SettingsProvider } from "@/contexts/settings-context";
import { TabProvider, useTab } from "@/contexts/tab-context";
import { useFilteredBookmarks } from "@/hooks/use-filtered-bookmarks";
import { isGridTab } from "@/lib/tabs";

// Provider stack split into core vs app:
// - CoreProviders are infrastructure that works regardless of ft (theme,
//   settings, tooltips). They wrap FtGate so the not-installed screen still
//   gets the user's theme.
// - AppProviders are bookmark-data-bound (Bookmarks, Hidden, Filter, Tab,
//   GalleryZoom, Selection, Lightbox) and only mount once ft is detected,
//   so we don't fire /api/bookmarks fetches that would 500 when ft is
//   missing.
function CoreProviders({ children }: { children: ReactNode }) {
  return (
    <TooltipProvider>
      <AppInfoProvider>
        <SettingsProvider>
          <ThemeApplier>{children}</ThemeApplier>
        </SettingsProvider>
      </AppInfoProvider>
    </TooltipProvider>
  );
}

function AppProviders({ children }: { children: ReactNode }) {
  return (
    <BookmarksProvider>
      <HiddenProvider>
        <FilterProvider>
          <TabProvider>
            <CollectionsProvider>
              <GalleryZoomProvider>
                <SelectionProvider>
                  <LightboxProvider>{children}</LightboxProvider>
                </SelectionProvider>
              </GalleryZoomProvider>
            </CollectionsProvider>
          </TabProvider>
        </FilterProvider>
      </HiddenProvider>
    </BookmarksProvider>
  );
}

// Boot-gate. Hard-blocks with FtNotInstalled only when BOTH ft is missing
// AND there's no existing data — i.e. a first-time user with nothing to
// browse. If the user has data but no ft (uninstalled, broken install,
// etc.), we fall through into the app shell. Browsing existing bookmarks
// doesn't need ft; AppSidebar handles disabling sync controls in that case.
// Renders nothing while /api/info is pending (sub-100ms on localhost).
function FtGate({ children }: { children: ReactNode }) {
  const { info, loaded } = useAppInfo();
  if (!loaded) return null;
  if (!info?.ft && !info?.hasData) return <FtNotInstalled />;
  return <>{children}</>;
}

// Floating sidebar toggle. Sits outside both AppSidebar and SidebarInset so it
// never moves with sidebar/topbar layout state — fixed at viewport top-left
// across all sidebar states. Avoids the mount/unmount + animation-sync issues
// of putting the trigger inside the sliding sidebar OR conditionally inside
// the topbar.
//
// Icon swaps with state: `RiSideBarLine` when the sidebar is expanded (the
// shadcn-default trigger glyph), `RiLayoutLeft2Line` when collapsed (hints
// "click to reveal the panel" rather than just toggling).
//
// Position math (eye-balled because fixed positioning and the sidebar's
// flow-layout padding chain don't share dimensions):
//
// - `top-3.5` (14px) vertically centers the 28px-tall trigger (`size="icon"`
//   → `size-7`, see button.tsx:30) inside the 56px-tall header band (h-14):
//   (56-28)/2 = 14.
//
// - `left-2.5` (10px) aligns the trigger's icon CENTER with the sidebar nav
//   icons. Trigger icon (14px svg in 28px button) center = left + button_size/2
//   = 10 + 14 = 24. Sidebar nav icon (16px svg) center = SidebarGroup px-2 +
//   SidebarMenuButton p-2 + icon_size/2 = 8 + 8 + 8 = 24. Match.
//
// If shadcn bumps any of those values in a future version (trigger size,
// SidebarGroup/SidebarMenuButton padding, sidebar nav icon size, TopBar
// height), redo the arithmetic.
function FloatingSidebarToggle() {
  const { state, toggleSidebar } = useSidebar();
  const Icon = state === "collapsed" ? RiLayoutLeft2Line : RiSideBarLine;
  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={toggleSidebar}
      aria-label="Toggle Sidebar"
      className="fixed top-3.5 left-2.5 z-50"
    >
      <Icon />
    </Button>
  );
}

export function App() {
  return (
    <CoreProviders>
      <FtGate>
        <AppProviders>
          <SidebarProvider className="h-svh">
            <AppSidebar />
            <SidebarInset className="min-h-0 overflow-hidden">
              <TopBar />
              <ScrollContent />
            </SidebarInset>
            <FloatingSidebarToggle />
          </SidebarProvider>
          <Lightbox />
        </AppProviders>
      </FtGate>
    </CoreProviders>
  );
}

function ScrollContent() {
  const { selectedIds, selectAll, clear } = useSelection();
  const { activeTab } = useTab();
  const { target: lightboxTarget } = useLightbox();
  const { state: filterState } = useFilter();
  const filtered = useFilteredBookmarks();
  const isGrid = isGridTab(activeTab);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !lightboxTarget && selectedIds.size > 0) {
        clear();
        return;
      }

      if (
        (e.metaKey || e.ctrlKey) &&
        e.key === "a" &&
        !lightboxTarget &&
        activeTab !== "gallery" &&
        isGridTab(activeTab)
      ) {
        const t = e.target as HTMLElement;
        if (t?.tagName === "INPUT" || t?.tagName === "TEXTAREA" || t?.isContentEditable) return;
        e.preventDefault();
        selectAll(filtered.map((b) => b.id));
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [lightboxTarget, selectedIds, clear, selectAll, activeTab, filtered]);

  // Scroll to top whenever filter state changes. Watches the FilterContext
  // reducer state directly, not items-array reference — so archiving an item
  // (which mutates hidden state, not filter state) and bookmark sync (which
  // mutates the underlying corpus, not filter state) both leave scroll alone.
  // Skips the initial mount and skips when already at top to avoid an empty
  // scrollTo that would still fire a synthetic scroll event.
  const isFirstFilterRender = useRef(true);
  useEffect(() => {
    if (isFirstFilterRender.current) {
      isFirstFilterRender.current = false;
      return;
    }
    const el = scrollRef.current;
    if (el && el.scrollTop > 0) {
      el.scrollTo({ top: 0 });
    }
  }, [filterState]);

  return (
    <div ref={scrollRef} className={`min-h-0 flex-1 overflow-auto px-3 pb-3 ${isGrid ? "pt-0.5" : "pt-14"}`}>
      {isGrid && (
        <>
          {activeTab === "gallery" ? (
            <GalleryGrid />
          ) : (
            <BookmarkGrid />
          )}
          <div className="h-4" />
          <ProgressiveBlur
            visible={selectedIds.size > 0}
            // Negate the scroll container's `p-3` on the sides AND bottom so the
            // blur spans all the way to the inset's edges (horizontal) and the
            // viewport's bottom (via `-bottom-3` on the sticky anchor), not just
            // the padded content rectangle.
            className="-mx-3 -bottom-3"
          />
          <SelectionBar />
        </>
      )}
      {activeTab === "duplicates" && <DuplicatesView />}
      {activeTab === "settings" && <SettingsView />}
    </div>
  );
}

export default App;
