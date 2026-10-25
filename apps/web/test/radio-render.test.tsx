import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RadioPanel, type RadioState } from "../app/(site)/radio/radio-panel";
import { BunkerCardView } from "../app/(site)/radio/bunker-card";
import { tally } from "../lib/radio/tally";

const noop = () => {};
const panel = (state: RadioState, extra: Partial<Parameters<typeof RadioPanel>[0]> = {}) =>
  renderToStaticMarkup(createElement(RadioPanel, {
    state, level: 0, toneOn: false, locked: false, current: "", symbols: "", pressed: false, cards: [], restored: false, undoable: false,
    onListen: noop, onTap: noop, onStop: noop, onClear: noop, onUndo: noop, onPress: noop, onRelease: noop, ...extra,
  }));
const heard = (...reads: string[]) => tally(reads.map((digits) => ({ digits })));
const card = (...reads: string[]) => renderToStaticMarkup(createElement(BunkerCardView, { n: 1, card: tally(reads.map((digits) => ({ digits })))[0]! }));

describe("RadioPanel", () => {
  it("renders the idle state", () => {
    const html = panel("idle");
    expect(html).toContain(">Listen<");
    expect(html).toContain("never leaves your device");
  });

  it("renders the denied state", () => {
    const html = panel("denied");
    expect(html).toContain("Your browser blocked the microphone");
    expect(html).toContain(">Listen<");
  });

  it("renders the unsupported state without a dead button, and offers tapping", () => {
    const html = panel("unsupported");
    expect(html).toContain("can&#x27;t listen");
    expect(html).not.toContain(">Listen<");
    expect(html).toContain(">Tap along<");
  });

  it("offers tapping beside Listen, and after every microphone problem", () => {
    for (const s of ["idle", "denied", "no-device", "busy"] as const) expect(panel(s), s).toContain(">Tap along<");
  });

  it("a busy microphone says so and keeps the Listen button", () => {
    const html = panel("busy");
    expect(html).toContain("Another app is using the microphone");
    expect(html).toContain(">Listen<");
  });

  it("shows Stop while listening, Start over once something is heard, and the beeps it is waiting for", () => {
    const html = panel("listening");
    expect(html).toContain(">Stop<");
    expect(html).not.toContain(">Start over<");
    expect(panel("listening", { cards: heard("0910442410") })).toContain(">Start over<");
    expect(html).toContain("Listening for the beeps");
    expect(panel("listening", { locked: true })).toContain("Hearing the radio");
  });

  it("tapping shows the key and the taps so far, grouped a digit at a time", () => {
    const html = panel("tapping", { symbols: ".----..---" });
    expect(html).toContain("Tap key");
    expect(html).toContain("Wait for the long pause");
    expect(html).toContain("·––––");
    expect(html).toContain("··–––");
    expect(html).toContain(">Stop<");
    expect(panel("tapping", { pressed: true })).toContain('aria-pressed="true"');
  });

  it("says where restored codes came from", () => {
    expect(panel("idle", { restored: true, cards: heard("0910442410") })).toContain("kept on this device for 2 hours");
    expect(panel("idle", { restored: true })).not.toContain("kept on this device");
  });

  it("offers Undo right after Start over", () => {
    expect(panel("idle", { undoable: true })).toContain(">Undo<");
    expect(panel("idle")).not.toContain(">Undo<");
  });

  it("says how often the broadcast comes round until all three settle", () => {
    expect(panel("listening")).toContain("about every 4½ minutes");
    const settled = heard("0910442410", "0910442410", "1001219970", "1001219970", "0281002049", "0281002049");
    expect(panel("listening", { cards: settled })).not.toContain("about every 4½ minutes");
  });

  it("always shows three bunkers", () => {
    expect(panel("listening").match(/Bunker \d/g)).toEqual(["Bunker 1", "Bunker 2", "Bunker 3"]);
  });
});

describe("BunkerCardView", () => {
  it("links a full grid to the map, in a new tab", () => {
    const html = card("0910442410");
    expect(html).toContain('href="/map?at=091044"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Open grid 091 044 on the map, in a new tab");
  });

  it("marks an unsure digit by more than its colour", () => {
    expect(card("0910442410")).toContain("decoration-dotted");
    expect(card("0910442410", "0910442410")).not.toContain("decoration-dotted");
  });

  it("no map link while the grid has a gap", () => {
    expect(card("09?0442410")).not.toContain("/map?at=");
  });

  it("marks settled", () => {
    expect(card("0910442410", "0910442410")).toContain("Settled");
    expect(card("0910442410")).not.toContain("Settled");
  });

  it("a grid off the bunker list looks unsure, however often it was heard", () => {
    const html = card(...Array.from({ length: 5 }, () => "5555552410"));
    expect(html).toContain("Not a bunker square");
    expect(html).not.toMatch(/text-ink">5</);
  });

  it("says how often it was heard", () => {
    expect(card("0910442410", "0910442410")).toContain("Heard 2 times");
    expect(card("0910442410")).toContain("Heard once · one more pass to settle");
    expect(card("0910442410", "0910442410")).not.toContain("to settle");
  });
});
