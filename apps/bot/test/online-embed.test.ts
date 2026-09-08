import { describe, it, expect } from "vitest";
import { onlineEmbed, onlineKey, type OnlinePlayer } from "../src/online-embed.js";

const now = new Date("2026-09-08T18:00:00Z");
const at = (h: number) => new Date(now.getTime() - h * 3600_000);
const p = (gamertag: string, hoursAgo: number, tag: string | null = null): OnlinePlayer =>
  ({ dayzId: gamertag.toUpperCase().padEnd(40, "0"), gamertag, tag, connectedAt: at(hoursAgo) });

describe("onlineEmbed", () => {
  it("counts in the title and lists longest-connected first, with tag and a relative time", () => {
    const e = onlineEmbed([p("Sable", 1, "BEAR"), p("Marrow", 3), p("Brine", 2, "WOLF")], now);
    expect(e.title).toBe("Players online · 3");
    expect(e.description!.split("\n")).toEqual([
      `**Marrow** · on since <t:${at(3).getTime() / 1000}:R>`,
      `**Brine** [WOLF] · on since <t:${at(2).getTime() / 1000}:R>`,
      `**Sable** [BEAR] · on since <t:${at(1).getTime() / 1000}:R>`,
    ]);
    expect(e.timestamp).toBe(now.toISOString());
  });

  it("empty is a sentence, in grey", () => {
    const e = onlineEmbed([], now);
    expect(e.title).toBe("Players online · 0");
    expect(e.description).toBe("Nobody on the server.");
    expect(e.color).not.toBe(onlineEmbed([p("X", 1)], now).color);
  });

  it("escapes a gamertag that is markdown", () => {
    expect(onlineEmbed([p("_x_", 1)], now).description).toContain("**\\_x\\_**");
  });
});

describe("onlineKey", () => {
  it("is the same for the same players in any order, and differs on a join, a leave, a reconnect or a tag change", () => {
    const a = [p("A", 1), p("B", 2)];
    expect(onlineKey(a)).toBe(onlineKey([...a].reverse()));
    expect(onlineKey(a)).not.toBe(onlineKey([p("A", 1)]));
    expect(onlineKey(a)).not.toBe(onlineKey([p("A", 1), p("B", 2), p("C", 1)]));
    expect(onlineKey(a)).not.toBe(onlineKey([p("A", 0.5), p("B", 2)]));
    expect(onlineKey(a)).not.toBe(onlineKey([p("A", 1, "BEAR"), p("B", 2)]));
  });
});
