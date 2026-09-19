import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoticeRow } from "@factions/roster";
import { safeBack } from "@/lib/form";
import { NoticeActions } from "@/app/(site)/notifications/actions";

const row = (o: Partial<NoticeRow> = {}): NoticeRow => ({
  id: 1, kind: "rebind_proposed", target: "channel", occurredAt: new Date("2026-09-18T10:00:00Z"),
  payload: {}, clanId: 7, unread: true, ...o,
});

/**
 * ⚠️ `back` reaches this from a form field, so it is attacker-controlled. Used
 * as given it is an open redirect: a link to our own domain that bounces the
 * player to someone else's, carrying our styling and their trust.
 */
describe("safeBack", () => {
  it("allows a known site path", () => {
    expect(safeBack("/notifications", "/me")).toBe("/notifications");
    expect(safeBack("/clan", "/me")).toBe("/clan");
  });

  it("⚠️ refuses an absolute URL, whatever it looks like", () => {
    expect(safeBack("https://evil.example/x", "/me")).toBe("/me");
    expect(safeBack("//evil.example", "/me")).toBe("/me");
    expect(safeBack("http://dayzclanwars.com.evil.example", "/me")).toBe("/me");
  });

  it("⚠️ refuses a path that is not on the list", () => {
    expect(safeBack("/notifications/../admin", "/me")).toBe("/me");
    expect(safeBack("/anything-else", "/me")).toBe("/me");
    expect(safeBack("", "/me")).toBe("/me");
    expect(safeBack(null, "/me")).toBe("/me");
  });
});

/**
 * `rebindCandidatesFor` can return several poles, and `clan_notices_no_coordinates`
 * forbids the notice payload from carrying a pole key, so nothing on this row can say
 * which candidate it meant. A POST here would have to guess (`rebindCandidates[0]`) and
 * silently commit a clan's base to the wrong pole, so the button must be a link to the
 * picker on `/clan/settings`, never a form that posts an action.
 */
describe("a rebind_proposed notice's action", () => {
  const html = renderToStaticMarkup(createElement(NoticeActions, { row: row() }));

  it("links to the /clan/settings picker", () => {
    expect(html).toContain('href="/clan/settings"');
  });

  it("is labelled Review it", () => {
    expect(html).toContain("Review it");
  });

  it("is not a form posting to /api/notifications/act", () => {
    expect(html).not.toContain("<form");
    expect(html).not.toContain("/api/notifications/act");
  });
});
