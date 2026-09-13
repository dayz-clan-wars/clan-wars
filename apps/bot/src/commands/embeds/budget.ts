import type { EmbedBuilder } from "discord.js";

/**
 * Discord's embed caps, and one accountant that respects all three at once.
 *
 * ⚠️ The reason this is a file and not four lines in each embed: the
 * overflow notice ("+N more") is ITSELF a field with a name and a value, and
 * the natural way to write this — fit what you can, then append the notice —
 * spends characters it never budgeted for. An embed that lands one character
 * over 6000 is refused by the API in full, which reaches the player as
 * `HANDLER_FAILED`: a list command that fails because the list grew, with no
 * outage and no bug in sight. `list()` reserves the notice before it decides
 * what fits.
 */
export const EMBED_TOTAL_MAX = 6000;
export const FIELD_VALUE_MAX = 1024;
export const MAX_FIELDS = 25;

export type Budget = {
  /** One field per `FIELD_VALUE_MAX` chunk of `lines`, with `more(n)` appended when any were dropped. */
  list: (embed: EmbedBuilder, name: string, lines: string[], more: (n: number) => string) => void;
  /** One plain field, added only if it fits. Returns whether it was added. */
  field: (embed: EmbedBuilder, name: string, value: string, inline?: boolean) => boolean;
  /** Characters spent so far, including whatever the caller declared up front. */
  spent: () => number;
};

/**
 * `spentAlready` is what the caller has already put on the embed that
 * Discord counts — title, description and footer. Pass it, or the budget is
 * optimistic by exactly that much.
 */
export function budget(spentAlready: number): Budget {
  let spent = spentAlready;
  let fields = 0;

  const add = (embed: EmbedBuilder, name: string, value: string, inline: boolean): boolean => {
    const cost = name.length + value.length;
    if (fields >= MAX_FIELDS || spent + cost > EMBED_TOTAL_MAX) return false;
    embed.addFields({ name, value, inline });
    spent += cost;
    fields += 1;
    return true;
  };

  return {
    spent: () => spent,
    field: (embed, name, value, inline = false) => add(embed, name, value, inline),
    list: (embed, name, lines, more) => {
      if (lines.length === 0) return;
      // Chunk first: each chunk is a field value at or under FIELD_VALUE_MAX.
      const chunks: string[][] = [];
      let chunk: string[] = [];
      for (const line of lines) {
        if (chunk.length > 0 && [...chunk, line].join("\n").length > FIELD_VALUE_MAX) { chunks.push(chunk); chunk = []; }
        chunk.push(line);
      }
      if (chunk.length > 0) chunks.push(chunk);

      // Reserve the notice before spending anything: its value is longest
      // when the count is largest, so price it against every line.
      const notice = more(lines.length);
      const reserve = "…".length + notice.length;

      let shown = 0;
      for (const [i, c] of chunks.entries()) {
        const fieldName = i === 0 ? name : "…";
        const value = c.join("\n");
        const cost = fieldName.length + value.length;
        const isLast = i === chunks.length - 1;
        // The last chunk needs no reserve — if it fits, nothing overflows.
        const room = isLast ? EMBED_TOTAL_MAX : EMBED_TOTAL_MAX - reserve;
        const slots = isLast ? MAX_FIELDS : MAX_FIELDS - 1;
        if (fields >= slots || spent + cost > room) break;
        embed.addFields({ name: fieldName, value, inline: false });
        spent += cost;
        fields += 1;
        shown += c.length;
      }
      if (shown < lines.length) add(embed, "…", more(lines.length - shown), false);
    },
  };
}
