import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { clanTitle, playerTitle, NOT_FOUND_TITLE } from "../lib/page-titles";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "app", "(site)", ...p), "utf8");

/** M6: every clan tab read "Clan Wars — clan" and every player tab "Clan Wars — player". */
describe("entity page titles", () => {
  it("keeps the site's 'Clan Wars — <thing>' form, with the thing named", () => {
    expect(clanTitle({ name: "Dead Rabbits", tag: "DR" })).toBe("Clan Wars — Dead Rabbits [DR]");
    expect(playerTitle("IGC slide")).toBe("Clan Wars — IGC slide");
    expect(NOT_FOUND_TITLE).toBe("Clan Wars — not found");
  });

  it.each([["clans", "[tag]", "page.tsx"], ["players", "[gamertag]", "page.tsx"]])("%s/%s/%s builds its title from the record", (...p) => {
    const src = read(...p);
    expect(src).toMatch(/export async function generateMetadata\(/u);
    expect(src).not.toMatch(/export const metadata/u);
  });

  it("⚠️ the metadata read and the page read are one memoized call, not two queries", () => {
    expect(read("clans", "[tag]", "page.tsx")).toMatch(/const clanFor = cache\(/u);
    expect(read("players", "[gamertag]", "page.tsx")).toMatch(/const profileFor = cache\(/u);
  });
});
