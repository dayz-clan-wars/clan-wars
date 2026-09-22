import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@/lib/auth/session";
import type { Owner } from "../app/components/owner";
import { OwnerPanels, BoosterKitPanel, AwardsPanel } from "../app/components/owner";

const SESSION: Session = { sub: "1", name: "Test", avatar: null, guild: true, nextCheckAt: 0, authAt: 0 };

const baseOwner = (boosting: boolean): Owner => ({
  session: SESSION,
  viewer: { link: null, clan: null, pending: null },
  invites: [],
  requests: [],
  claim: null,
  next: null,
  showInvites: false,
  boosting,
  openAwards: 0,
});

const render = (owner: Owner) => renderToStaticMarkup(createElement(BoosterKitPanel, { owner }));

/**
 * ⚠️ The panel is its OWN component, not part of OwnerPanels, so the player
 * page can place it directly under "Your account". Rendering OwnerPanels here
 * would assert nothing about the kit, and would pass whether or not the panel
 * exists at all.
 */
const renderOwnerPanels = (owner: Owner) => renderToStaticMarkup(createElement(OwnerPanels, { owner }));

/**
 * ⚠️ The entry point must be gated on BOOSTING, not merely on owning the page.
 * /kit turns a non-booster away, and a link that leads somewhere that refuses
 * you is worse than no link. Rendered directly through BoosterKitPanel (a pure
 * function of an Owner object) rather than asserted against source text: it
 * needs no session or database of its own, only the loader that feeds it does,
 * so the real render is practical here.
 */
describe("the kit entry point", () => {
  it("renders for a boosting owner, and links to /kit", () => {
    const html = render(baseOwner(true));
    expect(html).toContain('href="/kit"');
    expect(html).toContain("Booster kit");
  });

  it("renders nothing kit-related for a non-boosting owner", () => {
    const html = render(baseOwner(false));
    expect(html).not.toContain('href="/kit"');
    expect(html).not.toContain("Booster kit");
  });

  /**
   * ⚠️ Pins the move. The panel used to live in OwnerPanels, which renders in
   * the page's RIGHT column below invites and ceremonies, and that buried the
   * one control a booster opens the page for. If it drifts back, the panel
   * silently returns to the wrong column and nothing else notices.
   */
  it("is not inside OwnerPanels, which renders in the other column", () => {
    const html = renderOwnerPanels(baseOwner(true));
    expect(html).not.toContain('href="/kit"');
  });

  /**
   * ⚠️ A source check, deliberately, and the only one in this file. The render
   * tests above cover the gate, but nothing reaches loadOwner: `boosting: false`
   * or `boosting: !kit.boosting` would both typecheck and leave every test
   * green while the feature is silently off or inverted. apps/web tests have no
   * database and no mocking precedent, so this asserts the wiring line itself.
   */
  it("loadOwner reads boosting from the roster rather than a constant", () => {
    const src = readFileSync(join(import.meta.dirname, "..", "app", "components", "owner.tsx"), "utf8");
    expect(src).toContain("boosterKit(session.sub)");
    expect(src).toContain("boosting: kit.boosting");
  });
});

describe("AwardsPanel", () => {
  const renderAwards = (openAwards: number) =>
    renderToStaticMarkup(createElement(AwardsPanel, { owner: { ...baseOwner(false), openAwards } }));
  it("renders nothing with no open awards", () => expect(renderAwards(0)).toBe(""));
  it("links to /awards when the owner holds one", () => expect(renderAwards(1)).toContain('href="/awards"'));
});
