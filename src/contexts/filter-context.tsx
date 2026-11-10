/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useReducer,
  type Dispatch,
  type ReactNode,
} from "react";
import type { ColorSelection } from "@/components/color-picker";

export type TypeFilter =
  | "text"
  | "image"
  | "video"
  | "gif"
  | "link"
  | "article"
  | "quoted"
  | "thread";

// Sort key (the field) and order (the direction) are decoupled. The UI
// surfaces them as two controls — a key dropdown and a direction toggle
// — instead of one combined dropdown. Splitting unlocks "least liked /
// fewest reposts / fewest bookmarks" without bloating the option list,
// and removes the asymmetric labeling where dates carried direction in
// the option name ("Recently saved" / "Newest") but engagement didn't.
export type SortKey =
  | "saved-date"
  | "posted-date"
  | "likes"
  | "reposts"
  | "bookmarks"
  | "random";

export type SortOrder = "asc" | "desc";

export type FilterState = {
  accounts: ReadonlySet<string>;
  types: ReadonlySet<TypeFilter>;
  categories: ReadonlySet<string>;
  // Multi-select set of ISO 639-1 codes (always lowercase, always 2 chars
  // — see lib/language.ts). OR semantics across the selected set: a
  // bookmark passes if its `language` matches any chosen code. Sentinels
  // (`zxx`, `qme`, `und`) never appear in the popover and never match —
  // they fail `isDisplayableLanguage`.
  languages: ReadonlySet<string>;
  color: ColorSelection | null;
  search: string;
  sort: SortKey;
  // Direction. Convention: "desc" = highest values first (newest dates,
  // most likes), "asc" = lowest first. Ignored when sort === "random".
  order: SortOrder;
  // Seed of the random sort (see applySort in lib/filter.ts): the order is
  // a pure function of this value and the bookmark ids, so it stays put
  // until the dice click sets a fresh value. Random per page load, kept
  // across Clear all.
  // Also seeds the dice cube's initial face on mount via
  // `(floor(shuffleNonce * 6) + 1)`. DiceCube owns its own non-repeat
  // guarantee across clicks (see pickTumble there).
  shuffleNonce: number;
};

type Action =
  | { type: "toggleAccount"; handle: string }
  | { type: "setAccounts"; accounts: ReadonlySet<string> }
  | { type: "clearAccounts" }
  | { type: "toggleType"; value: TypeFilter }
  | { type: "clearTypes" }
  | { type: "toggleCategory"; value: string }
  | { type: "setCategories"; categories: ReadonlySet<string> }
  | { type: "clearCategories" }
  | { type: "toggleLanguage"; value: string }
  | { type: "setLanguages"; languages: ReadonlySet<string> }
  | { type: "clearLanguages" }
  | { type: "setColor"; color: ColorSelection | null }
  | { type: "setSearch"; query: string }
  | { type: "setSort"; sort: SortKey }
  | { type: "setOrder"; order: SortOrder }
  | { type: "reshuffleRandom" }
  | { type: "clearAll" };

const initialState: FilterState = {
  accounts: new Set(),
  types: new Set(),
  categories: new Set(),
  languages: new Set(),
  color: null,
  search: "",
  sort: "saved-date",
  order: "desc",
  shuffleNonce: Math.random(),
};

function reducer(state: FilterState, action: Action): FilterState {
  switch (action.type) {
    case "toggleAccount": {
      const next = new Set(state.accounts);
      if (next.has(action.handle)) next.delete(action.handle);
      else next.add(action.handle);
      return { ...state, accounts: next };
    }
    case "setAccounts":
      return { ...state, accounts: action.accounts };
    case "clearAccounts":
      return state.accounts.size === 0
        ? state
        : { ...state, accounts: new Set() };
    case "toggleType": {
      const next = new Set(state.types);
      if (next.has(action.value)) next.delete(action.value);
      else next.add(action.value);
      return { ...state, types: next };
    }
    case "clearTypes":
      return state.types.size === 0 ? state : { ...state, types: new Set() };
    case "toggleCategory": {
      const next = new Set(state.categories);
      if (next.has(action.value)) next.delete(action.value);
      else next.add(action.value);
      return { ...state, categories: next };
    }
    case "setCategories":
      return { ...state, categories: action.categories };
    case "clearCategories":
      return state.categories.size === 0
        ? state
        : { ...state, categories: new Set() };
    case "toggleLanguage": {
      const next = new Set(state.languages);
      if (next.has(action.value)) next.delete(action.value);
      else next.add(action.value);
      return { ...state, languages: next };
    }
    case "setLanguages":
      return { ...state, languages: action.languages };
    case "clearLanguages":
      return state.languages.size === 0
        ? state
        : { ...state, languages: new Set() };
    case "setColor":
      return { ...state, color: action.color };
    case "setSearch":
      return state.search === action.query
        ? state
        : { ...state, search: action.query };
    case "setSort":
      return state.sort === action.sort
        ? state
        : { ...state, sort: action.sort };
    case "setOrder":
      return state.order === action.order
        ? state
        : { ...state, order: action.order };
    case "reshuffleRandom":
      // Fresh nonce = fresh random order. DiceCube owns the dice-face
      // anti-repeat guarantee internally (see pickTumble there).
      return { ...state, shuffleNonce: Math.random() };
    case "clearAll":
      // Preserve user's chosen sort + order, and the current shuffle, across
      // filter resets.
      return {
        ...initialState,
        sort: state.sort,
        order: state.order,
        shuffleNonce: state.shuffleNonce,
      };
  }
}

type FilterValue = {
  state: FilterState;
  dispatch: Dispatch<Action>;
  clearAll: () => void;
};

const FilterContext = createContext<FilterValue | null>(null);

export function FilterProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const clearAll = useCallback(() => dispatch({ type: "clearAll" }), []);
  const value = useMemo<FilterValue>(
    () => ({ state, dispatch, clearAll }),
    [state, clearAll]
  );
  return (
    <FilterContext.Provider value={value}>{children}</FilterContext.Provider>
  );
}

export function useFilter(): FilterValue {
  const ctx = useContext(FilterContext);
  if (!ctx) throw new Error("useFilter requires <FilterProvider>");
  return ctx;
}
