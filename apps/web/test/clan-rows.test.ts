import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DirectoryEntry } from "@factions/roster";
import { CLAN_NAME_LENGTH } from "@factions/domain";
import { ClanRow, RecruitingRow } from "../app/(site)/clans/rows";

const LONG = "W".repeat(CLAN_NAME_LENGTH.max);
const clan = (o: Partial<DirectoryEntry> = {}): DirectoryEntry => ({
  tag: "WWW", name: LONG, texture: "Flag_Wolf", status: "active", memberCount: 7,
  recruiting: true, playWindow: "Evenings UTC", language: "English", pitch: null, alpha: true, ...o,
});

/**
 * M11: a CLAN_NAME_LENGTH.max name with no space, in Archivo Black at 15px,
 * is ~350px — wider than a phone's row. A flex item without min-w-0 will not
 * shrink below its longest word and pushes the member count off-screen.
 */
describe("/clans rows with a 32-character name", () => {
  it.each([["Every clan", ClanRow], ["Recruiting", RecruitingRow]] as const)("%s: ⚠️ the name shrinks and breaks anywhere", (_, Row) => {
    const html = renderToStaticMarkup(createElement(Row, { c: clan() }));
    expect(html).toMatch(new RegExp(`class="[^"]*min-w-0[^"]*\\[overflow-wrap:anywhere\\][^"]*">${LONG}<`, "u"));
  });

  it.each([["Every clan", ClanRow], ["Recruiting", RecruitingRow]] as const)("%s: the count and badges never shrink", (_, Row) => {
    const html = renderToStaticMarkup(createElement(Row, { c: clan() }));
    expect(html).toMatch(/class="ml-auto flex-none[^"]*">7/u);
  });
});
