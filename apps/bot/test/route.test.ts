import { describe, it, expect, afterEach, vi } from "vitest";
import { ModalBuilder } from "discord.js";
import type { ChatInputCommandInteraction, Interaction, MessageComponentInteraction, ModalSubmitInteraction } from "discord.js";
import { handleChatInput, handleComponent, handleModalSubmit, routeInteraction, UNKNOWN } from "../src/commands/route.js";
import { GROUPS, SPECS, COMPONENTS, MODALS, MODAL_OPENERS, UPDATERS } from "../src/commands/index.js";
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
function fakeInteraction(
  path: string,
  opts: { userId?: string; calls?: string[] } = {},
): {
  interaction: unknown;
  deferred: boolean[];
  edits: { content?: string; embeds?: unknown[] }[];
  modals: unknown[];
} {
  const [commandName, subcommand] = path.split(" ");
  const deferred: boolean[] = [];
  const edits: { content?: string; embeds?: unknown[] }[] = [];
  const modals: unknown[] = [];
  const calls = opts.calls;
  const interaction = {
    commandName,
    user: { id: opts.userId ?? "discord-thrower" },
    options: {
      getSubcommand: () => subcommand ?? null,
      getString: () => null,
      getInteger: () => null,
      getBoolean: () => null,
      getUser: () => null,
    },
    deferReply: async () => { calls?.push("deferReply"); deferred.push(true); },
    editReply: async (payload: { content?: string; embeds?: unknown[] }) => { calls?.push("editReply"); edits.push(payload); },
    reply: async (payload: { content?: string; embeds?: unknown[] }) => { calls?.push("reply"); edits.push(payload); },
    showModal: async (modal: unknown) => { calls?.push("showModal"); modals.push(modal); },
  };
  return { interaction, deferred, edits, modals };
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
function fakeButton(customId: string, userId: string, calls?: string[]): Interaction {
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
    deferReply: async () => { calls?.push("deferReply"); deferred.push(true); },
    deferUpdate: async () => { calls?.push("deferUpdate"); deferred.push(true); },
    reply: async (payload: { content?: string; embeds?: unknown[]; components?: unknown[] }) => { calls?.push("reply"); edits.push(payload); },
    editReply: async (payload: { content?: string; embeds?: unknown[]; components?: unknown[] }) => { calls?.push("editReply"); edits.push(payload); },
    showModal: async (modal: unknown) => { calls?.push("showModal"); modals.push(modal); },
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
 *
 * ⚠️ Restores whatever was there before, rather than deleting the key. One
 * of the actions tests stub here is "disband", which `clanGroup` really
 * registers — deleting it would unregister the real handler for the rest of
 * the process, and any later test exercising real `disband` would silently
 * get `UNKNOWN` instead of a failure pointing at this file.
 */
async function runComponent(
  opts: { customId: string; userId: string },
  handlers: Record<string, ComponentHandler>,
): Promise<string | undefined> {
  const previous = new Map(Object.keys(handlers).map((action) => [action, COMPONENTS.get(action)]));
  for (const [action, handler] of Object.entries(handlers)) COMPONENTS.set(action, handler);
  try {
    const interaction = fakeButton(opts.customId, opts.userId) as unknown as MessageComponentInteraction;
    await handleComponent({} as Ctx, interaction);
    return (interaction as unknown as { _edits: { content?: string }[] })._edits[0]?.content;
  } finally {
    for (const [action, handler] of previous) {
      if (handler === undefined) COMPONENTS.delete(action);
      else COMPONENTS.set(action, handler);
    }
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
 * mirrors `runComponent`, restore-not-delete included.
 */
async function runModal(
  opts: { customId: string; userId: string; fields?: Record<string, string> },
  handlers: Record<string, ModalHandler>,
): Promise<string | undefined> {
  const previous = new Map(Object.keys(handlers).map((action) => [action, MODALS.get(action)]));
  for (const [action, handler] of Object.entries(handlers)) MODALS.set(action, handler);
  try {
    const interaction = fakeModal(opts.customId, opts.userId, opts.fields) as unknown as ModalSubmitInteraction;
    await handleModalSubmit({} as Ctx, interaction);
    return (interaction as unknown as { _edits: { content?: string }[] })._edits[0]?.content;
  } finally {
    for (const [action, handler] of previous) {
      if (handler === undefined) MODALS.delete(action);
      else MODALS.set(action, handler);
    }
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
 * always equal the union of every group's own `modalOpeners` list. `/found`'s
 * "found-name" button is a member of that union today (see `foundGroup`'s
 * `modalOpeners` in `found.ts`), so this asserts the derivation itself, not
 * any particular member — the test below pins that specific member.
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

  /**
   * M5: pins the invariant named in `route.ts`'s modal-opener branch — a
   * non-modal reply from an opener forwards `content` only. `embeds` (and
   * `components`) are silently dropped. Harmless today because every real
   * opener only ever returns a modal or a bare content string, but `Reply`
   * itself permits embeds here, so this test is what would fail the day a
   * future opener starts returning one instead of route.ts quietly widening.
   */
  it("drops embeds from a modal-opener's non-modal reply, without erroring", async () => {
    const previous = COMPONENTS.get("found-name");
    COMPONENTS.set("found-name", async () => ({
      content: "no modal this time",
      embeds: [{ fake: "embed" } as never],
      ephemeral: true as const,
    }));
    try {
      const button = fakeButton(confirmId("found-name", "111"), "111");
      await handleComponent({} as Ctx, button as unknown as MessageComponentInteraction);
      const b = button as unknown as { _edits: { content?: string; embeds?: unknown[] }[] };
      expect(b._edits).toHaveLength(1);
      expect(b._edits[0]!.content).toBe("no modal this time");
      expect(b._edits[0]!.embeds).toBeUndefined();
    } finally {
      if (previous === undefined) COMPONENTS.delete("found-name");
      else COMPONENTS.set("found-name", previous);
    }
  });
});

describe("a slash command that opens a modal", () => {
  const OPENER_PATH = "t opener";

  afterEach(() => {
    SPECS.delete(OPENER_PATH);
  });

  it("shows the modal without deferring first", async () => {
    // ⚠️ The whole point. Discord refuses showModal on an acknowledged
    // interaction, so a deferReply here makes /vault add answer with
    // nothing at all, forever, with no error a player can see.
    const modal = new ModalBuilder().setCustomId("cw:m:x:111:").setTitle("t");
    SPECS.set(OPENER_PATH, {
      path: OPENER_PATH,
      handler: async () => ({ modal, ephemeral: true as const }),
      opensModal: true,
    });
    const calls: string[] = [];
    const { interaction, deferred, modals } = fakeInteraction(OPENER_PATH, { userId: "111", calls });
    await handleChatInput({} as Ctx, interaction as unknown as ChatInputCommandInteraction);
    expect(calls).toEqual(["showModal"]);
    expect(deferred).toEqual([]);
    expect(modals).toEqual([modal]);
  });

  it("falls back to an ephemeral reply when the handler returns no modal", async () => {
    SPECS.set(OPENER_PATH, {
      path: OPENER_PATH,
      handler: async () => ({ content: "nope", ephemeral: true as const }),
      opensModal: true,
    });
    const calls: string[] = [];
    const { interaction, edits } = fakeInteraction(OPENER_PATH, { userId: "111", calls });
    await handleChatInput({} as Ctx, interaction as unknown as ChatInputCommandInteraction);
    expect(calls).toEqual(["reply"]);
    expect(edits[0]!.content).toBe("nope");
  });
});

describe("a select menu that updates in place", () => {
  it("acknowledges with deferUpdate so the card is edited, not duplicated", async () => {
    const calls: string[] = [];
    COMPONENTS.set("t-pick", async () => ({ content: "picked", ephemeral: true as const }));
    UPDATERS.add("t-pick");
    try {
      const button = fakeButton(confirmId("t-pick", "111"), "111", calls);
      await handleComponent({} as Ctx, button as unknown as MessageComponentInteraction);
      expect(calls).toEqual(["deferUpdate", "editReply"]);
    } finally {
      COMPONENTS.delete("t-pick");
      UPDATERS.delete("t-pick");
    }
  });

  it("still defers a plain confirm button as a new ephemeral reply", async () => {
    const calls: string[] = [];
    COMPONENTS.set("t-press", async () => ({ content: "done", ephemeral: true as const }));
    try {
      const button = fakeButton(confirmId("t-press", "111"), "111", calls);
      await handleComponent({} as Ctx, button as unknown as MessageComponentInteraction);
      expect(calls).toEqual(["deferReply", "editReply"]);
    } finally {
      COMPONENTS.delete("t-press");
    }
  });
});

/**
 * ⚠️ The exact hazard `safeErrorInfo` exists for: a handler's reply body can
 * be a secret (`/vault reveal`'s code), and `@discordjs/rest`'s
 * `DiscordAPIError`/`HTTPError` carry the whole failed request — including
 * that body — as `err.requestBody.json`. If `finish`'s final `editReply`
 * ever fails and something logs the caught error object directly, the
 * secret lands in the operator's log. This proves it does not: the fake
 * `editReply` below rejects with an object shaped exactly like that real
 * error, carrying a distinctive digit string nobody else in this suite
 * uses, and the test asserts that string appears nowhere in what
 * `console.error` was called with.
 */
describe("logging a failed editReply never leaks the reply body", () => {
  const LEAKY_PATH = "t leaky";

  afterEach(() => {
    SPECS.delete(LEAKY_PATH);
  });

  it("does not pass a DiscordAPIError-shaped rejection's request body to console.error", async () => {
    const CODE = "70155"; // distinctive: not a UI string this suite otherwise produces
    SPECS.set(LEAKY_PATH, {
      path: LEAKY_PATH,
      handler: async () => ({ content: `**Front gate** — \`${CODE}\`. Only you can see this.`, ephemeral: true as const }),
    });
    const fakeDiscordApiError = Object.assign(new Error("Unknown Message"), {
      name: "DiscordAPIError",
      code: 10008,
      status: 404,
      requestBody: { files: [], json: { content: `**Front gate** — \`${CODE}\`. Only you can see this.` } },
    });
    const [interaction] = (() => {
      const { interaction: base } = fakeInteraction(LEAKY_PATH, { userId: "111" });
      const i = base as { editReply: (payload: unknown) => Promise<void> };
      i.editReply = async () => { throw fakeDiscordApiError; };
      return [base];
    })();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleChatInput({} as Ctx, interaction as unknown as ChatInputCommandInteraction);
      const logged = JSON.stringify(errSpy.mock.calls);
      expect(logged).not.toContain(CODE);
    } finally {
      errSpy.mockRestore();
    }
  });
});
