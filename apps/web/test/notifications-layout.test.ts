import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "notifications", "page.tsx"), "utf8");

describe("/notifications is an ordinary signed-in page (L8)", () => {
  /** app/(site)/me/route.ts: in this streamed group a redirect() is a one-second meta refresh, not a 3xx. */
  it("⚠️ answers a lost session with SessionLost, never a streamed redirect()", () => {
    expect(PAGE).not.toMatch(/from "next\/navigation"/u);
    expect(PAGE).toContain('<SessionLost next="/notifications" />');
  });
  it("uses Page and PageHead — centred, the shared title scale, one <main>", () => {
    expect(PAGE).toContain("<Page>");
    expect(PAGE).toContain("<PageHead");
    expect(PAGE).not.toContain("<main");
  });
  it("ends on the way back", () => expect(PAGE).toContain('<BackLine href="/me">'));
});
