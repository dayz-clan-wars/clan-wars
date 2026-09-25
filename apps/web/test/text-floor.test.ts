import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const WEB = join(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(join(WEB, rel), "utf8");

/**
 * The shell and public pages this plan owns (2026-09-24 review). The FORMS
 * and MAP plans own the rest of app/, so this list is explicit rather than a
 * directory scan that would fail on their files.
 */
const OWNED = [
  "app/components/ui.tsx", "app/components/timer-bar.tsx", "app/components/notice-row.tsx",
  "app/components/notifications-bell.tsx", "app/components/server-strip.tsx", "app/components/install-strip.tsx",
  "app/components/stat-boards.tsx", "app/components/player-feed.tsx", "app/components/achievement-wall.tsx",
  "app/components/owner.tsx", "app/components/hero-map.tsx", "app/(site)/site-bar.tsx", "app/(site)/menu-list.tsx",
  "app/(site)/page.tsx", "app/(site)/clans/page.tsx", "app/(site)/clans/[tag]/page.tsx", "app/(site)/scoreboard/page.tsx",
  "app/(site)/alphas/page.tsx", "app/(site)/seasons/page.tsx", "app/(site)/war-log/page.tsx", "app/(site)/war-log/entry.tsx",
  "app/(site)/awards/page.tsx", "app/(site)/awards/[id]/award-flow.tsx", "app/(site)/players/page.tsx",
  "app/(site)/players/[gamertag]/page.tsx", "app/guide/layout.tsx", "app/guide/chapter.tsx", "app/guide/search.tsx",
  "app/not-found.tsx",
  // The FORMS plan's file, added once it merged (2026-09-24 review, F7): the
  // group name, item count and "No art" fallback are real info, not filler.
  "app/(site)/kit/pick-sheet.tsx",
];

describe("the 11px floor (M7)", () => {
  it.each(OWNED)("%s sets no meaningful text below 11px", (rel) => {
    expect(read(rel)).not.toMatch(/\btext-\[(?:[0-9]|10)px\]/u);
  });

  it("guide.css sets no font-size below 11px", () => {
    const sizes = [...read("app/guide/guide.css").matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/gu)].map((m) => Number(m[1]));
    expect(sizes.filter((n) => n < 11)).toEqual([]);
  });
});

describe("panel edges are not text colours (H4)", () => {
  it.each(OWNED)("%s never uses rule or rule-2 as a text colour", (rel) => {
    // rule is 1.2:1 and rule-2 1.34:1 on the frame. rule-3 (3.2:1) stays allowed for aria-hidden glyphs.
    expect(read(rel)).not.toMatch(/\btext-rule(?:-2)?(?![-\w])/u);
  });

  it("the season numeral on /alphas also exists as real text", () => {
    expect(read("app/(site)/alphas/page.tsx")).toMatch(/<span className="sr-only">Season \{s\.number\}<\/span>/u);
  });
});

describe("rust is never text (H3)", () => {
  it("⚠️ guide.css colours no text with --color-rust — that is 2.6:1; rust-2 is rust as text", () => {
    expect(read("app/guide/guide.css")).not.toMatch(/(?<!-)color:\s*var\(--color-rust\)/u);
    expect(read("app/guide/guide.css")).toMatch(/\.human::before\s*\{[^}]*color:\s*var\(--color-rust-2\)/u);
  });
});
