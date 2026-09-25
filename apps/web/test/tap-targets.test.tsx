import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoticeRow } from "@factions/roster";
import { NOTICE_GROUPS } from "../lib/notice-copy";
import { NoticeActions } from "../app/(site)/notifications/actions";
import { FilterChips } from "../app/(site)/notifications/filter-chips";

const row = (kind: NoticeRow["kind"]): NoticeRow => ({ id: 1, kind, target: "dm", occurredAt: new Date(), payload: {}, clanId: 7, unread: true });
const controls = (html: string) => (html.match(/<(button|a) /gu) ?? []).length;
const tall = (html: string) => (html.match(/min-h-\[44px\]/gu) ?? []).length;

describe("M7: 44px everywhere a player taps", () => {
  it.each(["invited", "vote_opened", "rebind_proposed"] as const)("every %s action is 44px tall", (kind) => {
    const html = renderToStaticMarkup(<NoticeActions row={row(kind)} />);
    expect(controls(html)).toBeGreaterThan(0);
    expect(tall(html)).toBe(controls(html));
    expect(html).not.toMatch(/min-h-\[3\dpx\]/u);
  });

  it("every filter chip is 44px tall", () => {
    const html = renderToStaticMarkup(<FilterChips group={undefined} href={() => "/notifications"} />);
    expect(tall(html)).toBe(NOTICE_GROUPS.length + 1);
  });

  it("the page's Mark all read is a full-size secondary button", () => {
    const page = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "notifications", "page.tsx"), "utf8");
    expect(page).toContain("<SubmitButton className={btnSecondary}>Mark all read</SubmitButton>");
  });

  it("the vault's Hide now is 44px tall", () => {
    const reveal = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "clan", "vault", "reveal-button.tsx"), "utf8");
    expect(reveal.split("\n").find((l) => l.includes(">Hide now<"))).toContain("min-h-[44px]");
  });
});
