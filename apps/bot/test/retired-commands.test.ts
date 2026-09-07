import { describe, it, expect } from "vitest";
import { retiredPath, retiredReply, RETIRED_COMMANDS } from "../src/retired-commands.js";
import { buildCommands } from "../src/discord.js";

describe("retired commands", () => {
  it("registers the four old names, bare, plus the live 'guest' command, so a stale client gets a pointer and not 'unknown command'", () => {
    const cmds = buildCommands();
    expect(cmds.map((c) => c.name).sort()).toEqual([...RETIRED_COMMANDS, "guest"].sort());
    for (const c of cmds) {
      if (c.name === "guest") continue;
      expect((c as { options?: unknown[] }).options ?? []).toEqual([]);
    }
  });
  it("points each command at the page that replaced it", () => {
    expect(retiredPath("link", null)).toBe("/link");
    expect(retiredPath("unlink", null)).toBe("/me");
    expect(retiredPath("whoami", null)).toBe("/me");
    expect(retiredPath("faction", "claim")).toBe("/me");
    expect(retiredPath("faction", "invites")).toBe("/me");
    expect(retiredPath("faction", "info")).toBe("/clans");
    expect(retiredPath("faction", "roster")).toBe("/clans");
    expect(retiredPath("faction", "rename")).toBe("/clan/settings");
    expect(retiredPath("faction", "rebind")).toBe("/clan/settings");
    expect(retiredPath("faction", "invite")).toBe("/clan");
    expect(retiredPath("faction", null)).toBe("/clan");
  });
  it("answers with one line and a link, ephemerally", () => {
    const r = retiredReply("https://dayzclanwars.com", "faction", "kick");
    expect(r).toEqual({ content: "Manage this on the site: https://dayzclanwars.com/clan", ephemeral: true });
  });
});
