import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { Session } from "@/lib/auth/session";
import type { Owner } from "../app/components/owner";
import { AccountPanel, AwardsPanel, BoosterKitPanel } from "../app/components/owner";
import NotFound from "../app/not-found";

const SESSION: Session = { sub: "1", name: "Test", avatar: null, guild: true, nextCheckAt: 0, authAt: 0 };
const owner = (o: Partial<Owner> = {}): Owner => ({
  session: SESSION, viewer: { link: null, clan: null, pending: null }, invites: [], requests: [], claim: null,
  next: null, showInvites: false, boosting: true, openAwards: 1, ...o,
});

describe("the install strip's close (M8)", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "app", "components", "install-strip.tsx"), "utf8");
  it("⚠️ is 44px wide as well as tall, with the glyph hidden and the name said", () => {
    expect(src).toMatch(/onClick=\{dismiss\}[^>]*min-h-\[44px\][^>]*min-w-\[44px\][^>]*justify-center[^>]*aria-label="Not now"/u);
    expect(src).toContain('<span aria-hidden="true">✕</span>');
  });
});

describe("the bell panel's Mark all read (live: 113×17px on 2026-09-24)", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "app", "components", "notifications-bell.tsx"), "utf8");
  it("⚠️ is a 44px target — the FORMS plan fixed the page's copy of this control, the panel's is owned here", () => {
    expect(src).toMatch(/<button type="submit" className="[^"]*min-h-\[44px\][^"]*"[^>]*>Mark all read</u);
  });
});

describe("the root 404 (L5)", () => {
  const html = renderToStaticMarkup(createElement(NotFound));
  it("both links are 44px touch targets", () => {
    const links = [...html.matchAll(/<a [^>]*>/gu)].map((m) => m[0]);
    expect(links).toHaveLength(2);
    for (const a of links) expect(a).toContain("min-h-[44px]");
  });
});

describe("the owner's panels (L6)", () => {
  it("puts air between a panel's sentence and its button", () => {
    expect(renderToStaticMarkup(createElement(BoosterKitPanel, { owner: owner() }))).toMatch(/<a href="\/kit" class="mt-3 /u);
    expect(renderToStaticMarkup(createElement(AwardsPanel, { owner: owner() }))).toMatch(/<a href="\/awards" class="mt-3 /u);
  });

  it("⚠️ stacks the three account links on a phone instead of wrapping each onto three lines", () => {
    const html = renderToStaticMarkup(createElement(AccountPanel, { owner: owner() }));
    expect(html).toContain("grid grid-cols-1 border-t border-rule-2 sm:grid-cols-3");
  });
});
