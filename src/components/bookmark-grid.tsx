import { BookmarkList } from "@/components/bookmark-list";
import { CopyableCode } from "@/components/copyable-code";
import { StatusMessage } from "@/components/status-message";
import { useBookmarks } from "@/contexts/bookmarks-context";
import {
  useActiveCollection,
  useHiddenByCollections,
} from "@/contexts/collections-context";
import { useFilter } from "@/contexts/filter-context";
import { useActiveFolder } from "@/contexts/folders-context";
import { useHidden } from "@/contexts/hidden-context";
import { useSettings } from "@/contexts/settings-context";
import { useTab } from "@/contexts/tab-context";
import { useFilteredBookmarks } from "@/hooks/use-filtered-bookmarks";
import { filterBookmarks } from "@/lib/filter";
import { getScopedBookmarks } from "@/lib/scope";

export function BookmarkGrid() {
  const { bookmarks, error, loading } = useBookmarks();
  const { state: filterState } = useFilter();
  const { hiddenIds } = useHidden();
  const { settings } = useSettings();
  const { activeTab, setTab } = useTab();
  const filtered = useFilteredBookmarks();
  const activeCollection = useActiveCollection();
  const activeFolder = useActiveFolder();
  const hiddenByCollections = useHiddenByCollections();

  if (loading) {
    return (
      <StatusMessage>Loading bookmarks…</StatusMessage>
    );
  }
  if (error) {
    return (
      <StatusMessage variant="destructive">{error.message}</StatusMessage>
    );
  }
  // States 1+2 combined: file missing OR file exists with 0 records. Splitting
  // these requires a `firstRun` signal that /api/info doesn't expose.
  if (!bookmarks || bookmarks.length === 0) {
    return (
      <StatusMessage>
        <p className="text-foreground">No local data.</p>
        <p className="mt-1">
          Click Sync in the sidebar to fetch bookmarks (and media unless
          Skip media is on in Settings).
        </p>
        <p className="mt-1">
          Or run <CopyableCode value="ft sync" /> in your terminal.
        </p>
      </StatusMessage>
    );
  }
  if (filtered.length === 0) {
    const hasFilters =
      filterState.accounts.size > 0 ||
      filterState.types.size > 0 ||
      filterState.categories.size > 0 ||
      filterState.languages.size > 0 ||
      filterState.color !== null ||
      filterState.search !== "";

    if (hasFilters) {
      // Collections and X folders have no "opposite scope" to point at.
      if (activeCollection || activeFolder) {
        return (
          <StatusMessage>
            <p>No bookmarks match the current filters.</p>
          </StatusMessage>
        );
      }
      // Same filters applied against the opposite scope. Filter state is
      // shared across tabs (one FilterContext), so clicking the link only
      // needs to switch tab — the filters travel for free.
      const otherIsArchive = activeTab !== "archive";
      const otherScope = getScopedBookmarks(
        bookmarks,
        hiddenIds,
        otherIsArchive,
        settings.hideUnfetched,
        null,
        hiddenByCollections,
      );
      const otherCount = filterBookmarks(otherScope, filterState).length;
      const otherLabel = otherIsArchive ? "Archive" : "Home";
      const otherTab = otherIsArchive ? "archive" : "home";

      return (
        <StatusMessage>
          <p>No bookmarks match the current filters.</p>
          {otherCount > 0 && (
            <p className="mt-1">
              <button
                type="button"
                onClick={() => setTab(otherTab)}
                className="text-foreground underline hover:no-underline"
              >
                {otherLabel} contains {otherCount}{" "}
                {otherCount === 1 ? "match" : "matches"}
              </button>
            </p>
          )}
        </StatusMessage>
      );
    }
    if (activeCollection) {
      return (
        <StatusMessage>
          <p className="text-foreground">Collection is empty.</p>
          <p className="mt-1">
            Select bookmarks, then click Collection in the selection bar.
          </p>
        </StatusMessage>
      );
    }
    if (activeTab === "archive") {
      return (
        <StatusMessage>
          <p className="text-foreground">Nothing archived.</p>
          <p className="mt-1">Click ⋯ on a bookmark to archive it.</p>
        </StatusMessage>
      );
    }
    // hideUnfetched can drop everything when the user just synced and
    // hasn't run fetch-media yet — the result looks identical to "all
    // archived" otherwise. Distinguish so the message points at the
    // actual cause rather than misattributing it.
    if (settings.hideUnfetched) {
      return (
        <StatusMessage>
          <p className="text-foreground">No fetched bookmarks.</p>
          <p className="mt-1">
            Disable <em>Hide unfetched media</em> in Settings, or run{" "}
            <CopyableCode value="ft fetch-media" />.
          </p>
        </StatusMessage>
      );
    }
    // Home tab, no filters set, but everything filtered out → all archived.
    return (
      <StatusMessage>
        <p className="text-foreground">
          All bookmarks archived ({bookmarks.length.toLocaleString()}).
        </p>
        <p className="mt-1">Open Archive to view them.</p>
      </StatusMessage>
    );
  }

  return <BookmarkList items={filtered} columnWidth={300} />;
}
