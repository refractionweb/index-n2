import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import {
  RiAddLine,
  RiArrowDownSLine,
  RiBookmarkLine,
  RiCalendarLine,
  RiCheckLine,
  RiCloseLine,
  RiHeart3Line,
  RiHistoryLine,
  RiPaletteLine,
  RiPriceTag3Line,
  RiQuestionLine,
  RiRepeatLine,
  RiSearchLine,
  RiShapesLine,
  RiGroupLine,
  RiSortAsc,
  RiSortDesc,
  RiSubtractLine,
  RiTranslate2,
  RiUserLine,
} from "@remixicon/react";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Popover,
  PopoverAnchor,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useSidebar } from "@/components/ui/sidebar";
import { Slider } from "@/components/ui/slider";
import { ColorPicker } from "@/components/color-picker";
import { DiceCube } from "@/components/dice-cube";
import { useBookmarks } from "@/contexts/bookmarks-context";
import {
  useFilter,
  type SortKey,
  type SortOrder,
  type TypeFilter,
} from "@/contexts/filter-context";
import { useFilterCountSource } from "@/hooks/use-filter-count-source";
import { isGridTab } from "@/lib/tabs";
import { useFilteredBookmarks } from "@/hooks/use-filtered-bookmarks";
import { useFilteredGallery } from "@/hooks/use-filtered-gallery";
import { useSearchHistory } from "@/hooks/use-search-history";
import { matchesType } from "@/lib/filter";
import { UNCLASSIFIED_CATEGORY } from "@/lib/categories";
import { displayHex } from "@/lib/color-space";
import { formatLanguageName, isDisplayableLanguage } from "@/lib/language";
import {
  ZOOM_LEVELS,
  useGalleryZoom,
} from "@/contexts/gallery-zoom-context";
import { useTab } from "@/contexts/tab-context";
import { cn } from "@/lib/utils";

const TYPE_OPTIONS: readonly { value: TypeFilter; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "image", label: "Image" },
  { value: "video", label: "Video" },
  { value: "gif", label: "GIF" },
  { value: "link", label: "Link" },
  { value: "article", label: "Article" },
  { value: "quoted", label: "Quoted tweet" },
  { value: "thread", label: "Thread / Reply" },
];

type SortOption = {
  value: SortKey;
  label: string;
  Icon: React.ComponentType<{ className?: string }>;
};

// Sort key options for the dropdown, grouped by visual separator at
// render time: dates / engagement / random.
const SORT_OPTIONS: readonly SortOption[] = [
  { value: "saved-date", label: "Saved date", Icon: RiHistoryLine },
  { value: "posted-date", label: "Posted date", Icon: RiCalendarLine },
  { value: "likes", label: "Likes", Icon: RiHeart3Line },
  { value: "reposts", label: "Reposts", Icon: RiRepeatLine },
  { value: "bookmarks", label: "Bookmarks", Icon: RiBookmarkLine },
  { value: "random", label: "Random", Icon: RiQuestionLine },
];

// Order toggle's tooltip + aria-label depends on the current sort key:
// dates use newest/oldest, engagement uses most/fewest. Random has no
// direction (the toggle is hidden for random).
function orderLabel(sort: SortKey, order: SortOrder): string {
  if (sort === "saved-date" || sort === "posted-date") {
    return order === "desc" ? "Newest first" : "Oldest first";
  }
  return order === "desc" ? "Most first" : "Fewest first";
}

export function TopBar() {
  const { state, dispatch } = useFilter();
  const { state: sidebarState } = useSidebar();
  const { activeTab } = useTab();
  const filtered = useFilteredBookmarks();
  const gallery = useFilteredGallery();
  const isGallery = activeTab === "gallery";
  // Grid tabs render the full chrome. Non-grid tabs (Duplicates/Settings)
  // return null; App.tsx's scroll container pads pt-14 instead so the 56px
  // top reservation lives inside the scroll viewport — scrolls with content
  // rather than sitting permanently outside `overflow-auto`.
  const isGrid = isGridTab(activeTab);
  const resultCount = isGallery ? gallery.length : filtered.length;
  const resultLabel = isGallery ? "media" : "results";

  const sortOption = SORT_OPTIONS.find((o) => o.value === state.sort);
  const sortLabel = sortOption?.label ?? "Sort";
  const SortIcon = sortOption?.Icon ?? RiHistoryLine;
  const orderTooltip = orderLabel(state.sort, state.order);
  const typesLabel =
    state.types.size === 0
      ? "Types"
      : state.types.size === 1
        ? (TYPE_OPTIONS.find((o) => o.value === [...state.types][0])?.label ??
          "Types")
        : `${state.types.size} types`;

  const accountsLabel =
    state.accounts.size === 0
      ? "Accounts"
      : state.accounts.size === 1
        ? `@${[...state.accounts][0]}`
        : `${state.accounts.size} accounts`;

  const colorLabel = !state.color
    ? "Color"
    : "special" in state.color
      ? "Mono"
      : displayHex(state.color.hex);

  const categoryLabel =
    state.categories.size === 0
      ? "Categories"
      : state.categories.size === 1
        ? (() => {
            const only = [...state.categories][0];
            return only === UNCLASSIFIED_CATEGORY ? "Uncategorized" : only;
          })()
        : `${state.categories.size} categories`;

  const languageLabel =
    state.languages.size === 0
      ? "Language"
      : state.languages.size === 1
        ? formatLanguageName([...state.languages][0])
        : `${state.languages.size} languages`;

  // Animate padding-left in lockstep with the sidebar's slide
  // (`transition-[left] duration-200 ease-linear` on `sidebar-container`,
  // see ui/sidebar.tsx:233). When sidebar collapses, this padding grows
  // 12 → 56 over the same 200ms — first filter content slides smoothly
  // from x=sidebar-width+12 → x=56, ending just to the right of the
  // floating SidebarTrigger (at viewport x=12, ~32px wide).
  const headerClass = cn(
    "flex h-14 shrink-0 items-center gap-2 px-3",
    "transition-[padding-left] duration-200 ease-linear",
    sidebarState === "collapsed" && "pl-14",
  );

  if (!isGrid) return null;

  return (
    <header className={headerClass}>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost">
            <SortIcon />
            <span>{sortLabel}</span>
            <RiArrowDownSLine className="text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-[180px]">
          <DropdownMenuRadioGroup
            value={state.sort}
            onValueChange={(v) =>
              dispatch({ type: "setSort", sort: v as SortKey })
            }
          >
            {SORT_OPTIONS.map((opt, i) => {
              // Visual separators after posted-date and after bookmarks
              // — splits the list into date / engagement / random
              // sections without changing the data structure.
              const needsSeparator =
                i > 0 &&
                ((SORT_OPTIONS[i - 1].value === "posted-date" &&
                  opt.value === "likes") ||
                  (SORT_OPTIONS[i - 1].value === "bookmarks" &&
                    opt.value === "random"));
              return (
                <div key={opt.value}>
                  {needsSeparator && <DropdownMenuSeparator />}
                  <DropdownMenuRadioItem value={opt.value}>
                    <opt.Icon />
                    {opt.label}
                  </DropdownMenuRadioItem>
                </div>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      {state.sort !== "random" ? (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={orderTooltip}
              onClick={() =>
                dispatch({
                  type: "setOrder",
                  order: state.order === "desc" ? "asc" : "desc",
                })
              }
            >
              {state.order === "desc" ? <RiSortDesc /> : <RiSortAsc />}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{orderTooltip}</TooltipContent>
        </Tooltip>
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Reshuffle"
              onClick={() => dispatch({ type: "reshuffleRandom" })}
            >
              <DiceCube shuffleNonce={state.shuffleNonce} />
            </Button>
          </TooltipTrigger>
          <TooltipContent>Reshuffle</TooltipContent>
        </Tooltip>
      )}
      <span className="text-muted-foreground text-xs tabular-nums">
        {resultCount.toLocaleString()} {resultLabel}
      </span>

      {isGallery && <ZoomControls />}

      <div className="flex-1" />

      <div className="group relative">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className={cn(state.types.size > 0 && "bg-muted/80")}
            >
              <RiShapesLine />
              <span>{typesLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-0">
            <TypesPopoverContent />
          </PopoverContent>
        </Popover>
        {state.types.size > 0 && (
          <FilterClearBadge
            onClear={() => dispatch({ type: "clearTypes" })}
          />
        )}
      </div>

      <div className="group relative">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className={cn(state.color !== null && "bg-muted/80")}
            >
              <RiPaletteLine />
              <span>{colorLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-auto">
            <ColorPickerPopoverContent />
          </PopoverContent>
        </Popover>
        {state.color !== null && (
          <FilterClearBadge
            onClear={() => dispatch({ type: "setColor", color: null })}
          />
        )}
      </div>

      <div className="group relative">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className={cn(state.categories.size > 0 && "bg-muted/80")}
            >
              <RiPriceTag3Line />
              <span>{categoryLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-64 p-0">
            <CategoriesPopoverContent />
          </PopoverContent>
        </Popover>
        {state.categories.size > 0 && (
          <FilterClearBadge
            onClear={() => dispatch({ type: "clearCategories" })}
          />
        )}
      </div>

      <div className="group relative">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className={cn(state.languages.size > 0 && "bg-muted/80")}
            >
              <RiTranslate2 />
              <span>{languageLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-56 p-0">
            <LanguagesPopoverContent />
          </PopoverContent>
        </Popover>
        {state.languages.size > 0 && (
          <FilterClearBadge
            onClear={() => dispatch({ type: "clearLanguages" })}
          />
        )}
      </div>

      <div className="group relative">
        <Popover>
          <PopoverTrigger asChild>
            <Button
              variant="ghost"
              className={cn(state.accounts.size > 0 && "bg-muted/80")}
            >
              <RiUserLine />
              <span>{accountsLabel}</span>
            </Button>
          </PopoverTrigger>
          <PopoverContent align="end" className="w-72 p-0">
            <AccountsPopoverContent />
          </PopoverContent>
        </Popover>
        {state.accounts.size > 0 && (
          <FilterClearBadge
            onClear={() => dispatch({ type: "clearAccounts" })}
          />
        )}
      </div>

      <SearchInput />
    </header>
  );
}

function ZoomControls() {
  const { zoomIndex, setZoomIndex, step } = useGalleryZoom();
  const max = ZOOM_LEVELS.length - 1;
  return (
    <div className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => step(-1)}
        disabled={zoomIndex === 0}
        aria-label="Zoom out"
      >
        <RiSubtractLine />
      </Button>
      <Slider
        className="w-24"
        min={0}
        max={max}
        step={1}
        value={[zoomIndex]}
        onValueChange={(v) => setZoomIndex(v[0] ?? 0)}
        aria-label="Gallery zoom"
      />
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => step(1)}
        disabled={zoomIndex === max}
        aria-label="Zoom in"
      >
        <RiAddLine />
      </Button>
    </div>
  );
}

function SearchInput() {
  const { state, dispatch } = useFilter();
  const { history, push, remove } = useSearchHistory();
  const [focused, setFocused] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const blurTimer = useRef<number | null>(null);

  // Mirror of state.search for handlers that run before React re-renders:
  // an Enter-pick sets the query and blurs in the same tick, so onBlur's
  // closure would otherwise record the stale typed prefix into history.
  // Same ref-mirror idiom as hidden-context.
  const searchRef = useRef(state.search);
  useEffect(() => {
    searchRef.current = state.search;
  }, [state.search]);

  const setSearch = (q: string) => {
    searchRef.current = q;
    dispatch({ type: "setSearch", query: q });
  };

  // Plain substring filter. History is capped at 10 entries so simple .includes
  // is fine — no need for cmdk/Intl.Collator fuzzy matching here.
  const filteredHistory = useMemo(() => {
    const q = state.search.trim().toLowerCase();
    if (!q) return history;
    return history.filter((h) => h.toLowerCase().includes(q));
  }, [history, state.search]);

  const open = focused && filteredHistory.length > 0;

  // Reset highlight when the visible list shrinks past it or the popup closes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- resets highlight when external state changes
    if (!open || activeIndex >= filteredHistory.length) setActiveIndex(-1);
  }, [open, filteredHistory.length, activeIndex]);

  const cancelBlur = () => {
    if (blurTimer.current !== null) {
      window.clearTimeout(blurTimer.current);
      blurTimer.current = null;
    }
  };

  // Picks push explicitly because the mouse path never blurs (the item's
  // mousedown preventDefaults to keep input focus). Typed queries are
  // recorded by onBlur alone — its push(searchRef.current) dedups against
  // a preceding pick, so each settle records exactly one entry.
  const pickItem = (item: string) => {
    setSearch(item);
    push(item);
    setFocused(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      setFocused(false);
      return;
    }
    if (!open) {
      if (e.key === "Enter") e.currentTarget.blur(); // onBlur records the query
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filteredHistory.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(-1, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (activeIndex >= 0) pickItem(filteredHistory[activeIndex]);
      e.currentTarget.blur();
    }
  };

  return (
    <Popover open={open}>
      <PopoverAnchor asChild>
        <InputGroup className="w-[260px]">
          {/* Per shadcn docs: input first in DOM for focus management;
              addons use the `align` prop for visual placement. */}
          <InputGroupInput
            placeholder="Search..."
            value={state.search}
            onChange={(e) => setSearch(e.target.value)}
            onFocus={() => {
              cancelBlur();
              setFocused(true);
            }}
            onBlur={() => {
              // Defer so a click on a popover row registers before we close
              // (mousedown→blur→click ordering). Items themselves cancel the
              // pending blur via cancelBlur in onMouseDown.
              push(searchRef.current);
              blurTimer.current = window.setTimeout(() => {
                setFocused(false);
                blurTimer.current = null;
              }, 150);
            }}
            onKeyDown={onKeyDown}
          />
          <InputGroupAddon align="inline-start">
            <RiSearchLine />
          </InputGroupAddon>
          {state.search.length > 0 && (
            <InputGroupAddon align="inline-end">
              <InputGroupButton
                variant="ghost"
                size="icon-xs"
                aria-label="Clear search"
                // mousedown preventDefault → input keeps focus on click
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setSearch("")}
              >
                <RiCloseLine />
              </InputGroupButton>
            </InputGroupAddon>
          )}
        </InputGroup>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        sideOffset={6}
        className="w-[260px] p-0"
        // Keep focus in the input — don't steal it for the popover content.
        onOpenAutoFocus={(e) => e.preventDefault()}
      >
        <Command shouldFilter={false} className="p-0">
          <CommandList>
            <CommandGroup>
              {filteredHistory.map((item, idx) => {
                const active = idx === activeIndex;
                return (
                  <CommandItem
                    key={item}
                    value={item}
                    // onMouseDown fires before the input's blur — pick here
                    // and cancel the pending blur so the popup doesn't close
                    // mid-pick.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      cancelBlur();
                      pickItem(item);
                    }}
                    onMouseEnter={() => setActiveIndex(idx)}
                    // Drive the cmdk highlight manually — no CommandInput
                    // here, so cmdk won't compute `data-selected` itself.
                    className={cn(
                      active && "bg-muted text-foreground"
                    )}
                  >
                    <RiHistoryLine className="text-muted-foreground" />
                    <span className="flex-1 truncate">{item}</span>
                    <button
                      type="button"
                      aria-label={`Remove "${item}" from history`}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        cancelBlur();
                      }}
                      onClick={(e) => {
                        e.stopPropagation();
                        remove(item);
                      }}
                      className="text-muted-foreground hover:text-foreground relative rounded-sm after:absolute after:-inset-1 after:content-[''] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
                    >
                      <RiCloseLine className="size-3.5" />
                    </button>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

// Checkbox-shaped indicator matching shadcn's faceted-filter example:
// https://github.com/shadcn-ui/ui/blob/main/apps/v4/app/(app)/examples/tasks/components/data-table-faceted-filter.tsx
function CheckIndicator({ selected }: { selected: boolean }) {
  return (
    <div
      className={cn(
        "flex size-4 items-center justify-center rounded-sm border",
        selected
          ? "border-primary bg-primary text-primary-foreground"
          : "border-input [&_svg]:invisible"
      )}
    >
      <RiCheckLine className="size-3" />
    </div>
  );
}

function ColorPickerPopoverContent() {
  const { bookmarks } = useBookmarks();
  const { state, dispatch } = useFilter();
  // The color filter is unusable until colorize.js has written colors.json.
  // Show a hint instead of an empty picker.
  const hasColors = useMemo(
    () => !!bookmarks?.some((b) => b.media.some((m) => m.colors)),
    [bookmarks]
  );

  if (!hasColors) {
    return (
      <div className="text-muted-foreground w-60 py-6 text-center text-xs/relaxed">
        Color filter will appear after first synchronization.
      </div>
    );
  }

  return (
    <ColorPicker
      value={state.color}
      onChange={(color) => dispatch({ type: "setColor", color })}
    />
  );
}

function TypesPopoverContent() {
  const { state, dispatch } = useFilter();
  const { bookmarks: source, galleryItems, isGallery } =
    useFilterCountSource("types");

  // On Gallery, only image/video/gif apply — text/link/quoted/thread are
  // bookmark-level concepts that filter.ts ignores in the gallery pipeline.
  // Hide them here so the user can't toggle a value that does nothing.
  const visibleOptions = useMemo(
    () =>
      isGallery
        ? TYPE_OPTIONS.filter(
            (o) => o.value === "image" || o.value === "video" || o.value === "gif",
          )
        : TYPE_OPTIONS,
    [isGallery],
  );

  // Counts narrow with other active filters. On Gallery, counted in media
  // units (1 bookmark with 3 photos = 3 toward "image") to match what the
  // grid actually renders.
  const counts = useMemo(() => {
    const out: Record<TypeFilter, number> = {
      text: 0,
      image: 0,
      video: 0,
      gif: 0,
      link: 0,
      article: 0,
      quoted: 0,
      thread: 0,
    };
    if (isGallery) {
      for (const item of galleryItems) {
        if (item.media.type === "photo") out.image += 1;
        else if (item.media.type === "video") out.video += 1;
        else if (item.media.type === "animated_gif") out.gif += 1;
      }
    } else {
      for (const b of source) {
        for (const opt of TYPE_OPTIONS) {
          if (matchesType(b, opt.value)) out[opt.value] += 1;
        }
      }
    }
    return out;
  }, [source, galleryItems, isGallery]);

  return (
    <Command className="p-0">
      <CommandList>
        <CommandGroup>
          {visibleOptions.map((opt) => {
            const selected = state.types.has(opt.value);
            return (
              <CommandItem
                key={opt.value}
                value={opt.label}
                onSelect={() =>
                  dispatch({ type: "toggleType", value: opt.value })
                }
              >
                <CheckIndicator selected={selected} />
                <span className="flex-1">{opt.label}</span>
                <span className="text-muted-foreground tabular-nums">
                  {counts[opt.value]}
                </span>
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

type AccountRow = { handle: string; name: string; pfp: string | null; count: number };

function AccountsPopoverContent() {
  const { state, dispatch } = useFilter();
  const { bookmarks: source, galleryItems, isGallery } =
    useFilterCountSource("accounts");
  const [query, setQuery] = useState("");

  // Counts narrow with other active filters. On Gallery, counted in media
  // units — a bookmark with 3 photos by @foo contributes 3 to @foo's count.
  const { multi, others } = useMemo(() => {
    const stats = new Map<
      string,
      { name: string; pfp: string | null; count: number }
    >();
    const tally = (handle: string, name: string, pfp: string | null) => {
      const prev = stats.get(handle);
      if (prev) {
        prev.count += 1;
        if (!prev.pfp && pfp) prev.pfp = pfp;
      } else {
        stats.set(handle, { name, pfp, count: 1 });
      }
    };
    if (isGallery) {
      for (const item of galleryItems) {
        const b = item.bookmark;
        tally(b.authorHandle, b.authorName, b.pfp);
      }
    } else {
      for (const b of source) {
        tally(b.authorHandle, b.authorName, b.pfp);
      }
    }
    const all: AccountRow[] = [...stats.entries()]
      .map(([handle, v]) => ({ handle, name: v.name, pfp: v.pfp, count: v.count }))
      .sort((a, b) => b.count - a.count);
    return {
      multi: all.filter((r) => r.count > 1),
      others: all.filter((r) => r.count === 1),
    };
  }, [source, galleryItems, isGallery]);

  const q = query.trim().toLowerCase();
  const hasQuery = q.length > 0;

  // Empty query → only multi-posters + "Other"
  // collapse row. Non-empty query → filter across all accounts and render
  // just the matches. Either way, the number of mounted items stays small.
  const visible = useMemo<AccountRow[]>(() => {
    if (!hasQuery) return multi;
    const match = (r: AccountRow) =>
      r.handle.toLowerCase().includes(q) || r.name.toLowerCase().includes(q);
    return [...multi.filter(match), ...others.filter(match)];
  }, [hasQuery, q, multi, others]);

  const otherHandles = useMemo(() => others.map((r) => r.handle), [others]);
  const otherAllActive =
    otherHandles.length > 0 && otherHandles.every((h) => state.accounts.has(h));

  const toggleOther = () => {
    const next = new Set(state.accounts);
    if (otherAllActive) for (const h of otherHandles) next.delete(h);
    else for (const h of otherHandles) next.add(h);
    dispatch({ type: "setAccounts", accounts: next });
  };

  // cmdk runs its own fuzzy-filter on CommandItem `value`. We're filtering in
  // React already, so disable cmdk's filter to avoid double-filtering + to
  // ensure every item we render is shown.
  return (
    <Command className="p-0" shouldFilter={false}>
      <CommandInput
        placeholder="Search accounts..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {visible.length === 0 && !(!hasQuery && otherHandles.length > 0) && (
          <CommandEmpty className="text-muted-foreground">No matches.</CommandEmpty>
        )}
        <CommandGroup>
          {visible.map((h) => {
            const selected = state.accounts.has(h.handle);
            return (
              <CommandItem
                key={h.handle}
                value={h.handle}
                onSelect={() =>
                  dispatch({ type: "toggleAccount", handle: h.handle })
                }
              >
                <CheckIndicator selected={selected} />
                {h.pfp ? (
                  <img
                    src={h.pfp}
                    alt=""
                    loading="lazy"
                    className="size-6 shrink-0 rounded-full object-cover"
                  />
                ) : (
                  <div className="bg-muted size-6 shrink-0 rounded-full" />
                )}
                <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                  <span className="truncate">
                    <span className="font-medium">{h.name}</span>{" "}
                    <span className="text-muted-foreground">@{h.handle}</span>
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {h.count}
                  </span>
                </div>
              </CommandItem>
            );
          })}
          {!hasQuery && otherHandles.length > 0 && (
            <CommandItem value="__other__" onSelect={toggleOther}>
              <CheckIndicator selected={otherAllActive} />
              <div className="bg-muted text-muted-foreground flex size-6 shrink-0 items-center justify-center rounded-full">
                <RiGroupLine className="size-3.5" />
              </div>
              <div className="flex min-w-0 flex-1 items-center justify-between gap-2">
                <span className="truncate">
                  <span className="font-medium">Other</span>{" "}
                  <span className="text-muted-foreground">
                    {isGallery ? "1 media each" : "1 bookmark each"}
                  </span>
                </span>
                <span className="text-muted-foreground tabular-nums">
                  {otherHandles.length}
                </span>
              </div>
            </CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

function CategoriesPopoverContent() {
  const { state, dispatch } = useFilter();
  const { bookmarks: source, galleryItems, isGallery } =
    useFilterCountSource("categories");
  const [query, setQuery] = useState("");

  // Counts narrow with other active filters. On Gallery, counted in media
  // units — a bookmark with 3 photos tagged "tools" contributes 3 to the
  // "tools" count, since clicking it would surface 3 tiles.
  const { sortedCategories, categoryCounts, uncategorizedCount } = useMemo(() => {
    const counts = new Map<string, number>();
    let uncategorized = 0;
    const tally = (
      categories: readonly string[],
      primary: string | null | undefined,
    ) => {
      for (const c of categories) counts.set(c, (counts.get(c) ?? 0) + 1);
      if (categories.length === 0 && !primary) uncategorized += 1;
    };
    if (isGallery) {
      for (const item of galleryItems) {
        tally(item.bookmark.categories, item.bookmark.primary_category);
      }
    } else {
      for (const b of source) {
        tally(b.categories, b.primary_category);
      }
    }
    return {
      sortedCategories: [...counts.keys()].sort(),
      categoryCounts: counts,
      uncategorizedCount: uncategorized,
    };
  }, [source, galleryItems, isGallery]);

  const q = query.trim().toLowerCase();
  const hasQuery = q.length > 0;
  const showUncategorized =
    !hasQuery || "uncategorized".includes(q);
  const visibleCategories = hasQuery
    ? sortedCategories.filter((c) => c.toLowerCase().includes(q))
    : sortedCategories;

  const empty =
    sortedCategories.length === 0 &&
    (!showUncategorized || uncategorizedCount === 0);

  const toggle = (value: string) =>
    dispatch({ type: "toggleCategory", value });

  return (
    <Command className="p-0" shouldFilter={false}>
      <CommandInput
        placeholder="Search categories..."
        value={query}
        onValueChange={setQuery}
      />
      <CommandList>
        {empty && (
          <CommandEmpty className="text-muted-foreground">
            {sortedCategories.length === 0 ? "No categories yet" : "No matches"}
          </CommandEmpty>
        )}
        <CommandGroup>
          {showUncategorized && (
            <CommandItem
              value={UNCLASSIFIED_CATEGORY}
              onSelect={() => toggle(UNCLASSIFIED_CATEGORY)}
            >
              <CheckIndicator selected={state.categories.has(UNCLASSIFIED_CATEGORY)} />
              <RiPriceTag3Line className="text-muted-foreground size-3.5 shrink-0" />
              <span className="flex-1">Uncategorized</span>
              <span className="text-muted-foreground tabular-nums">
                {uncategorizedCount}
              </span>
            </CommandItem>
          )}
          {visibleCategories.map((category) => (
            <CommandItem
              key={category}
              value={category}
              onSelect={() => toggle(category)}
            >
              <CheckIndicator selected={state.categories.has(category)} />
              <RiPriceTag3Line className="text-muted-foreground size-3.5 shrink-0" />
              <span className="flex-1 truncate">{category}</span>
              <span className="text-muted-foreground tabular-nums">
                {categoryCounts.get(category) || 0}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

// Counts narrow with other active filters, same model as the Categories /
// Accounts popovers. On Gallery, counted in media units. Sentinels (`zxx`,
// `qme`, `und`) are filtered out at tally time so the popover never offers
// "no linguistic content" as a selectable filter — see lib/language.ts.
function LanguagesPopoverContent() {
  const { state, dispatch } = useFilter();
  const { bookmarks: source, galleryItems, isGallery } =
    useFilterCountSource("languages");

  const { sortedLanguages, languageCounts } = useMemo(() => {
    const counts = new Map<string, number>();
    const tally = (lang: string | null | undefined) => {
      if (!isDisplayableLanguage(lang)) return;
      counts.set(lang!, (counts.get(lang!) ?? 0) + 1);
    };
    if (isGallery) {
      for (const item of galleryItems) tally(item.bookmark.language);
    } else {
      for (const b of source) tally(b.language);
    }
    // Sort by count desc, then code asc — most-frequent first matches what
    // a user typically wants to skim ("here's the language I have a lot of,
    // here's the long tail").
    const sorted = [...counts.keys()].sort((a, b) => {
      const diff = (counts.get(b) ?? 0) - (counts.get(a) ?? 0);
      return diff !== 0 ? diff : a.localeCompare(b);
    });
    return { sortedLanguages: sorted, languageCounts: counts };
  }, [source, galleryItems, isGallery]);

  const toggle = (value: string) =>
    dispatch({ type: "toggleLanguage", value });

  return (
    <Command className="p-0" shouldFilter={false}>
      <CommandList>
        {sortedLanguages.length === 0 && (
          <CommandEmpty className="text-muted-foreground">
            No languages yet
          </CommandEmpty>
        )}
        <CommandGroup>
          {sortedLanguages.map((lang) => (
            <CommandItem
              key={lang}
              value={lang}
              onSelect={() => toggle(lang)}
            >
              <CheckIndicator selected={state.languages.has(lang)} />
              <span className="flex-1 truncate" title={lang.toUpperCase()}>
                {formatLanguageName(lang)}
              </span>
              <span className="text-muted-foreground tabular-nums">
                {languageCounts.get(lang) || 0}
              </span>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
    </Command>
  );
}

// Corner "clear filter" badge — a 24px hit target (size-6, on the 4px grid) with
// a 14px visible dot (size-3.5) centered inside. The -top-3/-right-3 offsets are
// exactly half of size-6 for 50% corner overlap (an invisible halo around the
// dot) without needing arbitrary values. stopPropagation so the badge click
// doesn't open the popover.
function FilterClearBadge({ onClear }: { onClear: () => void }) {
  return (
    <button
      type="button"
      aria-label="Clear filter"
      // -top/-right are 11px instead of 12px (half of size-6) to compensate for
      // shadcn Button's `border border-transparent bg-clip-padding` — the
      // visible button surface is inset 1px from the bounding box, so aligning
      // the badge center to the *visible* corner needs a 1px pull-back.
      //
      // Hidden by default; revealed only when the filter wrapper is hovered
      // OR the popover is open (Radix's PopoverTrigger sets aria-expanded).
      className="absolute -top-[11px] -right-[11px] z-10 hidden size-6 items-center justify-center appearance-none p-0 transition-opacity group-hover:flex group-has-[[aria-expanded=true]]:flex hover:opacity-70"
      onClick={(e) => {
        e.stopPropagation();
        onClear();
      }}
    >
      {/* Layout:
          - button is flex-centered so the `<span>` dot lands at center via the
            "absolute with auto inset" rule (flex resolves its auto position)
          - the icon uses explicit top/left 50% + translate(-50%, -50%)
            centering
          - hover opacity is on the BUTTON so dot + icon fade as one layer
            (Safari otherwise snaps them to different subpixel grids) */}
      <span className="bg-foreground absolute size-3.5 rounded-full" />
      <RiCloseLine className="text-background absolute top-1/2 left-1/2 size-3 -translate-x-1/2 -translate-y-1/2" />
    </button>
  );
}
