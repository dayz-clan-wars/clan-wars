import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoticeRow } from "@factions/roster";
import { NoticeArticle } from "../app/components/notice-row";

const row = (o: Partial<NoticeRow> = {}): NoticeRow => ({
  id: 1, kind: "promoted", target: "channel", occurredAt: new Date("2026-09-18T10:00:00Z"),
  payload: { gamertag: "Ada" }, factionId: 7, unread: true, ...o,
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

  it("renders an alarm kind in the rust tone", () => {
    expect(render(row({ kind: "ban_applied", payload: { reason: "zone" } }))).toContain("text-rust-2");
  });

  it("renders actions when it is given them, and nothing when it is not", () => {
    expect(render(row(), createElement("button", {}, "Accept"))).toContain("Accept");
    expect(render(row())).not.toContain("<button");
  });

  it("carries a machine-readable timestamp", () => {
    expect(render(row())).toContain('datetime="2026-09-18T10:00:00.000Z"');
  });
});
