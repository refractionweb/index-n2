/* eslint-disable react-refresh/only-export-components */
import { useEffect, useRef, useState, type ComponentType, type ReactNode } from "react";
import {
  RiAddLine,
  RiArchiveLine,
  RiDeleteBinLine,
  RiFileCopyLine,
  RiFolderCloudLine,
  RiFolderLine,
  RiGalleryLine,
  RiHomeLine,
  RiImageDownloadLine,
  RiMore2Line,
  RiPencilLine,
  RiPuzzleLine,
  RiRefreshLine,
  RiRestartLine,
  RiSettings3Line,
  RiStopCircleLine,
} from "@remixicon/react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
} from "@/components/ui/sidebar";
import { AboutDialog } from "@/components/about-dialog";
import { CopyableCode } from "@/components/copyable-code";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAppInfo, type FtClientStatus } from "@/contexts/app-info-context";
import { useBookmarks } from "@/contexts/bookmarks-context";
import { useCollections } from "@/contexts/collections-context";
import { useFolders } from "@/contexts/folders-context";
import { useSettings } from "@/contexts/settings-context";
import { useTab } from "@/contexts/tab-context";
import { useSync } from "@/hooks/use-sync";
import { collectionTab, folderTab, type TabId } from "@/lib/tabs";
import { cn } from "@/lib/utils";

export type { TabId } from "@/lib/tabs";

type Tab = {
  id: TabId;
  label: string;
  Icon: ComponentType<{ className?: string }>;
};

export const NAV_TABS: readonly Tab[] = [
  { id: "home", label: "Home", Icon: RiHomeLine },
  { id: "gallery", label: "Gallery", Icon: RiGalleryLine },
  { id: "archive", label: "Archive", Icon: RiArchiveLine },
  { id: "duplicates", label: "Duplicates", Icon: RiFileCopyLine },
  // Settings lives in SidebarHeader as a gear button — it's app configuration,
  // not a data view, so it doesn't belong in this nav alongside Home/Gallery/etc.
];

export function AppSidebar() {
  const { activeTab, setTab } = useTab();
  const {
    running,
    step,
    unfetchedCount,
    canCancel,
    cancelling,
    resumePending,
    error: syncError,
    startSync,
    cancelSync,
  } = useSync();
  const { bookmarks, reload } = useBookmarks();
  const { settings, update: updateSettings } = useSettings();
  const { info, loaded: infoLoaded } = useAppInfo();

  // ft compatibility state. "missing" means ft isn't on PATH at all; the
  // remaining three are normalized from /api/info. `ftDisabled` is the
  // single gate for Sync / Fetch Media / Backfill Gaps / Rebuild controls
  // — both "missing" and "outdated" disable them (we know the subprocess
  // either can't run or will silently misbehave). "untested" stays enabled
  // because new ft probably works; if it doesn't, the user sees the result.
  //
  // While AppInfo is still loading we default to "compatible" so the UI
  // renders the optimistic enabled state (no banner flicker, no spurious
  // disabled buttons). FtGate currently prevents AppSidebar from mounting
  // during load, so this defensive default is theoretical today —
  // load-bearing if the provider tree ever shifts.
  const ftStatus: FtClientStatus = !infoLoaded
    ? "compatible"
    : info?.ft?.status ?? "missing";
  const ftDisabled = ftStatus === "outdated" || ftStatus === "missing";
  const ftDisabledTooltip = (action: string) =>
    ftStatus === "missing"
      ? `Install ft to enable ${action}.`
      : `Update ft to enable ${action}.`;
  const prevRunning = useRef(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [dontShowAgain, setDontShowAgain] = useState(false);
  const [rebuildOpen, setRebuildOpen] = useState(false);
  const {
    collections,
    remove: removeCollection,
    setHidden: setCollectionHidden,
    promptCreate,
    promptRename,
  } = useCollections();
  const { folders } = useFolders();
  // Collection pending delete confirmation (its id), or null.
  const [deleteCollectionId, setDeleteCollectionId] = useState<string | null>(null);
  const deleteTarget = collections.find((c) => c.id === deleteCollectionId) ?? null;
  // Pre-launch warning shown when a click is about to fire an unbounded media
  // run (Sync with skipMedia=off, or Fetch Media with mediaFetchLimit=0). Same
  // shared suppression as `noLimitWarningSuppressed`. `kind` decides which
  // command fires on Continue.
  const [noLimitOpen, setNoLimitOpen] = useState<"sync" | "media" | null>(null);
  const [dontShowNoLimitAgain, setDontShowNoLimitAgain] = useState(false);

  useEffect(() => {
    if (prevRunning.current && !running) reload();
    prevRunning.current = running;
  }, [running, reload]);

  const countMatch = step?.match(/(\d+)\/(\d+)/);
  const progressValue = running
    ? countMatch
      ? (parseInt(countMatch[1]) / parseInt(countMatch[2])) * 100
      : null
    : undefined;

  // Idle status lines, composed by state:
  //   - ft missing + has data: two-line banner — state + clickable install
  //     command (CopyableCode click-to-copy). Sync is disabled, so suppressing
  //     the unfetched-count is the right call — it'd point users at an action
  //     they can't take.
  //   - ft outdated: empty (Settings badge carries the news; sidebar stays
  //     clean per user-facing design).
  //   - ft compatible / untested: existing logic — count line plus optional
  //     reminders for non-default settings (skipMedia / mediaFetchLimit).
  // Each entry is a ReactNode so the install-command line can render the
  // CopyableCode component; plain string entries are rendered as text.
  const idleStatusLines: ReactNode[] = [];
  // Last run's failure leads, so it isn't lost under the routine lines.
  if (syncError) idleStatusLines.push(syncError);
  // ft saved a cursor from a sync that stopped early; Sync resumes it before
  // fetching anything newer (server.js, readSyncResumeCursor).
  if (resumePending && !ftDisabled) {
    idleStatusLines.push("Last sync stopped early. Sync resumes it.");
  }
  if (ftStatus === "missing") {
    idleStatusLines.push(
      "ft is not detected. Sync is disabled.",
      <CopyableCode key="install-cmd" value="npm install -g fieldtheory" />,
    );
  } else if (!ftDisabled && unfetchedCount > 0) {
    idleStatusLines.push(`${unfetchedCount.toLocaleString()} media files unfetched.`);
    if (settings.skipMedia) idleStatusLines.push("Skip media is enabled. Use Fetch Media.");
    if (settings.mediaFetchLimit > 0) idleStatusLines.push(`Fetch Media batch limit: ${settings.mediaFetchLimit}.`);
  }
  const showStatus = running || idleStatusLines.length > 0;
  // While running, the step text is a (possibly newline-joined) string from
  // STATUS.* — split into lines so it renders the same stacked-spans shape.
  const renderedStatusLines: ReactNode[] = running
    ? (step || "Syncing...").split("\n")
    : idleStatusLines;

  // Before ft 1.3.22 (and on Windows, where cancel is SIGTERM), cancelling
  // ft's media phase leaves orphaned files on disk: downloaded but not in
  // the manifest, because ft exits without writing it (fieldtheory-cli#142),
  // so they're fetched again next run. From 1.3.22 ft finishes the current
  // file and writes the manifest on SIGINT, and the warning would be wrong.
  // Detect the media phase via the `STATUS.mediaProgress` shape ("N
  // downloaded" / "K failed") and the brief `STATUS.fetchingMedia` transition.
  const isMediaPhase =
    !!step?.match(/\d+ (downloaded|failed)/) ||
    !!step?.startsWith("Fetching media");
  const cancelLosesMedia = !info?.ft?.cancelSavesProgress;

  // Render the actual command lines the buttons will spawn — useful for power
  // users debugging what the GUI is doing, and stays accurate when the user
  // changes mediaFetchLimit / skipProfileImages / skipMedia.
  const syncCmd = `${resumePending ? "ft sync --continue --no-media --max-minutes 10; " : ""}ft sync${
    settings.skipMedia ? " --no-media" : ""
  }${settings.skipProfileImages ? " --skip-profile-images" : ""}${settings.syncFolders ? " --folders" : ""}`;
  const gapsCmd = `ft sync --gaps${settings.skipMedia ? " --no-media" : ""}${
    settings.skipProfileImages ? " --skip-profile-images" : ""
  }`;
  const fetchMediaCmd = `ft fetch-media${
    settings.mediaFetchLimit > 0 ? ` --limit ${settings.mediaFetchLimit}` : ""
  }${settings.skipProfileImages ? " --skip-profile-images" : ""}`;

  // Fetch Media has nothing to operate on when bookmarks.jsonl is empty/missing.
  // Disabling is the right default for an action whose prerequisite isn't met —
  // ft fetch-media itself bails via requireData() (cli.js:374) in that case, but
  // the GUI shouldn't surface "click → fail" when "this action isn't available
  // yet" reads cleaner.
  const noBookmarks = !bookmarks || bookmarks.length === 0;

  const handleCancelClick = () => {
    if (isMediaPhase && cancelLosesMedia && !settings.cancelMediaWarningSuppressed) {
      setDontShowAgain(false);
      setConfirmOpen(true);
    } else {
      cancelSync();
    }
  };

  const handleConfirmCancel = () => {
    if (dontShowAgain) updateSettings({ cancelMediaWarningSuppressed: true });
    setConfirmOpen(false);
    cancelSync();
  };

  // Sync click. If Skip media is off AND no limit is configured AND the user
  // hasn't dismissed this warning before, show the no-limit dialog. Otherwise
  // launch immediately. (When skipMedia is on, no media is fetched, so the
  // "no limit" warning is irrelevant.)
  const handleSyncClick = () => {
    if (!settings.skipMedia && !settings.noLimitWarningSuppressed) {
      setDontShowNoLimitAgain(false);
      setNoLimitOpen("sync");
    } else {
      startSync();
    }
  };

  // Fetch Media click. Warn when no limit is configured.
  const handleFetchMediaClick = () => {
    if (settings.mediaFetchLimit === 0 && !settings.noLimitWarningSuppressed) {
      setDontShowNoLimitAgain(false);
      setNoLimitOpen("media");
    } else {
      startSync("media");
    }
  };

  const handleConfirmNoLimit = () => {
    if (dontShowNoLimitAgain) updateSettings({ noLimitWarningSuppressed: true });
    const kind = noLimitOpen;
    setNoLimitOpen(null);
    if (kind === "sync") startSync();
    else if (kind === "media") startSync("media");
  };

  const handleConfirmRebuild = () => {
    setRebuildOpen(false);
    startSync("bookmarks-rebuild");
  };

  return (
    <Sidebar collapsible="offcanvas">
      {/* Header zone matches TopBar's h-14 so the two header bands align
          when sidebar is open. Buttons right-aligned (justify-end); the
          floating SidebarTrigger (rendered in App.tsx) overlays this region's
          top-LEFT, so no left padding is needed — leftmost area is empty.
          Settings sits before About (more frequent action, leftward in
          reading order). */}
      <SidebarHeader className="h-14 flex-row items-center justify-end gap-2 px-3">
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setTab("settings")}
          aria-label="Settings"
          aria-pressed={activeTab === "settings"}
          className={cn(activeTab === "settings" && "bg-accent")}
        >
          <RiSettings3Line />
        </Button>
        <AboutDialog />
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup className="pt-0.5">
          <SidebarGroupContent>
            <SidebarMenu>
              {NAV_TABS.map(({ id, label, Icon }) => (
                <SidebarMenuItem key={id}>
                  <SidebarMenuButton
                    isActive={id === activeTab}
                    tooltip={label}
                    onClick={() => setTab(id)}
                  >
                    <Icon />
                    <span>{label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Collections</SidebarGroupLabel>
          {/* top-2.5: the preset trims SidebarGroup to py-1 but keeps the
              action's upstream top-3.5, which was centered on a py-2 group.
              Re-center on the h-8 label. */}
          <SidebarGroupAction
            className="top-2.5"
            aria-label="New collection"
            title="New collection"
            onClick={() => promptCreate()}
          >
            <RiAddLine />
          </SidebarGroupAction>
          <SidebarGroupContent>
            <SidebarMenu>
              {collections.map((c) => {
                const tab = collectionTab(c.id);
                return (
                  <SidebarMenuItem key={c.id}>
                    <SidebarMenuButton
                      isActive={tab === activeTab}
                      tooltip={c.name}
                      onClick={() => setTab(tab)}
                    >
                      <RiFolderLine />
                      <span>{c.name}</span>
                    </SidebarMenuButton>
                    {/* Count and the hover "⋮" share the right-1 slot. The
                        badge hides under exactly the conditions that show
                        the action (SidebarMenuAction showOnHover: hover,
                        focus-within, menu open, and always below md). */}
                    <SidebarMenuBadge className="max-md:hidden group-hover/menu-item:hidden group-focus-within/menu-item:hidden group-has-data-[state=open]/menu-item:hidden">
                      {c.ids.size}
                    </SidebarMenuBadge>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuAction showOnHover aria-label={`Actions for ${c.name}`}>
                          <RiMore2Line />
                        </SidebarMenuAction>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="right" align="start" className="min-w-[160px]">
                        <DropdownMenuCheckboxItem
                          checked={c.hidden}
                          onCheckedChange={(v) => setCollectionHidden(c.id, v === true)}
                        >
                          Hide from Home
                        </DropdownMenuCheckboxItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => promptRename(c.id)}>
                          <RiPencilLine />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onSelect={() => setDeleteCollectionId(c.id)}
                        >
                          <RiDeleteBinLine />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        {/* X bookmark folders, mirrored by `ft sync --folders`. Read-only
            (ft can't write folders back to X), so no actions: rename,
            delete and membership happen on X and arrive with the next
            Sync. Hidden until a sync has tagged at least one folder. */}
        {folders.length > 0 && (
          <SidebarGroup>
            <SidebarGroupLabel>X folders</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {folders.map((f) => {
                  const tab = folderTab(f.id);
                  return (
                    <SidebarMenuItem key={f.id}>
                      <SidebarMenuButton
                        isActive={tab === activeTab}
                        tooltip={f.name}
                        onClick={() => setTab(tab)}
                      >
                        <RiFolderCloudLine />
                        <span>{f.name}</span>
                      </SidebarMenuButton>
                      <SidebarMenuBadge className="max-md:hidden">{f.ids.size}</SidebarMenuBadge>
                    </SidebarMenuItem>
                  );
                })}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>
      <SidebarFooter>
        {showStatus && (
          <div className="flex flex-col gap-1.5 px-0.5">
            {/*
              Multi-line status support: `ft sync --gaps` emits a breakdown
              of recovered/expanded/fetched/unavailable counts that would
              clip in a single line at sidebar width. STATUS.gapsFilled joins
              lines with \n; we split (during running) into one span per line
              in the same style. The idle path uses a ReactNode[] directly so
              the ft-missing state can render a CopyableCode element alongside
              plain text — same span shell, different inner content.
            */}
            {renderedStatusLines.map((line, i) => (
              <span
                key={i}
                className="text-muted-foreground text-xs"
              >
                {line}
              </span>
            ))}
            {running && <Progress value={progressValue ?? null} />}
          </div>
        )}
        {/*
          Three states:
          - idle → Sync + mode dropdown
          - running + ft alive → Cancel (dropdown hidden; starting a different
            mode while one is running is never right — user cancels first)
          - running + rebuild phase → disabled "Syncing…" (no ft proc to kill;
            rebuild is fast and cooperative-cancel isn't worth the complexity)
        */}
        {!running ? (
          <ButtonGroup className="w-full">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  // aria-disabled (not the native `disabled` attribute) so the
                  // tooltip-on-hover still works. Browsers block pointer events
                  // on disabled buttons, which means Radix's TooltipTrigger
                  // never sees the hover and the tooltip never appears — the
                  // exact case where "why is this disabled?" is most needed.
                  // Wrapping in a span would fix it too but breaks ButtonGroup's
                  // first/last-child border-radius selectors.
                  className={cn("flex-1", ftDisabled && "opacity-50 cursor-not-allowed")}
                  onClick={ftDisabled ? undefined : handleSyncClick}
                  aria-disabled={ftDisabled || undefined}
                >
                  <RiRefreshLine />
                  <span className="truncate">Sync</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent className={cn(!ftDisabled && "font-mono text-[0.625rem]")}>
                {ftDisabled ? ftDisabledTooltip("Sync") : syncCmd}
              </TooltipContent>
            </Tooltip>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon-sm" disabled={ftDisabled}>
                  <RiMore2Line />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" className="w-auto">
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuItem
                      onSelect={handleFetchMediaClick}
                      disabled={ftDisabled || noBookmarks}
                    >
                      <RiImageDownloadLine />
                      Fetch Media
                    </DropdownMenuItem>
                  </TooltipTrigger>
                  <TooltipContent side="right" className={cn(!ftDisabled && "font-mono text-[0.625rem]")}>
                    {ftDisabled
                      ? ftDisabledTooltip("Fetch Media")
                      : noBookmarks
                        ? "No bookmarks. Sync first."
                        : fetchMediaCmd}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuItem
                      onSelect={() => startSync("gaps")}
                      disabled={ftDisabled || noBookmarks}
                    >
                      <RiPuzzleLine />
                      Backfill Gaps
                    </DropdownMenuItem>
                  </TooltipTrigger>
                  <TooltipContent side="right" className={cn(!ftDisabled && "font-mono text-[0.625rem]")}>
                    {ftDisabled
                      ? ftDisabledTooltip("Backfill Gaps")
                      : noBookmarks
                        ? "No bookmarks. Sync first."
                        : gapsCmd}
                  </TooltipContent>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <DropdownMenuItem
                      onSelect={() => setRebuildOpen(true)}
                      disabled={ftDisabled || noBookmarks}
                    >
                      <RiRestartLine />
                      Rebuild Bookmarks
                    </DropdownMenuItem>
                  </TooltipTrigger>
                  <TooltipContent side="right" className={cn(!ftDisabled && "font-mono text-[0.625rem]")}>
                    {ftDisabled
                      ? ftDisabledTooltip("Rebuild")
                      : noBookmarks
                        ? "No bookmarks. Sync first."
                        : "ft sync --rebuild --yes"}
                  </TooltipContent>
                </Tooltip>
              </DropdownMenuContent>
            </DropdownMenu>
          </ButtonGroup>
        ) : cancelling ? (
          // One cancel per run: ft is saving its progress, and a second
          // SIGINT would kill it mid-save.
          <Button variant="outline" size="sm" className="w-full" disabled>
            <Spinner data-icon="inline-start" />
            <span className="truncate">Cancelling...</span>
          </Button>
        ) : canCancel ? (
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={handleCancelClick}
          >
            <RiStopCircleLine />
            <span className="truncate">Cancel</span>
          </Button>
        ) : (
          <Button variant="outline" size="sm" className="w-full" disabled>
            <Spinner data-icon="inline-start" />
            <span className="truncate">Syncing...</span>
          </Button>
        )}
      </SidebarFooter>
      <SidebarRail />

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Cancel media fetch?</AlertDialogTitle>
            <AlertDialogDescription>
              Files already downloaded this run won't be recorded in ft's
              manifest, so they'll be re-downloaded on the next sync. Bandwidth
              waste, no data corruption.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={dontShowAgain}
              onCheckedChange={(v) => setDontShowAgain(v === true)}
            />
            <span>Don't show this again</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep syncing</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleConfirmCancel}>
              Cancel anyway
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteCollectionId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete collection?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes “{deleteTarget?.name}” ({deleteTarget?.ids.size ?? 0}{" "}
              {deleteTarget?.ids.size === 1 ? "bookmark" : "bookmarks"}). The
              bookmarks themselves are not affected.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (deleteCollectionId) removeCollection(deleteCollectionId);
                setDeleteCollectionId(null);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={rebuildOpen} onOpenChange={setRebuildOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild bookmarks?</AlertDialogTitle>
            <AlertDialogDescription>
              Re-crawls every bookmark from X. Existing data is merged, not
              deleted.
              {!settings.skipMedia && (
                <>
                  {" "}ft sync fetches media without a per-run limit. Skip
                  media in Settings omits media from Sync.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmRebuild}>
              Rebuild
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={noLimitOpen !== null} onOpenChange={(o) => !o && setNoLimitOpen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>No batch limit</AlertDialogTitle>
            <AlertDialogDescription>
              {noLimitOpen === "sync"
                ? "ft sync fetches media without a per-run limit. Skip media in Settings omits media from Sync."
                : `ft fetch-media will attempt all ${unfetchedCount.toLocaleString()} unfetched media files. Fetch Media batch limit in Settings caps subsequent runs.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-xs">
            <Checkbox
              checked={dontShowNoLimitAgain}
              onCheckedChange={(v) => setDontShowNoLimitAgain(v === true)}
            />
            <span>Don't show this again</span>
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleConfirmNoLimit}>
              Continue
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

    </Sidebar>
  );
}
