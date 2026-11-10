// Settings schema. Mirror of server.js DEFAULT_SETTINGS — kept in sync by
// convention (local single-user app, no shared contract tooling). Each field
// is surfaced in SettingsView and consumed by a different subsystem; adding
// one means updating both sides plus the consumer.

import type { Theme } from "@/components/theme-provider";

export type Settings = {
  autoplayVideos: boolean;
  // 0 = no limit (ft fetch-media without --limit, processes all pending).
  // Positive integers cap the per-run batch. Only Fetch Media uses this —
  // `ft sync`'s internal media phase has no equivalent flag upstream, so
  // Sync ignores the cap entirely (off-or-all via skipMedia instead).
  mediaFetchLimit: number;
  skipProfileImages: boolean;
  // When true, the Sync button runs `ft sync --no-media` — only bookmarks
  // are synced, media isn't downloaded inline. User can click Fetch Media
  // afterwards to handle media separately (with its own --limit cap).
  skipMedia: boolean;
  // When true, Sync passes `--folders`: ft walks each X bookmark folder after
  // the main walk and tags its members, which the sidebar lists as X folders.
  syncFolders: boolean;
  autoOpenBrowser: boolean;
  theme: Theme;
  // Suppresses the "files will be re-downloaded" confirmation when cancelling
  // an in-flight `ft fetch-media`. Set to true when the user ticks "Don't show
  // this again" in the cancel dialog. The dialog only appears where a cancel
  // loses the media manifest: ft older than 1.3.22, or Windows.
  cancelMediaWarningSuppressed: boolean;
  // Suppresses the "no batch limit set — fetch may take a while" warning
  // shown before Sync (when skipMedia is off) and Fetch Media (when
  // mediaFetchLimit is 0). Don't-show-again is shared across both surfaces
  // — once dismissed, the user has acknowledged the unbounded-fetch shape.
  noLimitWarningSuppressed: boolean;
  // When true, hide bookmarks whose post media OR quoted-tweet media
  // hasn't been fully downloaded (any item with `url === null`). Pfp is
  // intentionally excluded — `skipProfileImages` is a legitimate user
  // choice and hiding for a setting-driven absence would be wrong. Off
  // by default; placeholders are honest about pending state when this
  // is off.
  hideUnfetched: boolean;
};

export const DEFAULT_SETTINGS: Settings = {
  autoplayVideos: true,
  mediaFetchLimit: 0,
  skipProfileImages: false,
  skipMedia: false,
  syncFolders: false,
  autoOpenBrowser: true,
  theme: "system",
  cancelMediaWarningSuppressed: false,
  noLimitWarningSuppressed: false,
  hideUnfetched: false,
};
