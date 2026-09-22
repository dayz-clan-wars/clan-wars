import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { awardsCatalogue } from "@factions/domain/awards";
import { AwardFlow } from "../app/(site)/awards/[id]/award-flow";
import type { AwardPageView } from "@/lib/award-view";

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
});
