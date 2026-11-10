import type { Bookmark } from "@/types/bookmark";
import { expandTcoLinks, fmtAbsoluteDate } from "@/lib/format";

// Export formats for a set of bookmarks. All are plain text so they can go
// to the clipboard or to a file. IDs serve agents that have `ft` on PATH
// (`ft show <id> --json`); Markdown is self-contained for readers without
// it. Links are for humans and for tools that resolve x.com URLs.

export function exportIds(bookmarks: Bookmark[]): string {
  return bookmarks.map((b) => b.id).join("\n") + "\n";
}

export function exportLinks(bookmarks: Bookmark[]): string {
  return bookmarks.map((b) => b.url).join("\n") + "\n";
}

export type MarkdownOptions = {
  title: string;
  // Directory holding ft's downloaded media, home-relative ("~/…") as the
  // server reports it. When known, media entries list the local file path.
  mediaDir?: string | null;
};

export function exportMarkdown(
  bookmarks: Bookmark[],
  { title, mediaDir }: MarkdownOptions,
): string {
  const out: string[] = [];
  out.push(`# ${title}`);
  out.push("");
  out.push(
    `${bookmarks.length} ${bookmarks.length === 1 ? "bookmark" : "bookmarks"}. Exported ${new Date().toISOString().slice(0, 10)} from index-n2.`,
  );
  out.push("");
  for (const b of bookmarks) {
    out.push("---");
    out.push("");
    out.push(
      `## @${b.authorHandle} (${b.authorName}) · ${fmtAbsoluteDate(b.postedAt)}`,
    );
    out.push("");
    out.push(b.url);
    out.push(`ID: ${b.id}`);
    out.push("");
    const text = expandTcoLinks(b.text || "", b.links).trim();
    if (text) {
      out.push(text);
      out.push("");
    }
    if (b.links.length > 0) {
      out.push("Links:");
      for (const l of b.links) out.push(`- ${l}`);
      out.push("");
    }
    if (b.media.length > 0) {
      out.push("Media:");
      for (const m of b.media) out.push(`- ${mediaLine(m.type, m.url, mediaDir)}`);
      out.push("");
    }
    if (b.quotedTweet) {
      const q = b.quotedTweet;
      out.push(
        `Quoting @${q.authorHandle} (${q.authorName}) · ${fmtAbsoluteDate(q.postedAt)} ${q.url}`,
      );
      out.push("");
      const qt = (q.text || "").trim();
      if (qt) {
        for (const line of qt.split("\n")) out.push(`> ${line}`);
        out.push("");
      }
      if (q.media.length > 0) {
        out.push("Quoted media:");
        for (const m of q.media) out.push(`- ${mediaLine(m.type, m.url, mediaDir)}`);
        out.push("");
      }
    } else if (b.quotedStatusId) {
      out.push(`Quoting ${b.quotedStatusId} (unavailable)`);
      out.push("");
    }
    if (b.article) {
      out.push(`### Article: ${b.article.title}`);
      out.push("");
      out.push(b.article.text.trim());
      out.push("");
    }
  }
  return out.join("\n");
}

function mediaLine(
  type: string,
  url: string | null,
  mediaDir: string | null | undefined,
): string {
  if (!url) return `${type}: not fetched`;
  // Served URLs are `/media/<file>`; map to the on-disk path when we know
  // the directory. The served URL itself only resolves inside the running
  // app, so it's never exported: without a directory the line is the type.
  const file = url.startsWith("/media/") ? url.slice("/media/".length) : null;
  if (file && mediaDir) return `${type}: ${joinPath(mediaDir, file)}`;
  return type;
}

function joinPath(dir: string, file: string): string {
  return dir.endsWith("/") ? dir + file : `${dir}/${file}`;
}

export function downloadText(filename: string, text: string): void {
  const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Revoke after the click has been dispatched; immediate revoke can abort
  // the download in some browsers.
  setTimeout(() => URL.revokeObjectURL(href), 1000);
}

export function slugify(name: string): string {
  const s = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || "export";
}
