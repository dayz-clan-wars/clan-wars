import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { OnlineNow, HOME_ONLINE_CAP } from "../app/(site)/live/online-now";

const p = (n: number) => ({ gamertag: `P${n}`, tag: null, connectedAt: new Date("2026-09-08T00:00:00Z") });

describe("OnlineNow", () => {
  it("shows the count and at most ten names, linking to the full list", () => {
    const html = renderToStaticMarkup(createElement(OnlineNow, { players: Array.from({ length: 12 }, (_, i) => p(i)) }));
    expect(html).toContain("12");
    expect(html).toContain("P9");
    expect(html).not.toContain("P10");
    expect(html).toContain('href="/live/online"');
    expect(HOME_ONLINE_CAP).toBe(10);
  });
  it("says so when nobody is on", () => {
    expect(renderToStaticMarkup(createElement(OnlineNow, { players: [] }))).toContain("Nobody on the server.");
  });
  it("makes every link a 44px tap target", () => {
    const html = renderToStaticMarkup(createElement(OnlineNow, { players: [p(1), p(2)] }));
    const links = [...html.matchAll(/<a [^>]*>/gu)].map((m) => m[0]);
    expect(links).toHaveLength(3);
    for (const a of links) expect(a).toContain("min-h-[44px]");
  });
});
