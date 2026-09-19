import { describe, it, expect } from "vitest";
import { notificationsHref, noticeDay } from "../lib/notifications-page";

describe("notificationsHref", () => {
  // The regression test for the bug: o.group ?? group could never clear a filter,
  // because undefined ?? group evaluates to group.
  it("lets All clear an active group", () => {
    expect(notificationsHref({ page: 1, group: "Raid" }, { group: null, page: 1 })).toBe("/notifications");
  });

  it("lets the pager preserve the active group", () => {
    expect(notificationsHref({ page: 1, group: "Raid" }, { page: 2 })).toBe("/notifications?group=Raid&page=2");
  });

  it("omits page 1 from the query rather than writing page=1", () => {
    expect(notificationsHref({ page: 1, group: undefined }, { group: "Raid", page: 1 })).toBe("/notifications?group=Raid");
  });

  it("resets to page 1 when the group changes, even from page 3", () => {
    expect(notificationsHref({ page: 3, group: "Raid" }, { group: "Base", page: 1 })).toBe("/notifications?group=Base");
  });
});

describe("noticeDay", () => {
  it("calls 23:00 yesterday Yesterday, not Today", () => {
    const now = new Date("2026-09-18T01:00:00Z");
    const at = new Date("2026-09-17T23:00:00Z");
    expect(noticeDay(at, now)).toBe("Yesterday");
  });

  it("calls the same UTC calendar day Today", () => {
    const now = new Date("2026-09-18T23:30:00Z");
    const at = new Date("2026-09-18T00:05:00Z");
    expect(noticeDay(at, now)).toBe("Today");
  });

  it("calls three days back Earlier", () => {
    const now = new Date("2026-09-18T12:00:00Z");
    const at = new Date("2026-09-15T12:00:00Z");
    expect(noticeDay(at, now)).toBe("Earlier");
  });
});
