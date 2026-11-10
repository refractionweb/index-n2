import { useEffect, useMemo, useState } from "react";
import {
  RiAddLine,
  RiCloseLine,
  RiDownloadLine,
  RiFileCopyLine,
  RiFolderAddLine,
  RiHashtag,
  RiInboxArchiveLine,
  RiInboxUnarchiveLine,
  RiLinkM,
  RiMarkdownLine,
} from "@remixicon/react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SelectionStack } from "@/components/selection-stack";
import { useAppInfo } from "@/contexts/app-info-context";
import { useBookmarks } from "@/contexts/bookmarks-context";
import { useActiveCollection, useCollections } from "@/contexts/collections-context";
import { useHidden } from "@/contexts/hidden-context";
import { useSelection } from "@/contexts/selection-context";
import { useTab } from "@/contexts/tab-context";
import { useFilteredBookmarks } from "@/hooks/use-filtered-bookmarks";
import { copyText } from "@/lib/clipboard";
import {
  downloadText,
  exportIds,
  exportLinks,
  exportMarkdown,
  slugify,
} from "@/lib/export";
import type { Bookmark } from "@/types/bookmark";

export function SelectionBar() {
  const { selectedIds, clear } = useSelection();
  const { byId } = useBookmarks();
  const { archive, restore } = useHidden();
  const { activeTab } = useTab();
  const { collections, add, removeFrom, promptCreate } = useCollections();
  const activeCollection = useActiveCollection();
  const { info } = useAppInfo();
  const filtered = useFilteredBookmarks();
  const restoring = activeTab === "archive";
  // Transient status shown in place of the count after a copy. No toast
  // surface exists; the bar's own label is the status line.
  const [status, setStatus] = useState<string | null>(null);
  useEffect(() => {
    if (!status) return;
    const t = setTimeout(() => setStatus(null), 1500);
    return () => clearTimeout(t);
  }, [status]);

  // Selection (click) order. `selectedIds` is a Set that preserves insertion
  // order, so the most-recently-selected id is always last — which is what
  // SelectionStack requires: a new card must append to the tail to slide in
  // from the right. Walking byId instead re-sorts by load order, which makes
  // the stack reshuffle ("flip back") or skip animating when you select out of
  // list order. Filter to ids with a loaded bookmark so the rendered stack
  // width matches what can actually draw.
  const orderedIds = useMemo(
    () => [...selectedIds].filter((id) => byId.has(id)),
    [selectedIds, byId]
  );

  // Export order follows the view (sort + filters), so a file reads the way
  // the grid does. Selected items no longer in view (filters changed after
  // selecting) are appended in selection order.
  const exportList = useMemo((): Bookmark[] => {
    const inView = filtered.filter((b) => selectedIds.has(b.id));
    const seen = new Set(inView.map((b) => b.id));
    const rest = orderedIds
      .filter((id) => !seen.has(id))
      .map((id) => byId.get(id))
      .filter((b): b is Bookmark => b !== undefined);
    return [...inView, ...rest];
  }, [filtered, selectedIds, orderedIds, byId]);

  if (selectedIds.size === 0) return null;

  // Membership of the selection in a collection: all / none / some. Mirrors
  // the per-card menu's checkbox, extended to a set. Clicking a fully
  // checked item removes the whole selection; anything else adds it.
  const membership = (ids: ReadonlySet<string>): boolean | "indeterminate" => {
    let inside = 0;
    for (const id of selectedIds) if (ids.has(id)) inside++;
    if (inside === 0) return false;
    if (inside === selectedIds.size) return true;
    return "indeterminate";
  };

  const title = activeCollection?.name ?? "Selection";
  const n = exportList.length;
  // Not useCopyFeedback: the status line carries the count, and it shares
  // the bar's own status timer above.
  const copy = async (text: string, what: string) => {
    setStatus((await copyText(text)) ? `Copied ${n} ${what}` : "Copy failed");
  };
  const markdown = () =>
    exportMarkdown(exportList, { title, mediaDir: info?.mediaDir ?? null });

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-50 mx-auto flex w-full max-w-[680px] px-3">
      <div className="bg-card text-card-foreground pointer-events-auto flex h-[52px] w-full items-center gap-3.5 rounded-lg border py-3 pr-3 pl-3.5 shadow-lg">
        <SelectionStack ids={orderedIds} byId={byId} />
        <span className="flex-1 text-sm tabular-nums whitespace-nowrap">
          {status ?? `${selectedIds.size} selected`}
        </span>
        <div className="flex gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <RiFolderAddLine />
                <span>Collection</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              {collections.map((c) => {
                const state = membership(c.ids);
                return (
                  <DropdownMenuCheckboxItem
                    key={c.id}
                    checked={state}
                    // Keep the menu open so several collections can be
                    // toggled in one pass; the selection stays as well.
                    onSelect={(e) => e.preventDefault()}
                    onCheckedChange={() =>
                      state === true
                        ? removeFrom(c.id, [...selectedIds])
                        : add(c.id, [...selectedIds])
                    }
                  >
                    {c.name}
                  </DropdownMenuCheckboxItem>
                );
              })}
              {collections.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem
                onSelect={() => {
                  const ids = [...selectedIds];
                  promptCreate((c) => add(c.id, ids));
                }}
              >
                <RiAddLine />
                New collection…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                <RiFileCopyLine />
                <span>Copy</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-[180px]">
              <DropdownMenuItem onSelect={() => void copy(exportIds(exportList), "IDs")}>
                <RiHashtag />
                IDs
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copy(exportLinks(exportList), "links")}>
                <RiLinkM />
                Links
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void copy(markdown(), "as Markdown")}>
                <RiMarkdownLine />
                Markdown
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                onSelect={() => downloadText(`${slugify(title)}.md`, markdown())}
              >
                <RiDownloadLine />
                Save Markdown
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const ids = [...selectedIds];
              if (restoring) restore(ids);
              else archive(ids);
              clear();
            }}
          >
            {restoring ? <RiInboxUnarchiveLine /> : <RiInboxArchiveLine />}
            <span>{restoring ? "Restore" : "Archive"}</span>
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={clear}
            aria-label="Clear selection"
          >
            <RiCloseLine />
          </Button>
        </div>
      </div>
    </div>
  );
}
