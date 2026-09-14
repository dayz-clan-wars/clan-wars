import { describe, it, expect } from "vitest";
import { EmbedBuilder } from "discord.js";
import { budget, EMBED_TOTAL_MAX, FIELD_VALUE_MAX, MAX_FIELDS } from "../src/commands/embeds/budget.js";

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

  /**
   * ⚠️ Fix round 1, finding 1: a single line over FIELD_VALUE_MAX used to
   * become a chunk of one whose value already exceeded the cap, and
   * `embed.addFields` throws on that — reaching the player as
   * `HANDLER_FAILED` rather than the truncated-but-present card this
   * asserts.
   */
  it("truncates a single line longer than the field cap instead of throwing", () => {
    const embed = new EmbedBuilder();
    expect(() => budget(0).list(embed, "Rows", ["x".repeat(3000)], (n) => `+${n} more`)).not.toThrow();
    const fields = embed.toJSON().fields ?? [];
    expect(fields.length).toBeGreaterThan(0);
    for (const f of fields) expect(f.value.length).toBeLessThanOrEqual(FIELD_VALUE_MAX);
  });

  /**
   * ⚠️ Fix round 2, finding 3: `field()` checked the 25-field and
   * 6000-character caps but not the 1024-character field-value cap, so a
   * value over 1024 chars reached `embed.addFields` untouched — which
   * throws — reaching the player as `HANDLER_FAILED`, exactly the failure
   * this file's own docblock claims to prevent for "all three at once."
   * Unreachable today (every `field()` caller is bounded to 3 entries or a
   * short scalar), but this is the one place that promise is actually kept.
   */
  it("truncates a field value longer than the field cap instead of throwing", () => {
    const embed = new EmbedBuilder();
    expect(() => budget(0).field(embed, "Name", "x".repeat(3000))).not.toThrow();
    const fields = embed.toJSON().fields ?? [];
    expect(fields.length).toBe(1);
    expect(fields[0]!.value.length).toBe(FIELD_VALUE_MAX);
  });

  it("adds every line and no notice when everything fits", () => {
    const embed = new EmbedBuilder();
    budget(0).list(embed, "Rows", ["• a", "• b"], (n) => `+${n} more`);
    expect(embed.toJSON().fields).toEqual([{ name: "Rows", value: "• a\n• b", inline: false }]);
  });
});
