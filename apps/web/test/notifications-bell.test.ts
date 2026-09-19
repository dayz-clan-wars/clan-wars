import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoticeRow } from "@factions/roster";
import { NotificationsBell } from "../app/components/notifications-bell";

const row = (id: number, unread = true): NoticeRow => ({
  id, kind: "promoted", target: "channel", occurredAt: new Date("2026-09-18T10:00:00Z"),
  payload: { gamertag: "Ada" }, factionId: 7, unread,
});
const render = (unread: number, recent: NoticeRow[] = []) =>
  renderToStaticMarkup(createElement(NotificationsBell, { unread, recent }));

describe("the bell", () => {
  it("shows the count when there is something waiting", () => {
    expect(render(3, [row(1)])).toContain(">3<");
  });

  it("shows no badge at zero", () => {
    expect(render(0)).not.toContain(">0<");
  });

  /** A bare number beside a bell means nothing to a screen reader. */
  it("⚠️ says what the number is", () => {
    expect(render(3, [row(1)])).toContain("Notifications");
    expect(render(3, [row(1)])).toMatch(/unread/iu);
  });

  it("always offers the way through to the full page", () => {
    expect(render(0)).toContain('href="/notifications"');
  });

  it("says so when there is nothing recent", () => {
    expect(render(0)).toMatch(/nothing/iu);
  });
});
