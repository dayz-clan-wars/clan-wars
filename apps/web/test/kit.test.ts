import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { KIT_SLOTS } from "@factions/domain";
import { boosterCatalogue } from "@factions/domain/catalogue";
import { GROUND_RULES, KIT_GRID_ORDER, RESULT_COPY, SLOT_LABELS } from "../lib/kit-copy";

/**
 * The booster kit page. Its writes are tested where the database is
 * (`packages/roster/test/booster-kit.test.ts`) — `apps/web` imports no
 * database package and has no test database of its own (test/smoke.test.ts).
 * What is pinned here is what this app owns: the copy, the four states the
 * page must render, and the gate on every write behind it.
 */
const read = (...parts: string[]) => readFileSync(join(import.meta.dirname, "..", ...parts), "utf8");

const PAGE = read("app", "(site)", "kit", "page.tsx");
const FLOW = read("app", "(site)", "kit", "kit-flow.tsx");
const SHEET = read("app", "(site)", "kit", "pick-sheet.tsx");
const CARD = read("app", "(site)", "kit", "sequence-card.tsx");
const COPY = read("lib", "kit-copy.ts");
const VIEW = read("lib", "kit-view.ts");
const GUARD = read("app", "api", "kit", "guard.ts");
const ROUTES = {
  status: read("app", "api", "kit", "status", "route.ts"),
  slot: read("app", "api", "kit", "slot", "route.ts"),
  draw: read("app", "api", "kit", "draw", "route.ts"),
  cancel: read("app", "api", "kit", "cancel", "route.ts"),
};

/**
 * A source file with its comments dropped.
 *
 * ⚠️ For assertions that COUNT something. This file's comments quote the code
 * they explain, so a grep over the raw text finds a `role="status"` written
 * to explain why there is only one of them, and the count is off by the
 * number of times the rule was documented.
 */
const code = (text: string): string =>
  text
    // Block comments, including the `{/* ... */}` form JSX uses. Spanning
    // lines, so a filter over line starts does not see the body of one.
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n").filter((l) => !/^\s*\/\//u.test(l)).join("\n");

/** Every file a player's words can come out of. */
const SOURCES = { "page.tsx": PAGE, "kit-flow.tsx": FLOW, "pick-sheet.tsx": SHEET, "sequence-card.tsx": CARD, "kit-copy.ts": COPY, "kit-view.ts": VIEW } as const;
/** Every string a player reads on this page, in one list. */
const PLAYER_COPY = [...Object.values(RESULT_COPY), ...GROUND_RULES, ...Object.values(SLOT_LABELS)];

describe("the kit page's copy", () => {
  it("names all nine slots, and nothing else", () => {
    expect(Object.keys(SLOT_LABELS).sort()).toEqual([...KIT_SLOTS].sort());
  });

  /**
   * ⚠️ The grid's reading order is its own list because KIT_SLOTS is the
   * WRITE order: the columns on `booster_kits` and the loop every catalogue
   * check runs. Reordering that to suit a 3x3 would reorder them all. Pinned
   * as a permutation so a slot cannot fall off the page by being dropped here.
   */
  it("lays out every slot exactly once, without reordering the write layer", () => {
    expect([...KIT_GRID_ORDER].sort()).toEqual([...KIT_SLOTS].sort());
    expect(KIT_GRID_ORDER).toHaveLength(KIT_SLOTS.length);
    expect([...KIT_GRID_ORDER]).not.toEqual([...KIT_SLOTS]);
  });

  it("uses no em dash anywhere the player can read", () => {
    // ⚠️ The house comment style uses em dashes freely; this page does not,
    // in copy OR in comments, because the two are one keystroke apart in a
    // JSX file and a dash that leaks into copy is invisible in review.
    //
    // ⚠️ The ONE exception is `metadata.title`, by ruling: a <title> is chrome,
    // and every other page on the site uses "Clan Wars — <thing>". Stripped by
    // line, so the exemption cannot widen.
    for (const [name, text] of Object.entries(SOURCES)) {
      const body = text.split("\n").filter((l) => !l.trim().startsWith("title:")).join("\n");
      expect([name, body.includes("—")]).toEqual([name, false]);
    }
  });

  it("keeps the site's title format", () => {
    expect(PAGE).toContain('title: "Clan Wars — your booster kit"');
  });

  /**
   * ⚠️ The emote count is LINK_EMOTES, a guide number in rules.ts. The card
   * renders it from the sequence it was handed; this copy must not restate it.
   * A "three" typed here would go on saying three after the constant changed,
   * and nothing would fail: guide.test.ts scans guide chapters, not lib/.
   */
  it("states no emote count in copy, so LINK_EMOTES cannot drift out of it", () => {
    const counted = /\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+emotes?\b/iu;
    expect(Object.entries(RESULT_COPY).filter(([, c]) => counted.test(c))).toEqual([]);
    // And the card renders the count it was handed, never a literal.
    expect(CARD).toContain("perform these {total} emotes");
    expect(CARD).not.toMatch(counted);
  });

  /**
   * ⚠️ BOOSTER_TICK_INTERVAL_MS defaults to 15 minutes (apps/bot/src/config.ts)
   * and is an env var an operator can change, so the sentence carries no figure
   * at all rather than one that can drift out of it. The page is never locked
   * either: only the pickers appear.
   */
  it("promises no delay figure for the boost, and never says the page is locked", () => {
    expect(FLOW).not.toMatch(/within a few minutes|a few minutes of|\d+ minutes/u);
    expect(FLOW.toLowerCase()).not.toContain("unlock");
    expect(FLOW).toContain("the pickers appear on this page then");
  });

  it("says plainly that the kit is on the ground, takeable, and back at the restart", () => {
    const all = GROUND_RULES.join(" ").toLowerCase();
    expect(all).toContain("on the ground");
    expect(all).toContain("anyone who finds it can take it");
    expect(all).toContain("next restart");
  });

  /**
   * ⚠️ The three rules are what a player weighs when they choose a spot, so
   * they must be on the page in EVERY state, including the one a visitor
   * deciding whether to boost sees. The design puts them behind a "How this
   * works" disclosure; this pins that all three states open one.
   */
  it("offers the ground rules in all three states, not only to a picker", () => {
    expect(FLOW.match(/<HowThisWorks\b/gu) ?? []).toHaveLength(3);
    expect(FLOW).toContain("GROUND_RULES.map");
  });

  it("never frames the kit as protected, and never talks a player out of raiding", () => {
    // The guide's standing rule: nothing on the site may discourage a raid.
    const banned = ["protected", "safe from", "exclusive", "nobody else can", "do not raid", "don't raid", "off limits"];
    for (const phrase of banned) {
      expect([phrase, PLAYER_COPY.some((c) => c.toLowerCase().includes(phrase))]).toEqual([phrase, false]);
    }
  });

  it("has a sentence for every reason the kit routes can refuse with", () => {
    const reasons = Object.values(ROUTES).flatMap((text) => [...text.matchAll(/reason: "([a-z-]+)"/gu)].map((m) => m[1]!));
    expect(reasons.length).toBeGreaterThan(0);
    for (const reason of [...reasons, ...["bad-slot", "bad-pick"]]) {
      expect([reason, Object.hasOwn(RESULT_COPY, reason)]).toEqual([reason, true]);
    }
  });

  /**
   * ⚠️ A reason arrives in a JSON body now rather than in `?result=`, which
   * changes nothing: it is still a value off the wire reaching a property
   * access, and a bare `RESULT_COPY[reason]` would still answer for
   * `__proto__`. lib/copy-lookup.ts is what makes that miss.
   */
  it("looks a refusal up rather than indexing the table with it", () => {
    expect(FLOW).toContain("lookupCopy(RESULT_COPY,");
    expect(FLOW).not.toMatch(/RESULT_COPY\[[^\]]*reason/u);
  });
});

describe("the kit page's states", () => {
  it("renders the perk for a visitor who is not boosting, rather than gating the page", () => {
    // ⚠️ Someone deciding whether to boost has to be able to see what they
    // would get. An early return on `!view.boosting` would hide exactly that.
    expect(FLOW).toContain("{!view.boosting && <NotBoosting />}");
    expect(FLOW).not.toMatch(/if\s*\(\s*!view\.boosting\s*\)\s*return/u);
  });

  it("points a boosting visitor with no link at the link flow", () => {
    expect(FLOW).toContain("view.gamertag === null && <NotLinked />");
    expect(FLOW).toContain('href="/link"');
  });

  it("gives a boosting, linked visitor the nine tiles and the sequence card", () => {
    expect(FLOW).toContain("KIT_GRID_ORDER.map((slot) =>");
    expect(FLOW).toContain("<SequenceCard");
    expect(FLOW).toContain("<PickSheet");
  });

  /**
   * ⚠️ 200 entries. The page is `force-dynamic`, so this rides the payload of
   * every request that reaches it, and for a visitor deciding whether to
   * boost the page is three pictures and a link to Discord.
   */
  it("hands the catalogue only to a booster who can actually pick with it", () => {
    expect(PAGE).toContain("view.boosting && view.gamertag !== null ? boosterCatalogue() : null");
    // ⚠️ Still the subpath, never the package index: the index is in the
    // browser graph, so an export from there lands this in every download.
    expect(PAGE).toContain('from "@factions/domain/catalogue"');
  });

  /**
   * ⚠️ The armband is derived from the clan's flag every read, so a control
   * for it would offer a pick the write layer has no column to store. The
   * redesign drops it from this page entirely (2026-09-19); what must not
   * come back is a way to SET it.
   */
  it("offers no armband control, and has no slot it could be saved under", () => {
    expect(KIT_SLOTS).not.toContain("armband");
    for (const [name, text] of Object.entries(SOURCES)) {
      expect([name, /name="armband"|slot="armband"|"armband"/u.test(text)]).toEqual([name, false]);
    }
  });

  it("offers only catalogue options for each slot", () => {
    const catalogue = boosterCatalogue();
    for (const slot of KIT_SLOTS) expect([slot, catalogue[slot].length > 0]).toEqual([slot, true]);
    expect(FLOW).toContain("catalogue[open]");
  });

  /**
   * ⚠️ The Save button is gone: every pick is a write. A stray submit button
   * left behind would post a form this page no longer has an action for.
   */
  it("saves on pick, with no form and no Save button left over", () => {
    expect(SHEET).toContain("onChoose");
    for (const [name, text] of Object.entries(SOURCES)) {
      expect([name, /<form\b|type="submit"/u.test(text)]).toEqual([name, false]);
    }
  });

  /**
   * ⚠️ The page polls while a sequence is open because emotes reach the
   * database in the bot's tick batches. Polling with none open would be a
   * page nobody is looking at hitting the database forever.
   */
  it("polls only while a placement sequence is open", () => {
    expect(FLOW).toContain("if (!view.challenge) return undefined;");
    expect(FLOW).toContain('fetch("/api/kit/status"');
  });
});

describe("the kit writes", () => {
  it("re-checks the session and the booster state inside every write, not just at render", () => {
    // ⚠️ A route handler is a POST endpoint anyone can call. Rendering the
    // pickers only for a booster is not a check.
    expect(GUARD).toContain("sessionOr401()");
    expect(GUARD).toContain("view.boosting");
    for (const [name, text] of Object.entries(ROUTES)) {
      if (name === "status") continue;
      expect([name, text.includes("await boosterOnly()")]).toEqual([name, true]);
    }
  });

  it("never writes a position: saving gear calls the slot write alone", () => {
    expect(ROUTES.slot).toContain("saveBoosterKitSlot(gate.discordId, slot, className)");
    expect(ROUTES.slot).not.toMatch(/pos[XYZ]/u);
  });

  /**
   * ⚠️ A refused pick is an answer for the player; a dead database is an
   * outage. A `catch` around the write would collapse the two and tell a
   * booster their valid jacket "is not on the list" while Postgres was down,
   * so they would re-pick from the same list forever and nobody would report
   * the outage. The refusal is an outcome from `@factions/roster`.
   */
  it("reads the refusal as an outcome and catches nothing around the write", () => {
    expect(ROUTES.slot).toContain("if (!out.ok) return json({ ok: false, reason: out.reason }, 400);");
    for (const [name, text] of Object.entries(ROUTES)) {
      // `.catch` on the request body parse is not the write; a try/catch is.
      expect([name, /\btry\s*\{/u.test(text)]).toEqual([name, false]);
    }
  });

  it("sends every kit answer through lib/api, so none of them can lose no-store", () => {
    for (const [name, text] of Object.entries(ROUTES)) {
      expect([name, text.includes('from "@/lib/api"')]).toEqual([name, true]);
      expect([name, /NextResponse\.json\(|new Response\(/u.test(text)]).toEqual([name, false]);
    }
  });

  /**
   * ⚠️ Every write answers with the server's own re-read of the whole view.
   * A page that patched one slot locally would sit wrong until the next poll
   * whenever a tick marked a spot or a pick was refused.
   */
  it("answers every write with a freshly read view", () => {
    for (const name of ["slot", "draw", "cancel"] as const) {
      expect([name, ROUTES[name].includes("await freshView(gate.discordId)")]).toEqual([name, true]);
    }
    expect(FLOW).toContain("applyView(out.view);");
  });

  /**
   * ⚠️ Two picks made inside one round trip can answer in either order. Only
   * the newest write may apply its answer, or the loser landing last puts the
   * older server view on screen and leaves it there until the next poll.
   */
  it("lets only the newest write apply its answer", () => {
    expect(FLOW).toContain("const mine = ++writes.current.started;");
    expect(FLOW).toContain("const newest = () => mine === writes.current.started;");
    /**
     * ⚠️ Every line inside `post` that speaks to the player is checked, not
     * just the happy one. `post` is sliced out first so the assertion cannot
     * be satisfied by a `newest()` call somewhere else in the file.
     */
    const post = FLOW.slice(FLOW.indexOf("const post = useCallback"), FLOW.indexOf("const flash = useCallback"));
    const speaks = post.split("\n").filter((l) => /applyView\(|setRefusal\(|flash\(/u.test(l));
    expect(speaks.length).toBeGreaterThan(0);
    /**
     * ⚠️ Matched on the GUARD, not on the words `newest()` appearing on the
     * line: `if (!newest()) setRefusal(...)` mentions it too and is the exact
     * inversion this exists to catch. An early `if (!newest()) return null;`
     * counts, because everything after it is gated by definition.
     */
    const gate = /if \(newest\(\)\)|if \(!newest\(\)\) return/u;
    for (const line of speaks) {
      const guarded = gate.test(line) || gate.test(post.slice(0, post.indexOf(line)).split("\n").slice(-6).join("\n"));
      expect([line.trim(), guarded]).toEqual([line.trim(), true]);
    }
  });

  /**
   * ⚠️ A poll answered after a write committed, but asked before it, would
   * put the pre-write state back on screen for up to POLL_MS. The page's own
   * promise is that it never patches a slot locally and hopes; discarding a
   * poll that raced a write is the other half of it.
   */
  it("throws away a poll answer that raced a write", () => {
    expect(FLOW).toContain("const at = writes.current.started;");
    expect(FLOW).toContain("if (writes.current.started !== at || writes.current.inFlight > 0) return;");
    // ⚠️ A count, not a flag: a boolean cleared by whichever write finished
    // first would reopen the window this closes.
    expect(FLOW).toContain("writes.current.inFlight += 1;");
    expect(FLOW).not.toMatch(/setBusy\(/u);
  });

  /**
   * ⚠️ `choose` needs the value a slot held a moment ago. Read from its
   * render closure, that is two picks stale when picks come faster than the
   * network, and Undo then jumps back two steps instead of one.
   */
  it("reads the value Undo restores from the latest view, not from a closure", () => {
    expect(FLOW).toContain("const prev = { slot, value: latest.current.slots[slot] ?? \"\" };");
  });

  /**
   * ⚠️ A pick is made from a sheet that fills a phone screen and closes on
   * the way out, so the player is looking at the bottom of the page. A
   * refusal rendered at the top reads as "I tapped and nothing happened".
   */
  it("reports a refusal in the same place it confirms a save", () => {
    expect(FLOW).toContain("{refusal !== null && (");
    expect(FLOW).toContain('<Bar role="alert" tone="rust">');
    expect(FLOW).toContain('<Bar role="status" tone="plain" onHold={dismiss.hold} onRelease={dismiss.release}>');
    /**
     * ⚠️ Every live region on this page is one of those two bars. A `role`
     * anywhere else is either a second announcement of the same news or a
     * refusal rendered somewhere the player is not looking, which is the bug
     * this replaced.
     */
    expect(code(FLOW).match(/role="alert"/gu) ?? []).toHaveLength(1);
    expect(code(FLOW).match(/role="status"/gu) ?? []).toHaveLength(1);
    // The only computed role is the one `Bar` passes straight through.
    expect(code(FLOW).match(/role=\{[^}]*\}/gu) ?? []).toEqual(["role={role}"]);
    /**
     * ⚠️ Two elements, never one element whose role flips: React reuses the
     * node, and a live region whose role changes after insertion is
     * announced inconsistently or not at all.
     */
    expect(FLOW).not.toMatch(/role=\{[^}]*\?/u);
  });

  /** M9: an Undo that vanishes while the player is reaching for it is an Undo they do not have. */
  it("keeps Undo up for ten seconds, and not at all while it is pointed at or focused", () => {
    expect(FLOW).toContain("dismissTimer(UNDO_MS,");
    expect(code(FLOW)).not.toContain("4500");
  });

  /**
   * ⚠️ The sheet's effect must depend on nothing. The parent hands it an
   * inline arrow, so an effect keyed on `onClose` re-ran on every render of
   * the page, including every poll tick, and re-focused the search box every
   * five seconds while a sequence was open.
   */
  it("sets the sheet up once, and hands focus back to the tile that opened it", () => {
    expect(SHEET).toContain("const close = useRef(onClose);");
    expect(SHEET).toContain("const opener = document.activeElement as HTMLElement | null;");
    expect(SHEET).toContain("opener?.focus?.();");
    // ⚠️ Every dependency list in the file, not just "some empty one": the
    // `[]` that matters could otherwise be a second effect added beside a
    // first that had quietly gone back to depending on `onClose`.
    expect(SHEET.match(/\}, \[[^\]]*\]\);/gu) ?? []).toEqual(["}, []);"]);
    // ⚠️ aria-modal is a claim, not a mechanism.
    expect(SHEET).toContain('aria-modal="true"');
    expect(SHEET).toContain('e.key !== "Tab"');
  });
});
