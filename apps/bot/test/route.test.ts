import { describe, it, expect, afterEach } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import { handleChatInput } from "../src/commands/route.js";
import { SPECS } from "../src/commands/index.js";
import type { Ctx } from "../src/commands/types.js";

/**
 * Ruling 10: a handler that throws after the interaction is deferred must
 * still produce a reply — otherwise the player is left staring at a
 * "thinking…" interaction forever, since the outer try/catch in discord.ts
 * only stops the bot itself from crashing.
 *
 * A fake ChatInputCommandInteraction, not a real discord.js client: this is
 * `route.ts`'s own unit, and the whole point of `CommandInput` is that
 * nothing downstream needs a client.
 */
function fakeInteraction(path: string): {
  interaction: unknown;
  deferred: boolean[];
  edits: { content?: string; embeds?: unknown[] }[];
} {
  const [commandName, subcommand] = path.split(" ");
  const deferred: boolean[] = [];
  const edits: { content?: string; embeds?: unknown[] }[] = [];
  const interaction = {
    commandName,
    user: { id: "discord-thrower" },
    options: {
      getSubcommand: () => subcommand ?? null,
      getString: () => null,
      getInteger: () => null,
      getBoolean: () => null,
      getUser: () => null,
    },
    deferReply: async () => { deferred.push(true); },
    editReply: async (payload: { content?: string; embeds?: unknown[] }) => { edits.push(payload); },
  };
  return { interaction, deferred, edits };
}

describe("handleChatInput — Ruling 10", () => {
  const THROWING_PATH = "test throws";

  afterEach(() => {
    SPECS.delete(THROWING_PATH);
  });

  it("edits a reply instead of leaving the interaction stuck when a handler throws", async () => {
    SPECS.set(THROWING_PATH, {
      path: THROWING_PATH,
      handler: async () => {
        throw new Error("boom");
      },
    });
    const ctx = {} as Ctx;
    const { interaction, deferred, edits } = fakeInteraction(THROWING_PATH);

    await handleChatInput(ctx, interaction as unknown as ChatInputCommandInteraction);

    expect(deferred).toEqual([true]);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.content).toBeTruthy();
    expect(edits[0]!.content).not.toMatch(/boom/);
  });
});
