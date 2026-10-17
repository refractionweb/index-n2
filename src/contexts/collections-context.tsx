/* eslint-disable react-refresh/only-export-components */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useTab } from "@/contexts/tab-context";
import { collectionIdOf } from "@/lib/tabs";

// A collection is a user-named, non-exclusive set of bookmark IDs. Unlike
// Archive it has no side effect on other views: a bookmark can sit in any
// number of collections and still show on Home. Persisted whole to
// ~/.index-n2/collections.json via /api/collections (same contract as the
// archive list: client owns the document, server validates and replaces).
export type Collection = {
  id: string;
  name: string;
  createdAt: string;
  // Hide members from Home and Gallery (a per-collection archive). The
  // collection's own tab always shows them; Archive is unaffected.
  hidden: boolean;
  ids: ReadonlySet<string>;
};

type Wire = {
  id: string;
  name: string;
  createdAt: string;
  hidden?: boolean;
  ids: string[];
};

type CollectionsValue = {
  collections: readonly Collection[];
  byId: ReadonlyMap<string, Collection>;
  create: (name: string) => Collection;
  rename: (id: string, name: string) => void;
  setHidden: (id: string, hidden: boolean) => void;
  remove: (id: string) => void;
  add: (collectionId: string, bookmarkIds: string[]) => void;
  removeFrom: (collectionId: string, bookmarkIds: string[]) => void;
  // Opens the name dialog. `create` calls back with the new collection so
  // callers can chain (e.g. add the current selection to it).
  promptCreate: (onCreated?: (c: Collection) => void) => void;
  promptRename: (id: string) => void;
};

const CollectionsContext = createContext<CollectionsValue | null>(null);

function fromWire(w: Wire): Collection {
  return {
    id: w.id,
    name: w.name,
    createdAt: w.createdAt,
    hidden: w.hidden === true,
    ids: new Set(w.ids),
  };
}

function toWire(c: Collection): Wire {
  return {
    id: c.id,
    name: c.name,
    createdAt: c.createdAt,
    hidden: c.hidden,
    ids: [...c.ids],
  };
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

type Prompt =
  | { mode: "create"; onCreated?: (c: Collection) => void }
  | { mode: "rename"; id: string; initial: string };

export function CollectionsProvider({ children }: { children: ReactNode }) {
  const [collections, setCollections] = useState<Collection[]>([]);
  // Ref mirror + serialized POST chain: same rationale as HiddenProvider.
  // Two synchronous mutations must both see the latest state, and two
  // in-flight POSTs must land in order since the server stores the last
  // body it receives.
  const ref = useRef<Collection[]>([]);
  const chainRef = useRef<Promise<unknown>>(Promise.resolve());
  const { activeTab, setTab } = useTab();
  const [prompt, setPrompt] = useState<Prompt | null>(null);

  const resyncFromServer = useCallback(() => {
    return fetch("/api/collections")
      .then((r) => r.json())
      .then((list: Wire[]) => {
        const next = list.map(fromWire);
        ref.current = next;
        setCollections(next);
      });
  }, []);

  useEffect(() => {
    resyncFromServer().catch((e) =>
      console.error("Failed to load collections:", e),
    );
  }, [resyncFromServer]);

  const persist = useCallback(
    (next: Collection[]) => {
      ref.current = next;
      setCollections(next);
      chainRef.current = chainRef.current.then(async () => {
        try {
          const res = await fetch("/api/collections", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(next.map(toWire)),
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
        } catch (e) {
          console.error("Failed to persist collections:", e);
          try {
            await resyncFromServer();
          } catch (e2) {
            console.error("Failed to resync after persist error:", e2);
          }
        }
      });
    },
    [resyncFromServer],
  );

  const create = useCallback(
    (name: string): Collection => {
      const c: Collection = {
        id: newId(),
        name: name.trim(),
        createdAt: new Date().toISOString(),
        hidden: false,
        ids: new Set(),
      };
      persist([...ref.current, c]);
      return c;
    },
    [persist],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      persist(ref.current.map((c) => (c.id === id ? { ...c, name: trimmed } : c)));
    },
    [persist],
  );

  const setHidden = useCallback(
    (id: string, hidden: boolean) => {
      persist(ref.current.map((c) => (c.id === id ? { ...c, hidden } : c)));
    },
    [persist],
  );

  const remove = useCallback(
    (id: string) => {
      persist(ref.current.filter((c) => c.id !== id));
      if (collectionIdOf(activeTab) === id) setTab("home");
    },
    [persist, activeTab, setTab],
  );

  const add = useCallback(
    (collectionId: string, bookmarkIds: string[]) => {
      persist(
        ref.current.map((c) => {
          if (c.id !== collectionId) return c;
          const ids = new Set(c.ids);
          for (const b of bookmarkIds) ids.add(b);
          return { ...c, ids };
        }),
      );
    },
    [persist],
  );

  const removeFrom = useCallback(
    (collectionId: string, bookmarkIds: string[]) => {
      persist(
        ref.current.map((c) => {
          if (c.id !== collectionId) return c;
          const ids = new Set(c.ids);
          for (const b of bookmarkIds) ids.delete(b);
          return { ...c, ids };
        }),
      );
    },
    [persist],
  );

  const promptCreate = useCallback(
    (onCreated?: (c: Collection) => void) => setPrompt({ mode: "create", onCreated }),
    [],
  );
  const promptRename = useCallback((id: string) => {
    const c = ref.current.find((x) => x.id === id);
    if (c) setPrompt({ mode: "rename", id, initial: c.name });
  }, []);

  const byId = useMemo(
    () => new Map(collections.map((c) => [c.id, c])),
    [collections],
  );

  const value = useMemo<CollectionsValue>(
    () => ({
      collections,
      byId,
      create,
      rename,
      setHidden,
      remove,
      add,
      removeFrom,
      promptCreate,
      promptRename,
    }),
    [collections, byId, create, rename, setHidden, remove, add, removeFrom, promptCreate, promptRename],
  );

  return (
    <CollectionsContext.Provider value={value}>
      {children}
      <CollectionNameDialog
        prompt={prompt}
        onClose={() => setPrompt(null)}
        onSubmit={(name) => {
          if (!prompt) return;
          if (prompt.mode === "create") {
            const c = create(name);
            prompt.onCreated?.(c);
          } else {
            rename(prompt.id, name);
          }
          setPrompt(null);
        }}
      />
    </CollectionsContext.Provider>
  );
}

function CollectionNameDialog({
  prompt,
  onClose,
  onSubmit,
}: {
  prompt: Prompt | null;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  return (
    <Dialog open={prompt !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-sm">
        {/* Radix unmounts DialogContent on close, so the form's name state
            initializes fresh on every open — no reset effect needed. */}
        {prompt && (
          <CollectionNameForm prompt={prompt} onClose={onClose} onSubmit={onSubmit} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function CollectionNameForm({
  prompt,
  onClose,
  onSubmit,
}: {
  prompt: Prompt;
  onClose: () => void;
  onSubmit: (name: string) => void;
}) {
  const rename = prompt.mode === "rename";
  const [name, setName] = useState(rename ? prompt.initial : "");

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (name.trim()) onSubmit(name);
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{rename ? "Rename collection" : "New collection"}</DialogTitle>
        <DialogDescription>
          Collections group bookmarks without removing them from Home.
        </DialogDescription>
      </DialogHeader>
      <Input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name"
        maxLength={200}
        aria-label="Collection name"
      />
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={!name.trim()}>
          {rename ? "Rename" : "Create"}
        </Button>
      </DialogFooter>
    </form>
  );
}

export function useCollections(): CollectionsValue {
  const ctx = useContext(CollectionsContext);
  if (!ctx) throw new Error("useCollections requires <CollectionsProvider>");
  return ctx;
}

// Union of member ids across collections marked hidden. Home and Gallery
// exclude these; see lib/scope.ts.
const EMPTY: ReadonlySet<string> = new Set();
export function useHiddenByCollections(): ReadonlySet<string> {
  const { collections } = useCollections();
  return useMemo(() => {
    const hidden = collections.filter((c) => c.hidden);
    if (hidden.length === 0) return EMPTY;
    const out = new Set<string>();
    for (const c of hidden) for (const id of c.ids) out.add(id);
    return out;
  }, [collections]);
}

// Member set of the collection the active tab shows, or null on fixed tabs.
// Null (not an empty set) so scope code can tell "not a collection tab"
// from "a collection with nothing in it".
export function useActiveCollection(): Collection | null {
  const { byId } = useCollections();
  const { activeTab } = useTab();
  const id = collectionIdOf(activeTab);
  return id ? (byId.get(id) ?? null) : null;
}
