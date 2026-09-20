import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { KIT_SLOTS, type CatalogueEntry, type KitSlot } from "@factions/domain";
import { boosterCatalogue } from "@factions/domain/catalogue";
import { SLOT_LABELS } from "../lib/kit-copy";
import { KitFlow } from "../app/(site)/kit/kit-flow";
import { PickSheet } from "../app/(site)/kit/pick-sheet";
import { SequenceCard } from "../app/(site)/kit/sequence-card";
import type { KitChallengeView, KitView } from "../lib/kit-view";

const MASKS: CatalogueEntry[] = [
  { className: "BalaclavaMask_Black", label: "Ski Mask (Black)", image: "items/BalaclavaMask_Black.webp" },
  { className: "BalaclavaMask_Green", label: "Ski Mask (Green)", image: "items/BalaclavaMask_Green.webp" },
  { className: "HockeyMask", label: "Hockey Mask", image: "items/HockeyMask.webp" },
  { className: "NoArt", label: "Unpictured Mask" },
];

const sheet = (current: string | null, query = "") =>
  renderToStaticMarkup(
    <PickSheet slot="mask" options={MASKS} current={current} query={query}
      onQuery={() => {}} onChoose={() => {}} onClose={() => {}} />,
  );

describe("the pick sheet", () => {
  it("renders one button per option, plus the one that empties the slot", () => {
    const html = sheet(null);
    for (const o of MASKS) expect(html).toContain(o.label.replace(/.*\((.*)\)/u, "$1"));
    expect(html).toContain("Nothing");
    expect(html).toContain("Leave this slot empty");
  });

  /**
   * ⚠️ "Ski Mask (Black)" and "Ski Mask (Green)" are one family and read as
   * the colour alone under its heading. Without this the sheet is two hundred
   * tiles each repeating the same three words, on a 390px screen.
   */
  it("groups a family under its name and labels each tile by what differs", () => {
    const html = sheet(null);
    expect(html).toContain("Ski Mask");
    expect(html).toContain(">Black<");
    expect(html).toContain(">Green<");
  });

  /**
   * ⚠️ A family of one would otherwise be a heading with a single tile under
   * it, repeated for every one-off in the slot.
   */
  it("collects families of one into a single group, labelled in full", () => {
    const html = sheet(null);
    expect(html).toContain("One of a kind");
    expect(html).toContain("Hockey Mask");
    expect(html).toContain("Unpictured Mask");
  });

  /** ⚠️ Coverage gaps are expected and must look deliberate, not broken. */
  it("renders an option with no picture as a labelled tile, still pickable", () => {
    expect(sheet(null)).toContain("No art");
  });

  it("marks the current pick pressed, and nothing else", () => {
    const html = sheet("HockeyMask");
    const buttons = html.match(/<button[^>]*>/gu) ?? [];
    expect(buttons.filter((b) => b.includes('aria-pressed="true"'))).toHaveLength(1);
    // With a pick made, "Nothing" is not the pressed one.
    expect(html).toContain('aria-pressed="false"');
  });

  it("marks the empty option pressed when the slot is empty", () => {
    const html = sheet(null);
    const nothing = html.match(/<button[^>]*>(?=[\s\S]{0,400}Leave this slot empty)/u)?.[0] ?? "";
    expect(nothing).toContain('aria-pressed="true"');
  });

  it("filters on the search text, and says so when nothing is left", () => {
    expect(sheet(null, "hockey")).toContain("Hockey Mask");
    expect(sheet(null, "hockey")).not.toContain("Unpictured Mask");
    expect(sheet(null, "zzzz")).toContain("Nothing matches that.");
  });

  /**
   * ⚠️ A dialog, labelled by the slot it is picking for. It covers the whole
   * screen on a phone, so a screen reader that treated it as part of the page
   * behind it would read nine tiles the user cannot reach.
   */
  it("is a labelled modal dialog", () => {
    const html = sheet(null);
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-labelledby="sheet-title"');
    expect(html).toContain('id="sheet-title"');
  });
});

const challenge = (confirmed: number): KitChallengeView => ({
  id: 7,
  confirmed,
  steps: [
    { token: "salute", label: "salute", confirmed: confirmed > 0 },
    { token: "facepalm", label: "facepalm", confirmed: confirmed > 1 },
    { token: "taunt_elbow", label: "taunt elbow", confirmed: confirmed > 2 },
  ],
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
});

const card = (confirmed: number) =>
  renderToStaticMarkup(<SequenceCard challenge={challenge(confirmed)} busy={false} onDraw={() => {}} onCancel={() => {}} />);

describe("the sequence card", () => {
  /** ⚠️ An ordered list, because the order IS the proof. */
  it("renders the steps in order, as an ordered list", () => {
    const html = card(0);
    expect(html).toContain("<ol");
    expect(html.indexOf("salute")).toBeLessThan(html.indexOf("facepalm"));
    expect(html.indexOf("facepalm")).toBeLessThan(html.indexOf("taunt elbow"));
  });

  it("marks a confirmed step and leaves the rest waiting", () => {
    const html = card(1);
    expect(html.match(/Confirmed/gu) ?? []).toHaveLength(1);
    expect(html.match(/Waiting/gu) ?? []).toHaveLength(2);
    expect(html).toContain("line-through");
  });

  /**
   * ⚠️ The count is the SERVER's, said in as many words, because a
   * confirmation arrives minutes after the emote and a player standing in a
   * field needs to know which of the two is behind.
   */
  it("says how many the server has confirmed, out of how many there are", () => {
    expect(card(2)).toContain("The server has confirmed 2 of 3.");
    expect(card(0)).toContain("The server has confirmed 0 of 3.");
  });

  /**
   * ⚠️ A SIBLING of the list, never an attribute on it: aria-live on the <ol>
   * strips list semantics in several screen readers.
   */
  it("announces the count outside the list, not on it", () => {
    const html = card(1);
    expect(html).toMatch(/<p[^>]*aria-live="polite"[^>]*>1 of 3 confirmed<\/p>/u);
    expect(html.match(/<ol[^>]*>/u)?.[0]).not.toContain("aria-live");
  });

  it("offers a redraw and a cancel", () => {
    const html = card(0);
    expect(html).toContain("New sequence");
    expect(html).toContain("Cancel");
  });
});

const EMPTY_SLOTS = Object.fromEntries(KIT_SLOTS.map((s) => [s, null])) as Record<KitSlot, string | null>;

const flow = (over: Partial<KitView> = {}, withCatalogue = true) => {
  const view: KitView = { boosting: true, gamertag: "Wintershadow394", slots: EMPTY_SLOTS, spot: null, challenge: null, ...over };
  return renderToStaticMarkup(<KitFlow initial={view} catalogue={withCatalogue ? boosterCatalogue() : null} />);
};

describe("the kit page, rendered", () => {
  it("gives a booster with a linked character all nine tiles", () => {
    const html = flow();
    for (const slot of KIT_SLOTS) expect([slot, html.includes(SLOT_LABELS[slot])]).toEqual([slot, true]);
    expect(html.match(/>Empty</gu) ?? []).toHaveLength(KIT_SLOTS.length);
    expect(html).toContain('>0<span class="text-dim">/9</span>');
  });

  it("shows a filled slot by its picture and its name, and counts it", () => {
    const html = flow({ slots: { ...EMPTY_SLOTS, jacket: "GorkaEJacket_Summer" } });
    expect(html).toContain("items/GorkaEJacket_Summer.webp");
    expect(html).toContain("Patrol Jacket (Summer)");
    expect(html).toContain('>1<span class="text-dim">/9</span>');
  });

  /**
   * ⚠️ Someone deciding whether to boost has to be able to see what they
   * would get. This state gets no catalogue at all: 200 entries would ride
   * the payload of a page that is three pictures and a link to Discord.
   */
  it("sells the perk to a visitor who is not boosting, with no picker and no catalogue", () => {
    const html = flow({ boosting: false, gamertag: null }, false);
    expect(html).toContain("Boost on Discord");
    expect(html).toContain("discord.gg");
    expect(html).not.toContain("Your kit</h1>");
    expect(html).toContain("How this works");
  });

  it("sends a booster with no linked character to the link flow", () => {
    const html = flow({ gamertag: null }, false);
    expect(html).toContain("Link your character");
    expect(html).toContain('href="/link"');
    expect(html).toContain("How this works");
  });

  /** The three strip states: no spot, a spot, and a sequence waiting on emotes. */
  it("says the kit has nowhere to spawn until a spot is marked", () => {
    const html = flow();
    expect(html).toContain("No spot yet");
    expect(html).toContain("Mark it");
  });

  it("names the grid square and the nearest place once a spot is marked", () => {
    const html = flow({ spot: { grid: "074 052", near: "Topolin", href: "/map?at=074052" } });
    expect(html).toContain("Grid 074 052");
    expect(html).toContain("Near Topolin.");
    expect(html).toContain('href="/map?at=074052"');
    expect(html).toContain("Move");
  });

  it("switches the strip to the sequence while one is open, and shows the card", () => {
    const html = flow({ challenge: challenge(1) });
    expect(html).toContain("Waiting for your emotes");
    expect(html).toContain("1 of 3 confirmed.");
    expect(html).toContain("Redraw");
    expect(html).toContain("Sequence open");
  });

  /**
   * ⚠️ A spot already marked does not go away while a new sequence is open.
   * The strip reports the sequence because that is what the player owes, but
   * drawing a new one leaves the old spot spawning until the new one lands.
   */
  it("reports the open sequence even when a spot is already marked", () => {
    const html = flow({ spot: { grid: "074 052", near: "Topolin", href: "/map?at=074052" }, challenge: challenge(0) });
    expect(html).toContain("Waiting for your emotes");
    expect(html).not.toContain("Grid 074 052");
  });
});
