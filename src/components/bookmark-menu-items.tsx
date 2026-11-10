import {
  RiAddLine,
  RiFileCopyLine,
  RiFolderLine,
  RiHashtag,
  RiInboxArchiveLine,
  RiInboxUnarchiveLine,
} from "@remixicon/react";
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useCollections } from "@/contexts/collections-context";
import { useHidden } from "@/contexts/hidden-context";
import { copyText } from "@/lib/clipboard";
import type { Bookmark } from "@/types/bookmark";

// Shared body of the per-bookmark "⋯" menu. BookmarkCard and the Lightbox
// both render it so the two menus can't drift.
export function BookmarkMenuItems({ bookmark }: { bookmark: Bookmark }) {
  const { id, url } = bookmark;
  const { archive, restore, isHidden } = useHidden();
  const { collections, add, removeFrom, promptCreate } = useCollections();
  const restoring = isHidden(id);

  return (
    <>
      <DropdownMenuItem onSelect={() => void copyText(url)}>
        <RiFileCopyLine />
        Copy link
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={() => void copyText(id)}>
        <RiHashtag />
        Copy ID
      </DropdownMenuItem>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <RiFolderLine />
          Collections
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {collections.map((c) => (
            <DropdownMenuCheckboxItem
              key={c.id}
              checked={c.ids.has(id)}
              onCheckedChange={(checked) =>
                checked ? add(c.id, [id]) : removeFrom(c.id, [id])
              }
            >
              {c.name}
            </DropdownMenuCheckboxItem>
          ))}
          {collections.length > 0 && <DropdownMenuSeparator />}
          <DropdownMenuItem onSelect={() => promptCreate((c) => add(c.id, [id]))}>
            <RiAddLine />
            New collection…
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
      <DropdownMenuItem onSelect={() => (restoring ? restore([id]) : archive([id]))}>
        {restoring ? <RiInboxUnarchiveLine /> : <RiInboxArchiveLine />}
        {restoring ? "Restore" : "Archive"}
      </DropdownMenuItem>
    </>
  );
}
