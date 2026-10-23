import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RadioPanel, type RadioState } from "../app/(site)/radio/radio-panel";
import { BunkerCardView } from "../app/(site)/radio/bunker-card";
import { tally } from "../lib/radio/tally";

const noop = () => {};
const panel = (state: RadioState, extra: Partial<Parameters<typeof RadioPanel>[0]> = {}) =>
  renderToStaticMarkup(createElement(RadioPanel, { state, level: 0, toneOn: false, locked: false, current: "", cards: [], onListen: noop, onStop: noop, onClear: noop, ...extra }));
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

  it("renders the unsupported state without a dead button", () => {
    const html = panel("unsupported");
    expect(html).toContain("can&#x27;t listen");
    expect(html).not.toContain(">Listen<");
  });

  it("a busy microphone says so and keeps the Listen button", () => {
    const html = panel("busy");
    expect(html).toContain("Another app is using the microphone");
    expect(html).toContain(">Listen<");
  });

  it("shows Stop and Clear while listening, and the beeps it is waiting for", () => {
    const html = panel("listening");
    expect(html).toContain(">Stop<");
    expect(html).toContain(">Clear<");
    expect(html).toContain("Listening for the beeps");
    expect(panel("listening", { locked: true })).toContain("Hearing the radio");
  });

  it("always shows three bunkers", () => {
    expect(panel("listening").match(/Bunker \d/g)).toEqual(["Bunker 1", "Bunker 2", "Bunker 3"]);
  });
});

describe("BunkerCardView", () => {
  it("links a full grid to the map", () => {
    expect(card("0910442410")).toContain('href="/map?at=091044"');
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
    expect(card("0910442410")).toContain("Heard once");
  });
});
