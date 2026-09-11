"use client";
import { useState } from "react";
import { SERVER_STRIP, type ServerStripItem } from "@/lib/server-strip";

/**
 * The server-name strip directly under the top bar, in the bar's own frame:
 * `SERVER` in mono caps, the in-game name in gold, the map, and how long
 * ago the worker last confirmed the name with Nitrado. One row per live
 * server. Static on purpose — a marquee cannot be read at a glance or
 * selected, and this name exists to be copied into the DayZ browser's
 * search, which is what the button does.
 *
 * Rendered from server data (lib/server-strip.ts makes the words); this is
 * a client component only for the copy button. Nothing to show renders
 * nothing: a fresh install with no swept server has no strip, not an empty
 * one.
 */
export function ServerStrip({ servers }: { servers: ServerStripItem[] }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (servers.length === 0) return null;

  const copy = async (name: string) => {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(name);
      setTimeout(() => setCopied((c) => (c === name ? null : c)), 2000);
    } catch { /* the name is still selectable text */ }
  };

  return (
    <div role="region" aria-label={SERVER_STRIP.label} className="border-b-2 border-rule-2 bg-frame">
      {servers.map((s) => (
        <div key={s.hostname} className="flex min-h-[40px] items-center gap-3 px-4 py-1.5 lg:px-8">
          <span className="flex-none font-mono text-[11px] uppercase tracking-[0.18em] text-muted">{SERVER_STRIP.label}</span>
          {/* Wraps rather than truncates: a name cut short is one a player cannot find in the browser. */}
          <span className="min-w-0 flex-1 break-words text-[13px] leading-snug">
            <span className="font-display uppercase tracking-[0.02em] text-gold">{s.hostname}</span>
            <span className="text-muted"> · {s.map}</span>
            <span className="hidden text-muted lg:inline"> · {s.seen}</span>
          </span>
          <button
            type="button"
            onClick={() => void copy(s.hostname)}
            aria-label={`${SERVER_STRIP.copy}: ${s.hostname}`}
            className="flex min-h-[32px] flex-none items-center border border-rule-3 px-2.5 font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:border-ink hover:text-ink"
          >
            {copied === s.hostname ? SERVER_STRIP.copied : <><span className="lg:hidden">{SERVER_STRIP.copyShort}</span><span className="hidden lg:inline">{SERVER_STRIP.copy}</span></>}
          </button>
        </div>
      ))}
    </div>
  );
}
