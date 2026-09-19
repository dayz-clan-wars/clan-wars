import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Session } from "@/lib/auth/session";
import type { Owner } from "../app/components/owner";
import { OwnerPanels } from "../app/components/owner";

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
});

const render = (owner: Owner) => renderToStaticMarkup(createElement(OwnerPanels, { owner }));

/**
 * ⚠️ The entry point must be gated on BOOSTING, not merely on owning the page.
 * /kit turns a non-booster away, and a link that leads somewhere that refuses
 * you is worse than no link. Rendered directly through OwnerPanels (a pure
 * function of an Owner object) rather than asserted against source text —
 * OwnerPanels needs no session or database of its own, only the loader that
 * feeds it does, so the real render is practical here.
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
