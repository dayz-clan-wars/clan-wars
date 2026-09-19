import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoticeRow } from "@factions/roster";
import { NoticeArticle } from "../app/components/notice-row";

const row = (o: Partial<NoticeRow> = {}): NoticeRow => ({
  id: 1, kind: "promoted", target: "channel", occurredAt: new Date("2026-09-18T10:00:00Z"),
  payload: { gamertag: "Ada" }, clanId: 7, unread: true, ...o,
});
const render = (r: NoticeRow, actions: React.ReactNode = null) =>
  renderToStaticMarkup(createElement(NoticeArticle, { row: r, actions }));

describe("a notification row", () => {
  it("shows the kicker, title and body", () => {
    const html = render(row());
    expect(html).toContain("Roster");
    expect(html).toContain("Ada is now an officer");
  });

  /** Unread is the only thing the eye should catch on a long page. */
  it("marks unread with a dot and a lit background, and read with neither", () => {
    expect(render(row({ unread: true }))).toContain("bg-surface");
    expect(render(row({ unread: false }))).not.toContain("bg-surface");
  });

  it("⚠️ says unread in words, not only in colour", () => {
    expect(render(row({ unread: true }))).toContain("Unread");
    expect(render(row({ unread: false }))).not.toContain("Unread");
  });

  /**
   * ⚠️ Rust means an outstanding obligation and nothing else (globals.css). Only
   * a genuine one — a challenge pending or expired — takes it; `flag_down` is one.
   */
  it("renders an outstanding-obligation kind in the rust tone", () => {
    expect(render(row({ kind: "flag_down", payload: { gamertag: "Ada" } }))).toContain("text-rust-2");
  });

  /**
   * ⚠️ `ban_applied` and `zone_warning` are notable but discharge nothing, so
   * they must never borrow rust — that would make it a generic "bad news"
   * colour, which globals.css explicitly forbids.
   */
  it("never paints ban_applied or zone_warning rust, even though they stand out", () => {
    const ban = render(row({ kind: "ban_applied", payload: { reason: "zone" } }));
    const zone = render(row({ kind: "zone_warning", payload: { tag: "IW" } }));
    expect(ban).not.toContain("text-rust-2");
    expect(ban).not.toContain("bg-rust-2");
    expect(zone).not.toContain("text-rust-2");
    expect(zone).not.toContain("bg-rust-2");
  });

  it("renders actions when it is given them, and nothing when it is not", () => {
    expect(render(row(), createElement("button", {}, "Accept"))).toContain("Accept");
    expect(render(row())).not.toContain("<button");
  });

  /**
   * ⚠️ Case-insensitive on the attribute name, exact on the value. React renders
   * this as `dateTime`, and HTML attribute names are case-insensitive, so the
   * browser reads it as `datetime` either way. Asserting the lowercase spelling
   * pins a renderer detail rather than the behaviour, which is that the row
   * carries a machine-readable timestamp.
   */
  it("carries a machine-readable timestamp", () => {
    expect(render(row())).toMatch(/datetime="2026-09-18T10:00:00\.000Z"/iu);
  });
});
