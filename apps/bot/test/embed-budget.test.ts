import { describe, it, expect } from "vitest";
import { EmbedBuilder } from "discord.js";
import { budget, EMBED_TOTAL_MAX, MAX_FIELDS } from "../src/commands/embeds/budget.js";

/** What Discord counts: title + description + every field name and value + footer. */
function totalLength(embed: EmbedBuilder): number {
  const j = embed.toJSON();
  return (j.title?.length ?? 0) + (j.description?.length ?? 0) + (j.footer?.text.length ?? 0)
    + (j.fields ?? []).reduce((s, f) => s + f.name.length + f.value.length, 0);
}

describe("embed budget", () => {
  it("splits lines into 1024-character fields", () => {
    const embed = new EmbedBuilder().setTitle("T");
    budget(1).list(embed, "Rows", Array.from({ length: 60 }, (_, i) => `• line ${i} ${"x".repeat(40)}`), (n) => `+${n} more`);
    const fields = embed.toJSON().fields ?? [];
    expect(fields.length).toBeGreaterThan(1);
    for (const f of fields) expect(f.value.length).toBeLessThanOrEqual(1024);
  });

  /**
   * ⚠️ The gap this file exists for. The overflow notice is itself a field
   * with a name and a value, and the old `directoryEmbed` added it AFTER
   * deciding what fit — so an embed at exactly the cap grew past it and
   * Discord refused the whole card.
   */
  it("stays under the total cap with the overflow notice counted", () => {
    const embed = new EmbedBuilder().setTitle("T").setFooter({ text: "F" });
    const lines = Array.from({ length: 4000 }, (_, i) => `• clan ${i} — 8 members`);
    budget("T".length + "F".length).list(embed, "Clans", lines, (n) => `+${n} more — see the site.`);
    expect(totalLength(embed)).toBeLessThanOrEqual(EMBED_TOTAL_MAX);
    expect((embed.toJSON().fields ?? []).length).toBeLessThanOrEqual(MAX_FIELDS);
  });

  it("names exactly how many lines were left off", () => {
    const embed = new EmbedBuilder();
    const lines = Array.from({ length: 4000 }, (_, i) => `• clan ${i} — 8 members`);
    budget(0).list(embed, "Clans", lines, (n) => `+${n} more`);
    const last = (embed.toJSON().fields ?? []).at(-1)!;
    const left = Number(/\+(\d+) more/u.exec(last.value)![1]);
    const shown = (embed.toJSON().fields ?? []).slice(0, -1).reduce((s, f) => s + f.value.split("\n").length, 0);
    expect(shown + left).toBe(4000);
  });

  it("adds nothing and reports false when a plain field does not fit", () => {
    const embed = new EmbedBuilder();
    const b = budget(EMBED_TOTAL_MAX - 4);
    expect(b.field(embed, "Name", "value that is far too long to fit")).toBe(false);
    expect(embed.toJSON().fields ?? []).toEqual([]);
  });

  it("adds every line and no notice when everything fits", () => {
    const embed = new EmbedBuilder();
    budget(0).list(embed, "Rows", ["• a", "• b"], (n) => `+${n} more`);
    expect(embed.toJSON().fields).toEqual([{ name: "Rows", value: "• a\n• b", inline: false }]);
  });
});
