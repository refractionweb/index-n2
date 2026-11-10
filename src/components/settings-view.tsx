import { useEffect, useState, type ReactNode } from "react";
import { RiAddLine, RiSubtractLine } from "@remixicon/react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import type { Theme } from "@/components/theme-provider";
import { useAppInfo, type FtClientStatus, type FtInfo } from "@/contexts/app-info-context";
import { useSettings } from "@/contexts/settings-context";
import { cn } from "@/lib/utils";
import { DEFAULT_SETTINGS, type Settings } from "@/types/settings";

export function SettingsView() {
  const { settings, update } = useSettings();
  const { info, loaded: infoLoaded } = useAppInfo();

  // ft compatibility state, derived from /api/info. Used to gate the CLI-
  // related settings (Skip media, Fetch Media batch limit, Skip profile
  // images) — those settings only affect ft invocations the GUI can't make
  // when ft is missing or outdated. Pure-GUI settings (Theme, Autoplay,
  // Auto-open browser, Hide unfetched) stay enabled regardless.
  //
  // While AppInfo is still loading we default to "compatible" so toggles
  // render in their enabled state. FtGate prevents this view from mounting
  // during load today, so the default is defensive only.
  const ftStatus: FtClientStatus = !infoLoaded
    ? "compatible"
    : info?.ft?.status ?? "missing";
  const ftDisabled = ftStatus === "outdated" || ftStatus === "missing";

  const isAtDefault = (Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[])
    .every((k) => settings[k] === DEFAULT_SETTINGS[k]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-4 pb-8">
      <Card>
        <CardHeader>
          <CardTitle>Appearance</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-start justify-between gap-4">
            <label htmlFor="theme" className="flex min-w-0 flex-col gap-1">
              <span className="text-sm font-medium">Theme</span>
              <span className="text-muted-foreground text-xs">
                System follows your OS preference. Light and Dark override it.
              </span>
            </label>
            <Select
              value={settings.theme}
              onValueChange={(v) => update({ theme: v as Theme })}
            >
              <SelectTrigger id="theme" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="system">System</SelectItem>
                  <SelectItem value="light">Light</SelectItem>
                  <SelectItem value="dark">Dark</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Playback</CardTitle>
        </CardHeader>
        <CardContent>
          <ToggleRow
            id="autoplayVideos"
            label="Autoplay videos"
            description="Loop-play video previews on cards and gallery tiles. When off, videos show a still frame and only play in the lightbox."
            checked={settings.autoplayVideos}
            onChange={(v) => update({ autoplayVideos: v })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Server</CardTitle>
        </CardHeader>
        <CardContent>
          <ToggleRow
            id="autoOpenBrowser"
            label="Auto-open browser on start"
            description="When the local server starts, open the GUI in your default browser. Takes effect on the next server start — changing this setting while the server is running does nothing immediately."
            checked={settings.autoOpenBrowser}
            onChange={(v) => update({ autoOpenBrowser: v })}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Folders</CardTitle>
        </CardHeader>
        <CardContent>
          <ToggleRow
            id="syncFolders"
            label="Sync X folders"
            description="Adds --folders to Sync. After the main sync, ft walks each X bookmark folder and tags its members, listed under X folders in the sidebar. One extra walk per folder. Read-only: changes made on X arrive with the next Sync."
            checked={settings.syncFolders}
            onChange={(v) => update({ syncFolders: v })}
            disabled={ftDisabled}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Media</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ToggleRow
            id="skipMedia"
            label="Skip media on sync"
            description="When on, Sync and Backfill Gaps pass --no-media: only bookmarks are updated, media isn't fetched. Use Fetch Media separately to download media with a cap. Off by default — ft sync fetches media at no limit."
            checked={settings.skipMedia}
            onChange={(v) => update({ skipMedia: v })}
            disabled={ftDisabled}
          />
          <Separator />
          <NumberRow
            id="mediaFetchLimit"
            label="Fetch Media batch limit"
            description="Maximum number of bookmarks ft fetch-media will process per Fetch Media click. 0 means no limit (process all pending). Doesn't apply to Sync — ft sync has no equivalent flag and always fetches all pending media inline (or skips media entirely when Skip media is on)."
            value={settings.mediaFetchLimit}
            onChange={(v) => update({ mediaFetchLimit: v })}
            min={0}
            step={100}
            disabled={ftDisabled}
          />
          <Separator />
          <ToggleRow
            id="skipProfileImages"
            label="Skip profile images"
            description="Don't download author avatars. Adds --skip-profile-images to Sync, Fetch Media and Backfill Gaps. Saves disk and bandwidth if you don't care about author thumbnails."
            checked={settings.skipProfileImages}
            onChange={(v) => update({ skipProfileImages: v })}
            disabled={ftDisabled}
          />
          <Separator />
          <ToggleRow
            id="hideUnfetched"
            label="Hide posts with unfetched media"
            description="When on, the home, archive, and gallery hide bookmarks whose post or quoted-tweet media hasn't been downloaded yet. Useful after a large sync when you haven't run ft fetch-media. Author avatars are exempt — Skip profile images already covers that case."
            checked={settings.hideUnfetched}
            onChange={(v) => update({ hideUnfetched: v })}
          />
        </CardContent>
      </Card>

      <div className="flex items-center justify-between gap-4">
        {infoLoaded ? <FtBadge ft={info?.ft ?? null} /> : <span />}
        <Button
          variant="outline"
          disabled={isAtDefault}
          onClick={() => update(DEFAULT_SETTINGS)}
        >
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}

// Settings-footer badge reflecting ft compatibility. Four states map to
// three colors (red doubles for "outdated" and "not detected" — both
// require user action). Layout mirrors shadcn's example: a coloured dot
// span followed by the label, inside an outline Badge.
function FtBadge({ ft }: { ft: FtInfo | null }) {
  const status = ft?.status ?? "missing";
  const dotColor = {
    compatible: "bg-emerald-500",
    untested: "bg-yellow-500",
    outdated: "bg-red-500",
    missing: "bg-red-500",
  }[status];
  return (
    <Badge variant="outline">
      <span aria-hidden className={cn("size-2 rounded-full", dotColor)} />
      {status === "missing" ? (
        "ft not detected"
      ) : (
        <>
          ft <span className="tabular-nums">v{ft!.version}</span>
          {status !== "compatible" && <> {status}</>}
        </>
      )}
    </Badge>
  );
}

function ToggleRow({
  id,
  label,
  description,
  checked,
  onChange,
  disabled = false,
}: {
  id: string;
  label: ReactNode;
  description: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className={cn("flex items-start justify-between gap-4", disabled && "opacity-50")}>
      <label htmlFor={id} className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-muted-foreground text-xs">{description}</span>
      </label>
      <Switch
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}

// Local-state + commit-on-blur-or-enter keeps the server from getting hit on
// every keystroke, and lets the user type intermediate invalid values (empty,
// partial numbers) without snapping back. +/- buttons step by `step` and
// short-circuit the commit logic for instant feedback.
function NumberRow({
  id,
  label,
  description,
  value,
  onChange,
  min,
  max,
  step = 1,
  disabled = false,
}: {
  id: string;
  label: ReactNode;
  description: ReactNode;
  value: number;
  onChange: (next: number) => void;
  min: number;
  // Optional: when omitted there's no upper bound (the + button never disables
  // and the input accepts arbitrarily large values). Server-side sanity-checks
  // for finite + positive, so the worst case is a long-running but cancellable
  // operation, not a crash.
  max?: number;
  step?: number;
  disabled?: boolean;
}) {
  const [local, setLocal] = useState(String(value));

  // Sync local state when the committed value changes externally (e.g. server
  // round-trip clamped our value, or another tab wrote).
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- external-value sync
    setLocal(String(value));
  }, [value]);

  const clamp = (n: number) => {
    const lo = Math.max(min, n);
    return max != null ? Math.min(max, lo) : lo;
  };

  const commit = () => {
    const parsed = parseInt(local, 10);
    if (!Number.isFinite(parsed)) {
      setLocal(String(value));
      return;
    }
    const clamped = clamp(parsed);
    setLocal(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  // Snap to the next step-grid stop in the given direction rather than
  // adding/subtracting a flat step. Fixes "100 → − → 1 → + → 101" drift:
  // after clamping to min (1), +step from 1 would land off-grid at 101.
  // Grid-snap rounds 1 + 1 up to the next multiple of 100 → 100, which is
  // what the user expects.
  const stepBy = (direction: 1 | -1) => {
    const parsed = parseInt(local, 10);
    const base = Number.isFinite(parsed) ? clamp(parsed) : value;
    const next =
      direction === 1
        ? clamp(Math.ceil((base + 1) / step) * step)
        : clamp(Math.floor((base - 1) / step) * step);
    setLocal(String(next));
    if (next !== value) onChange(next);
  };

  return (
    <div className={cn("flex items-start justify-between gap-4", disabled && "opacity-50")}>
      <label htmlFor={id} className="flex min-w-0 flex-col gap-1">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-muted-foreground text-xs">{description}</span>
      </label>
      <ButtonGroup>
        <Input
          id={id}
          // `type="text" + inputMode="numeric"` keeps the numeric mobile
          // keyboard but drops the native up/down spinner arrows (which would
          // duplicate the +/- buttons). min/max/step on a text input are
          // ignored by HTML — our commit/clamp logic enforces the range.
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          value={local}
          onChange={(e) => setLocal(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
              (e.currentTarget as HTMLInputElement).blur();
            }
          }}
          disabled={disabled}
          className="w-16 text-center font-mono tabular-nums"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Decrement by ${step}`}
          disabled={disabled || value <= min}
          onClick={() => stepBy(-1)}
        >
          <RiSubtractLine />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={`Increment by ${step}`}
          disabled={disabled || (max != null && value >= max)}
          onClick={() => stepBy(1)}
        >
          <RiAddLine />
        </Button>
      </ButtonGroup>
    </div>
  );
}
