import { describe, it, expect, afterEach } from "vitest";
import type { ChatInputCommandInteraction, Interaction, MessageComponentInteraction, ModalSubmitInteraction } from "discord.js";
import { handleChatInput, handleComponent, handleModalSubmit, routeInteraction, UNKNOWN } from "../src/commands/route.js";
import { GROUPS, SPECS, COMPONENTS, MODALS, MODAL_OPENERS } from "../src/commands/index.js";
import { confirmId, modalId } from "../src/commands/confirm.js";
import { putDraft, clearDraft } from "../src/commands/founding-draft.js";
import type { ComponentHandler, Ctx, ModalHandler } from "../src/commands/types.js";

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

/**
 * A fake MessageComponentInteraction — a pressed button. Mirrors
 * `fakeInteraction` above: `route.ts`'s own unit, no discord.js client
 * needed. Edits (and replies, for the un-deferred modal-opener path) land in
 * `_edits`, read back by `runComponent`.
 */
function fakeButton(customId: string, userId: string): Interaction {
  const edits: { content?: string; embeds?: unknown[]; components?: unknown[] }[] = [];
  const modals: unknown[] = [];
  const deferred: boolean[] = [];
  const interaction = {
    customId,
    user: { id: userId },
    isButton: () => true,
    isMessageComponent: () => true,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isModalSubmit: () => false,
    values: [] as string[],
    deferReply: async () => { deferred.push(true); },
    reply: async (payload: { content?: string; embeds?: unknown[]; components?: unknown[] }) => { edits.push(payload); },
    editReply: async (payload: { content?: string; embeds?: unknown[]; components?: unknown[] }) => { edits.push(payload); },
    showModal: async (modal: unknown) => { modals.push(modal); },
    _edits: edits,
    _modals: modals,
    _deferred: deferred,
  };
  return interaction as unknown as Interaction;
}

/**
 * Runs `handleComponent` against a fake button, with the given handlers
 * registered under `COMPONENTS` only for the duration of the call — so one
 * test's stub action never leaks into the next.
 */
async function runComponent(
  opts: { customId: string; userId: string },
  handlers: Record<string, ComponentHandler>,
): Promise<string | undefined> {
  const keys = Object.keys(handlers);
  for (const [action, handler] of Object.entries(handlers)) COMPONENTS.set(action, handler);
  try {
    const interaction = fakeButton(opts.customId, opts.userId) as unknown as MessageComponentInteraction;
    await handleComponent({} as Ctx, interaction);
    return (interaction as unknown as { _edits: { content?: string }[] })._edits[0]?.content;
  } finally {
    for (const action of keys) COMPONENTS.delete(action);
  }
}

/**
 * A fake ModalSubmitInteraction — a submitted modal. Mirrors `fakeButton`
 * above. `fields` is a flat name→value map, read back through
 * `i.fields.getTextInputValue(n)` exactly as `handleModalSubmit` calls it.
 */
function fakeModal(customId: string, userId: string, fields: Record<string, string> = {}): Interaction {
  const edits: { content?: string; embeds?: unknown[]; components?: unknown[] }[] = [];
  const interaction = {
    customId,
    user: { id: userId },
    isButton: () => false,
    isMessageComponent: () => false,
    isStringSelectMenu: () => false,
    isChatInputCommand: () => false,
    isAutocomplete: () => false,
    isModalSubmit: () => true,
    fields: { getTextInputValue: (n: string) => fields[n] ?? "" },
    deferReply: async () => {},
    editReply: async (payload: { content?: string; embeds?: unknown[]; components?: unknown[] }) => { edits.push(payload); },
    _edits: edits,
  };
  return interaction as unknown as Interaction;
}

/**
 * Runs `handleModalSubmit` against a fake modal submit, with the given
 * handlers registered under `MODALS` only for the duration of the call —
 * mirrors `runComponent`.
 */
async function runModal(
  opts: { customId: string; userId: string; fields?: Record<string, string> },
  handlers: Record<string, ModalHandler>,
): Promise<string | undefined> {
  const keys = Object.keys(handlers);
  for (const [action, handler] of Object.entries(handlers)) MODALS.set(action, handler);
  try {
    const interaction = fakeModal(opts.customId, opts.userId, opts.fields) as unknown as ModalSubmitInteraction;
    await handleModalSubmit({} as Ctx, interaction);
    return (interaction as unknown as { _edits: { content?: string }[] })._edits[0]?.content;
  } finally {
    for (const action of keys) MODALS.delete(action);
  }
}

describe("component and modal routing", () => {
  it("refuses a button whose custom id names a different actor", async () => {
    const seen: string[] = [];
    const reply = await runComponent({ customId: confirmId("disband", "111"), userId: "999" }, {
      disband: async () => { seen.push("ran"); return { content: "done", ephemeral: true as const }; },
    });
    expect(seen).toEqual([]);
    expect(reply).toContain("not yours");
  });

  it("runs the handler when the presser is the actor", async () => {
    const reply = await runComponent({ customId: confirmId("disband", "111"), userId: "111" }, {
      disband: async () => ({ content: "Disbanded.", ephemeral: true as const }),
    });
    expect(reply).toBe("Disbanded.");
  });

  it("answers an unknown cw: action with the UNKNOWN sentence, never a throw", async () => {
    const reply = await runComponent({ customId: confirmId("nosuch", "111"), userId: "111" }, {});
    expect(reply).toBe(UNKNOWN);
  });

  it("leaves a component it does not own to discord.ts", async () => {
    expect(await routeInteraction({} as Ctx, fakeButton("invite-42", "111"))).toBe(false);
  });

  /**
   * The global constraint names modals explicitly: "a button, select menu or
   * modal is never a permission". `handleModalSubmit` re-checks the actor
   * the same way `handleComponent` does — this asserts that check, not just
   * the component one.
   */
  it("refuses a modal submit whose custom id names a different actor", async () => {
    const seen: string[] = [];
    const reply = await runModal({ customId: modalId("found", "111"), userId: "999" }, {
      found: async () => { seen.push("ran"); return { content: "done", ephemeral: true as const }; },
    });
    expect(seen).toEqual([]);
    expect(reply).toContain("not yours");
  });

  it("runs the modal handler when the submitter is the actor, reading fields by name", async () => {
    const reply = await runModal(
      { customId: modalId("found", "111"), userId: "111", fields: { name: "Falcons" } },
      { found: async (_ctx, a) => ({ content: `Founded ${a.field("name")}.`, ephemeral: true as const }) },
    );
    expect(reply).toBe("Founded Falcons.");
  });

  it("answers an unknown cw: modal action with the UNKNOWN sentence, never a throw", async () => {
    const reply = await runModal({ customId: modalId("nosuch", "111"), userId: "111" }, {});
    expect(reply).toBe(UNKNOWN);
  });

  it("leaves a modal submit it does not own to discord.ts", async () => {
    expect(await routeInteraction({} as Ctx, fakeModal("invite-42", "111"))).toBe(false);
  });
});

/**
 * `MODAL_OPENERS` is a derived index, not hand-maintained state: it must
 * always equal the union of every group's own `modalOpeners` list. With the
 * registry as it stands today that union is empty — no group opens a modal
 * yet — so this asserts the derivation itself, not any particular member.
 */
describe("MODAL_OPENERS", () => {
  it("is the union of every group's modalOpeners", () => {
    expect(MODAL_OPENERS).toBeInstanceOf(Set);
    const expected = new Set(GROUPS.flatMap((g) => g.modalOpeners ?? []));
    expect(MODAL_OPENERS).toEqual(expected);
  });

  /**
   * P4: `/found`'s "found-name" button is the first real modal opener, so it
   * is the first thing that can prove the no-defer branch actually works.
   * Discord refuses `showModal` on an interaction that has already been
   * acknowledged — if `handleComponent` deferred before calling this
   * handler, the button would be silently dead in production and no other
   * test would catch it, since every fake here just resolves.
   */
  it("shows the modal a listed opener returns, without deferring first", async () => {
    expect(MODAL_OPENERS.has("found-name")).toBe(true);
    const now = new Date("2026-09-13T00:00:00Z");
    putDraft("111", { ceremonyId: 9, texture: "Flag_Zenit", memberDayzIds: ["a"] }, now);
    try {
      const button = fakeButton(confirmId("found-name", "111"), "111");
      await handleComponent({ now } as Ctx, button as unknown as MessageComponentInteraction);
      const b = button as unknown as { _modals: unknown[]; _deferred: boolean[] };
      expect(b._modals).toHaveLength(1);
      expect(b._deferred).toEqual([]);
    } finally {
      clearDraft("111");
    }
  });
});
