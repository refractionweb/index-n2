// Boot-gate empty state shown by `FtGate` (App.tsx) when /api/info reports
// that fieldtheory-cli isn't on PATH. Replaces the entire UI — no sidebar,
// no top bar — because nothing in the rest of the app works without ft.

import {
  RiCheckLine,
  RiErrorWarningLine,
  RiFileCopyLine,
} from "@remixicon/react";
import { Button } from "@/components/ui/button";
import { useCopyFeedback } from "@/lib/clipboard";

const INSTALL_CMD = "npm install -g fieldtheory";

export function FtNotInstalled() {
  const { state, copy } = useCopyFeedback(1500);

  return (
    <div className="flex h-svh items-center justify-center p-8">
      <div className="flex max-w-md flex-col gap-3 text-sm">
        <h1 className="text-base font-semibold">fieldtheory-cli not found</h1>
        <p className="text-muted-foreground">
          index-n2 is a viewer for fieldtheory-cli's bookmark database.
          Install fieldtheory-cli first, then reload this page.
        </p>
        <div className="bg-muted flex items-center gap-2 rounded-lg py-1 pl-3 pr-1 font-mono text-xs">
          <code className="flex-1">{INSTALL_CMD}</code>
          <Button
            variant="outline"
            size="icon-sm"
            onClick={() => void copy(INSTALL_CMD)}
            aria-label={
              state === "copied"
                ? "Copied"
                : state === "failed"
                  ? "Copy failed"
                  : "Copy install command"
            }
          >
            {state === "copied" ? (
              <RiCheckLine />
            ) : state === "failed" ? (
              <RiErrorWarningLine />
            ) : (
              <RiFileCopyLine />
            )}
          </Button>
        </div>
        <a
          href="https://github.com/afar1/fieldtheory-cli"
          target="_blank"
          rel="noopener noreferrer"
          className="text-foreground hover:underline"
        >
          github.com/afar1/fieldtheory-cli
        </a>
      </div>
    </div>
  );
}
