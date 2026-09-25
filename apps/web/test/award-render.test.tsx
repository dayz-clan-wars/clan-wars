import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { awardsCatalogue } from "@factions/domain/awards";
import { AwardFlow } from "../app/(site)/awards/[id]/award-flow";
import type { AwardPageView } from "@/lib/award-view";
import { when } from "@/lib/format";

const def = awardsCatalogue()["plate-carrier"]!;
const view = (over: Partial<AwardPageView> = {}): AwardPageView => ({
  id: 12, label: "Plate Carrier", reason: "Winner, Sept KOTH", state: "unplaced",
  placeBy: "2026-09-29T12:00:00.000Z", liveFrom: null, expiresAt: null, nextRestartAt: "2026-09-22T14:00:00.000Z",
  gamertag: "Ron", picks: {}, spot: null, challenge: null, ...over,
});
const render = (v: AwardPageView) => renderToStaticMarkup(createElement(AwardFlow, { initial: v, def }));

describe("the award page", () => {
  it("shows one tile per slot, and holds Place until every slot is picked", () => {
    const html = render(view());
    for (const s of Object.values(def.slots)) expect(html).toContain(s.label);
    expect(html).toMatch(/<button[^>]*\sdisabled=""[^>]*>[^<]*Place in game/u);
  });

  it("enables Place once every slot is picked", () => {
    const html = render(view({ picks: { vest: "PlateCarrierVest_Black", pouches: "PlateCarrierPouches_Black", holster: "PlateCarrierHolster_Black" } }));
    expect(html).not.toMatch(/<button[^>]*\sdisabled=""[^>]*>[^<]*Place in game/u);
  });

  it("sends an unlinked winner to /link", () => {
    expect(render(view({ gamertag: null }))).toContain('href="/link"');
  });

  it("says when a live award ends", () => {
    expect(render(view({ state: "live", expiresAt: "2026-09-29T14:00:00.000Z", spot: { grid: "071-057", near: "Topolin", href: "/map?at=x" } })))
      .toMatch(/Live until/u);
  });

  it("is read-only once ended, and says why", () => {
    const html = render(view({ state: "lapsed" }));
    expect(html).toMatch(/not placed in time/iu);
    expect(html).not.toContain("Place in game");
  });

  /**
   * ⚠️ The page is a client component that is also server-rendered. A
   * `toLocaleString(undefined, …)` in it rendered the server's zone on the
   * first paint and the viewer's on hydration, and swapped the text.
   */
  it("⚠️ says the same time whatever zone renders it", () => {
    const was = process.env.TZ;
    try {
      process.env.TZ = "Pacific/Auckland";
      const a = render(view());
      process.env.TZ = "America/Los_Angeles";
      const b = render(view());
      expect(a).toBe(b);
      expect(a).toContain(when(new Date("2026-09-29T12:00:00.000Z")));
    } finally {
      if (was === undefined) delete process.env.TZ; else process.env.TZ = was;
    }
  });

  it("has the site's page head and a way back to the awards list (M12)", () => {
    const html = render(view());
    expect(html).toMatch(/<h1[^>]*>Plate Carrier<\/h1>/u);
    expect(html).toContain("border-b-2 border-rule-2 px-5 pb-5 pt-6"); // PageHead's own frame
    expect(html).toMatch(/<a class="[^"]*" href="\/awards">← Your awards<\/a>/u);
  });

  it("⚠️ draws an empty slot's edge at control contrast (rule-3), not panel contrast", () => {
    const html = render(view());
    expect(html).toContain("border-dashed border-rule-3");
    expect(html).not.toContain("border-dashed border-rule-2");
  });
});
