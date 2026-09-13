# Discord commands, plan 2 — the clan surface

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/me`, `/roster`, `/clan`, `/clans`, `/lead`, `/found` and a real `/guest`, clearing all 22 writes that `apps/bot/test/parity.test.ts` marks `"plan 2"`.

**Architecture:** Plan 1 built the machine — `makeRoster` (one domain layer, two front doors), `@factions/copy` (one outcome table per action, `DISCORD_OVERRIDES` for wording only), and `commands/{types,route,index}.ts` (a `CommandSpec` registry with a structural bijection test). Plan 2 adds command groups to that registry and extends the router with the two interaction kinds plan 1 did not need: **message components** (confirm buttons, select menus) and **modal submits**. No new rules, no new copy tables — every string a player sees in this plan already exists in `packages/copy`.

**Tech Stack:** TypeScript ESM, discord.js ^14.27.0, vitest, `@factions/roster`, `@factions/copy`.

**Spec:** `docs/superpowers/specs/2026-09-13-discord-command-parity-design.md`
**Predecessor:** `docs/superpowers/plans/2026-09-13-discord-commands-1-foundation.md`

## Global Constraints

- **Every reply is ephemeral, always.** `Reply.ephemeral` is the literal type `true`; there is no public option and there must never be one. `command-registration.test.ts` greps the whole `src/commands` tree for `ephemeral: false` and asserts `route.ts` acknowledges only with `MessageFlags.Ephemeral`. Every new acknowledgement path in Task 1 must satisfy that same test.
- **No player sees another player's base coordinates.** `/clan info`'s own-base field and `/base show` are the only places a coordinate may appear, and both show the viewer's own clan's. `rebindCandidates` carries `poleKey`, `raisedAt` and `by` — render the raiser and the time, never a coordinate.
- **Copy comes from `@factions/copy`.** Never hand-write a player-facing outcome sentence in `apps/bot`. Reach a table through `discordCopy(action, outcome)` / `discordLeadershipCopy(...)`, which apply `DISCORD_OVERRIDES`. If Discord needs different wording, add an override in `packages/copy/src/discord.ts` — do not fork the table.
- **`route.ts` is the only file that reads `interaction.*`.** Handlers are pure functions of `(Ctx, CommandInput)` and are unit-testable with no discord.js client.
- **The roster call is the permission check.** A button, a select menu or a modal is never a permission. Every handler re-passes `actorDiscordId` and lets `@factions/roster` re-derive role, clan and eligibility under its own row lock.
- **Retired stubs stay registered.** `RETIRED_COMMANDS` loses names only when the real command replacing it ships in the same registration PUT. `whoami` and `faction` are removed in plan 3, not here.
- **Test isolation:** run only `pnpm --filter @factions/bot test` (or the package you touched) while working. Never start a second turbo run — concurrent runs share the `factions_test_<package>` databases and each run's `globalSetup` drops the other's.

---

## Rulings made while writing this plan

**R1 — `/me` and `/clan` cannot be invoked bare.** Spec §4 writes `/me (default: your page) | accept | decline | withdraw`. Discord does not allow that: a command with subcommands has no bare form. The page becomes an explicit `/me show` and `/clan info`, matching `/base show` from plan 1. Cost if wrong: one extra word to type.

**R2 — Confirmation is a button press, and the press is the write.** For the four actions the site gates behind a checkbox (`disband`, `transfer`, `claim-succession`, `open-vote`), the slash command does **not** call the roster; it replies with the action's `unconfirmed` copy and a Confirm button. The button's handler calls the roster. This means the `unconfirmed` outcome is never produced by Discord — the copy is used, the code path is not. Cost if wrong: an extra round trip per destructive action, which is the point.

**R3 — `/clan leave` and `/lead ballot` get no confirm button.** Both tables carry an `unconfirmed` string, but spec §4.3 names only four gated actions and the site does not gate these two. Following the site keeps the surfaces identical. Cost if wrong: a mis-click leaves a clan, recoverable by asking to rejoin.

**R4 — `/found` keeps its in-progress choices in an in-memory draft, not in a customId.** A Discord `custom_id` caps at 100 characters; up to ten 17-character participant ids do not fit. `founding-draft.ts` holds `{ actorDiscordId → draft }` with a 15-minute TTL. This is safe **only because exactly one bot instance may run** — a project invariant, not an assumption. A lost draft (restart, TTL) costs the player re-running `/found`; nothing is written until the modal is submitted. Cost if wrong: a restart mid-founding makes someone start over.

**R5 — New component and modal `custom_id`s are namespaced `cw:`.** `discord.ts` still answers un-routed message components with a retired pointer keyed on an `invite-` prefix, for buttons on messages the old bot posted. Namespacing means the router claims only its own ids and that fallback keeps working untouched.

---

## File Structure

**Created in `apps/bot/src/commands/`:**
- `confirm.ts` — builds a Confirm button reply and parses its `custom_id`. One file because four groups need it and none owns it.
- `me.ts`, `roster.ts`, `clan.ts`, `clans.ts`, `lead.ts`, `found.ts`, `guest.ts` — one command group each.
- `embeds/me.ts`, `embeds/clan.ts`, `embeds/clans.ts`, `embeds/found.ts` — the cards those groups render. Embeds stay out of the group files so a group file reads as a list of handlers.
- `founding-draft.ts` — the `/found` draft store (R4).

**Modified:**
- `commands/types.ts` — `Reply` gains `components`; new `ComponentSpec`, `ModalSpec`, and their registries on `CommandGroup`.
- `commands/route.ts` — two new interaction kinds.
- `commands/index.ts` — the seven new groups; `buildCommands()` stops hand-rolling `/guest`.
- `apps/bot/src/discord.ts` — drops the `/guest` special case.
- `apps/bot/test/parity.test.ts` — 22 entries move from `PENDING` to `COMMANDS`.
- `CLAUDE.md`, `docs/deploy/` — the deploy note.

**Deleted:** `apps/bot/src/guest-command.ts` and `apps/bot/test/guest-command.test.ts` (Task 8), once `/guest grant` covers them.

---

### Task 1: Confirm buttons, component and modal routing

The router today handles chat input and autocomplete. Everything after this task needs buttons, select menus and modals. Build the mechanism once, with the actor re-check in it, so no group can forget the check.

**Files:**
- Modify: `apps/bot/src/commands/types.ts`
- Modify: `apps/bot/src/commands/route.ts`
- Modify: `apps/bot/src/commands/index.ts`
- Create: `apps/bot/src/commands/confirm.ts`
- Test: `apps/bot/test/confirm.test.ts`, `apps/bot/test/route.test.ts` (extend)

**Interfaces:**
- Consumes: `CommandSpec`, `CommandGroup`, `Ctx`, `Handler`, `Reply` from plan 1.
- Produces:
  - `confirmReply(action: string, prompt: string, arg?: string): Reply` — the prompt plus a Confirm button.
  - `confirmId(action: string, actorDiscordId: string, arg?: string): string` — `cw:c:<action>:<actor>:<arg>`.
  - `type ComponentHandler = (ctx: Ctx, a: { actorDiscordId: string; arg: string | null }) => Promise<Reply>`
  - `type ModalHandler = (ctx: Ctx, a: { actorDiscordId: string; arg: string | null; field: (name: string) => string }) => Promise<Reply>`
  - `CommandGroup` gains `components?: Record<string, ComponentHandler>`, `modals?: Record<string, ModalHandler>` (both keyed by the action segment) and `modalOpeners?: string[]`.
  - `CommandSpec` gains `opensModal?: true`.
  - `index.ts` exports `COMPONENTS: Map<string, ComponentHandler>`, `MODALS: Map<string, ModalHandler>` and `MODAL_OPENERS: Set<string>`.

- [ ] **Step 1: Write the failing test for the custom_id round trip and the actor check**

`apps/bot/test/confirm.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { confirmId, parseCustomId, confirmReply } from "../src/commands/confirm.js";

describe("confirm custom ids", () => {
  it("round-trips an action, an actor and an argument", () => {
    const id = confirmId("disband", "111", undefined);
    expect(parseCustomId(id)).toEqual({ kind: "c", action: "disband", actorDiscordId: "111", arg: null });
    expect(parseCustomId(confirmId("transfer", "111", "222"))).toEqual({
      kind: "c", action: "transfer", actorDiscordId: "111", arg: "222",
    });
  });

  it("ignores a custom id that is not ours", () => {
    expect(parseCustomId("invite-42")).toBeNull();
    expect(parseCustomId("cw:")).toBeNull();
  });

  /**
   * ⚠️ The button lives on an ephemeral message, so in practice only the
   * actor can press it. This is belt and braces: a custom id is
   * attacker-supplied data the moment anything else can echo one back.
   */
  it("carries the actor so the router can refuse a mismatched presser", () => {
    expect(parseCustomId(confirmId("disband", "111"))!.actorDiscordId).toBe("111");
  });

  it("builds an ephemeral reply with exactly one Confirm button", () => {
    const reply = confirmReply("disband", "111", "Press Confirm to disband — this cannot be undone.");
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toContain("Press Confirm");
    expect(reply.components).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @factions/bot exec vitest run test/confirm.test.ts`
Expected: FAIL — `Cannot find module '../src/commands/confirm.js'`.

- [ ] **Step 3: Write `confirm.ts`**

```ts
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { Reply } from "./types.js";

/**
 * Namespaced so the router claims only its own components (R5): `discord.ts`
 * still answers un-routed ones with a retired pointer, for buttons on
 * messages the pre-plan-1 bot posted.
 *
 * `cw:c:<action>:<actorDiscordId>:<arg>` — 100 characters is Discord's cap,
 * which is why `/found` keeps its draft elsewhere rather than in here.
 */
const PREFIX = "cw";

export function confirmId(action: string, actorDiscordId: string, arg?: string): string {
  return `${PREFIX}:c:${action}:${actorDiscordId}:${arg ?? ""}`;
}

export function modalId(action: string, actorDiscordId: string, arg?: string): string {
  return `${PREFIX}:m:${action}:${actorDiscordId}:${arg ?? ""}`;
}

export type ParsedId = { kind: "c" | "m"; action: string; actorDiscordId: string; arg: string | null };

export function parseCustomId(id: string): ParsedId | null {
  const parts = id.split(":");
  if (parts.length !== 5) return null;
  const [prefix, kind, action, actorDiscordId, arg] = parts;
  if (prefix !== PREFIX || (kind !== "c" && kind !== "m")) return null;
  if (!action || !actorDiscordId) return null;
  return { kind, action, actorDiscordId, arg: arg === "" ? null : arg! };
}

/** The prompt plus one Confirm button. The press is the write (R2). */
export function confirmReply(action: string, actorDiscordId: string, prompt: string, arg?: string): Reply {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(confirmId(action, actorDiscordId, arg)).setLabel("Confirm").setStyle(ButtonStyle.Danger),
  );
  return { content: prompt, components: [row], ephemeral: true };
}
```

Add to `types.ts`, beside `Reply`:

```ts
import type { ActionRowBuilder, ButtonBuilder, StringSelectMenuBuilder, ModalBuilder } from "discord.js";

export type ReplyRow = ActionRowBuilder<ButtonBuilder> | ActionRowBuilder<StringSelectMenuBuilder>;

export type Reply = {
  content?: string;
  embeds?: EmbedBuilder[];
  components?: ReplyRow[];
  /** Set instead of the fields above: the router opens this modal rather than editing a reply. */
  modal?: ModalBuilder;
  ephemeral: true;
};

export type ComponentHandler = (
  ctx: Ctx,
  a: { actorDiscordId: string; arg: string | null; values: string[] },
) => Promise<Reply>;

export type ModalHandler = (
  ctx: Ctx,
  a: { actorDiscordId: string; arg: string | null; field: (name: string) => string },
) => Promise<Reply>;
```

and extend `CommandGroup`:

```ts
export type CommandGroup = {
  command: SlashCommandBuilder | SlashCommandSubcommandsOnlyBuilder;
  specs: CommandSpec[];
  /** Keyed by the action segment of a `cw:c:<action>:…` id. */
  components?: Record<string, ComponentHandler>;
  /** Keyed by the action segment of a `cw:m:<action>:…` id. */
  modals?: Record<string, ModalHandler>;
  /**
   * Component actions whose handler returns a modal instead of a reply.
   *
   * ⚠️ Discord refuses `showModal` on an interaction that has already been
   * acknowledged, so the router must NOT defer these — it calls the handler
   * first and shows the modal it returns. Nothing in this task uses it; it is
   * built here because it is the router's business, and `/found` (Task 7) is
   * the only user.
   */
  modalOpeners?: string[];
};
```

- [ ] **Step 4: Run the test — it passes**

Run: `pnpm --filter @factions/bot exec vitest run test/confirm.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing router test**

Append to `apps/bot/test/route.test.ts`:

```ts
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
    expect(await routeInteraction(ctx, fakeButton("invite-42", "111"))).toBe(false);
  });

  /**
   * ⚠️ Discord refuses `showModal` on an acknowledged interaction, so a
   * modal-opening component must reach its handler with no defer in front
   * of it. Asserted here because the failure is invisible in review and
   * shows up only as a dead button in production.
   */
  it("does not defer a component listed in modalOpeners", async () => {
    const calls: string[] = [];
    const i = fakeButton(confirmId("opener", "111"), "111", calls);
    await handleComponent(ctxWithOpener(), i);
    expect(calls).toContain("showModal");
    expect(calls).not.toContain("deferReply");
  });
});
```

Write `runComponent` and `fakeButton` as local helpers in that file, following the fakes already there for chat input: a minimal object with `isButton()`, `isMessageComponent()`, `customId`, `user.id`, `deferReply`, `editReply`, `values`.

- [ ] **Step 6: Run it and watch it fail**

Run: `pnpm --filter @factions/bot exec vitest run test/route.test.ts`
Expected: FAIL — `routeInteraction` returns `false` for every component.

- [ ] **Step 7: Extend `route.ts`**

```ts
/** A pressed button or a submitted modal whose custom id names someone else. */
const NOT_YOURS = "That button is not yours — run the command yourself.";

export async function handleComponent(ctx: Ctx, i: MessageComponentInteraction): Promise<void> {
  const parsed = parseCustomId(i.customId);
  if (!parsed || parsed.kind !== "c") return;
  // ⚠️ Before the defer: a handler that opens a modal cannot have
  // acknowledged the interaction first (see `modalOpeners`).
  if (MODAL_OPENERS.has(parsed.action) && parsed.actorDiscordId === i.user.id) {
    const opener = COMPONENTS.get(parsed.action);
    if (opener) {
      const reply = await opener(ctx, { actorDiscordId: i.user.id, arg: parsed.arg, values: [] });
      if (reply.modal) { await i.showModal(reply.modal); return; }
      await i.reply({ content: reply.content ?? UNKNOWN, flags: MessageFlags.Ephemeral });
      return;
    }
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  if (parsed.actorDiscordId !== i.user.id) {
    await i.editReply({ content: NOT_YOURS, embeds: [], components: [] });
    return;
  }
  const handler = COMPONENTS.get(parsed.action);
  if (!handler) {
    await i.editReply({ content: UNKNOWN, embeds: [], components: [] });
    return;
  }
  await finish(i, () => handler(ctx, {
    actorDiscordId: i.user.id,
    arg: parsed.arg,
    values: i.isStringSelectMenu() ? i.values : [],
  }), `component ${parsed.action}`);
}
```

`handleModalSubmit` is the same shape with `parsed.kind !== "m"`, `MODALS`, and

```ts
field: (n) => i.fields.getTextInputValue(n),
```

Factor the try/catch that plan 1 put inline in `handleChatInput` into one `finish(i, run, label)` helper and have all three paths use it — the "handler threw after the defer, the player is staring at *thinking…* forever" failure is now three paths, not one. `finish` must also clear `components: []` on every edit, or a failed confirm leaves its button live.

A handler that returns `{ modal }` cannot have been deferred — Discord refuses `showModal` on an acknowledged interaction. So in `handleChatInput` and `handleComponent`, check for a modal-returning spec **before** deferring:

```ts
if (spec.opensModal) {
  const reply = await spec.handler(ctx, inputFor(i));
  if (reply.modal) { await i.showModal(reply.modal); return; }
}
```

`CommandSpec` gains `opensModal?: true`. Only `/found`'s final button and `/vault add` (plan 3) set it.

Extend `routeInteraction`:

```ts
if (interaction.isMessageComponent()) {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || parsed.kind !== "c") return false;   // R5: not ours, leave it
  await handleComponent(ctx, interaction);
  return true;
}
if (interaction.isModalSubmit()) {
  const parsed = parseCustomId(interaction.customId);
  if (!parsed || parsed.kind !== "m") return false;
  await handleModalSubmit(ctx, interaction);
  return true;
}
```

In `index.ts`:

```ts
export const COMPONENTS: Map<string, ComponentHandler> = new Map(
  GROUPS.flatMap((g) => Object.entries(g.components ?? {})),
);
export const MODALS: Map<string, ModalHandler> = new Map(
  GROUPS.flatMap((g) => Object.entries(g.modals ?? {})),
);
export const MODAL_OPENERS: Set<string> = new Set(GROUPS.flatMap((g) => g.modalOpeners ?? []));
```

- [ ] **Step 8: Run the router tests — they pass**

Run: `pnpm --filter @factions/bot exec vitest run test/route.test.ts test/command-registration.test.ts`
Expected: PASS. `command-registration.test.ts` must still pass unchanged — the ephemeral grep now covers `confirm.ts` too.

- [ ] **Step 9: Commit**

```bash
git add apps/bot/src/commands apps/bot/test/confirm.test.ts apps/bot/test/route.test.ts
git commit -m "feat(bot): route confirm buttons and modal submits"
```

---

### Task 2: `/me` — your page, and the invites and requests waiting on you

**Files:**
- Create: `apps/bot/src/commands/me.ts`, `apps/bot/src/commands/embeds/me.ts`
- Modify: `apps/bot/src/commands/index.ts` (register `meGroup`)
- Test: `apps/bot/test/commands-me.test.ts`

**Interfaces:**
- Consumes: `Handler`, `AutocompleteSource`, `CommandGroup` (Task 1 shapes).
- Produces: `export const meGroup: CommandGroup` with specs `me show`, `me accept`, `me decline`, `me withdraw`; `export function meEmbed(v: Viewer, a: Attention, invites: MyInvite[], requests: MyRequest[], siteBaseUrl: string): EmbedBuilder`.
- Roster calls: `viewerFor`, `attention`, `myInvites`, `myRequests`, `acceptInvite`, `declineInvite`, `withdrawRequest`.
- Copy: `discordCopy("accept", …)`, `discordCopy("decline", …)`, `discordCopy("withdraw", …)`.

Relevant types, verbatim:

```ts
type Viewer = {
  link: { dayzId: string; gamertag: string; verifiedAt: Date } | null;
  clan: { id: number; name: string; tag: string; texture: string; status: string; role: Role } | null;
  pending: { id: number; name: string; tag: string } | null;
};
type Attention = { you: number; clan: number };
type MyInvite = { id: number; clanId: number; clanName: string; tag: string; serverId: number; serverName: string; expiresAt: Date };
type MyRequest = { id: number; clanId: number; clanName: string; tag: string; createdAt: Date; expiresAt: Date };
```

`acceptInvite(discordId, inviteId)` returns `AcceptInviteOutcome | "not-linked"`.
`declineInvite(discordId, inviteId)` returns `boolean` — `true` is `"declined"`, `false` is `"gone"`.
`withdrawRequest(discordId, requestId)` returns `boolean` — `true` is `"withdrawn"`, `false` is `"gone"`.

- [ ] **Step 1: Write the failing handler tests**

`apps/bot/test/commands-me.test.ts`. Build a fake `Ctx` whose `roster` is a plain object of stubs — no database, no client:

```ts
import { describe, it, expect } from "vitest";
import { meGroup } from "../src/commands/me.js";
import type { Ctx } from "../src/commands/types.js";

const spec = (path: string) => meGroup.specs.find((s) => s.path === path)!;
const input = (opts: Record<string, string | number | boolean | null> = {}) => ({
  actorDiscordId: "111",
  string: (n: string) => (opts[n] as string) ?? null,
  integer: (n: string) => (opts[n] as number) ?? null,
  boolean: (n: string) => (opts[n] as boolean) ?? null,
  user: (n: string) => (opts[n] as string) ?? null,
});
const ctxWith = (roster: Record<string, unknown>): Ctx =>
  ({ roster, now: new Date("2026-09-13T00:00:00Z"), siteBaseUrl: "https://x" } as unknown as Ctx);

describe("/me accept", () => {
  it("passes the chosen invite id through as a number and renders the table's copy", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ acceptInvite: async (d: string, id: number) => { seen.push([d, id]); return "ok"; } });
    const reply = await spec("me accept").handler(ctx, input({ invite: "42" }));
    expect(seen).toEqual([["111", 42]]);
    expect(reply.ephemeral).toBe(true);
    expect(reply.content).toBe(discordCopy("accept", "ok"));
  });

  it("refuses a non-numeric invite id without calling the roster", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ acceptInvite: async () => { seen.push("ran"); return "ok"; } });
    const reply = await spec("me accept").handler(ctx, input({ invite: "not-a-number" }));
    expect(seen).toEqual([]);
    expect(reply.content).toContain("Pick");
  });

  it("renders every outcome the roster can return", async () => {
    for (const outcome of ["ok", "gone", "already-member", "cooldown", "not-holding", "link-changed", "cap", "not-linked"] as const) {
      const ctx = ctxWith({ acceptInvite: async () => outcome });
      const reply = await spec("me accept").handler(ctx, input({ invite: "1" }));
      expect(reply.content, outcome).toBe(discordCopy("accept", outcome));
    }
  });
});

describe("/me decline and /me withdraw", () => {
  it("maps the boolean the store returns onto the table's two keys", async () => {
    for (const [ok, key] of [[true, "declined"], [false, "gone"]] as const) {
      const ctx = ctxWith({ declineInvite: async () => ok });
      expect((await spec("me decline").handler(ctx, input({ invite: "1" }))).content).toBe(discordCopy("decline", key));
    }
    for (const [ok, key] of [[true, "withdrawn"], [false, "gone"]] as const) {
      const ctx = ctxWith({ withdrawRequest: async () => ok });
      expect((await spec("me withdraw").handler(ctx, input({ request: "1" }))).content).toBe(discordCopy("withdraw", key));
    }
  });
});

describe("/me autocomplete", () => {
  it("offers only this actor's own open invites", async () => {
    const ctx = ctxWith({
      myInvites: async (d: string) => (d === "111"
        ? [{ id: 7, clanId: 1, clanName: "Wolves", tag: "WLF", serverId: 1, serverName: "s", expiresAt: new Date() }]
        : []),
    });
    const choices = await spec("me accept").autocomplete!.invite(ctx, { actorDiscordId: "111", value: "" });
    expect(choices).toEqual([{ name: "Wolves [WLF]", value: "7" }]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @factions/bot exec vitest run test/commands-me.test.ts`
Expected: FAIL — `Cannot find module '../src/commands/me.js'`.

- [ ] **Step 3: Write `embeds/me.ts`**

```ts
import { EmbedBuilder } from "discord.js";
import type { Attention, MyInvite, MyRequest, Viewer } from "@factions/roster";

const GOLD = 0xc8a34a;

/**
 * `/me show` — the site's /me page as a card: who you are, and what is
 * waiting on you. The two counts come from `attention`, the same read the
 * site bar uses, so the number here and the number on the site agree.
 */
export function meEmbed(v: Viewer, a: Attention, invites: MyInvite[], requests: MyRequest[], siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle("You").setURL(`${siteBaseUrl}/me`);

  if (!v.link) {
    return embed.setDescription("No character linked yet. Run `/link start` and pick your character.");
  }
  embed.setDescription(`Playing as **${v.link.gamertag}**.`);

  if (v.clan) embed.addFields({ name: "Clan", value: `**${v.clan.name}** [${v.clan.tag}] — ${v.clan.role}`, inline: false });
  else if (v.pending) embed.addFields({ name: "Clan", value: `Pending at **${v.pending.name}** [${v.pending.tag}] — stand near their base in game.`, inline: false });
  else embed.addFields({ name: "Clan", value: "None. Browse with `/clans list`.", inline: false });

  if (invites.length > 0) {
    embed.addFields({
      name: `Invites (${invites.length})`,
      value: invites.map((i) => `• **${i.clanName}** [${i.tag}] — \`/me accept\` or \`/me decline\``).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  if (requests.length > 0) {
    embed.addFields({
      name: `Your requests (${requests.length})`,
      value: requests.map((r) => `• **${r.clanName}** [${r.tag}] — \`/me withdraw\``).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  if (a.you === 0 && a.clan === 0) embed.setFooter({ text: "Nothing waiting on you." });
  return embed;
}
```

- [ ] **Step 4: Write `me.ts`**

```ts
import { SlashCommandBuilder } from "discord.js";
import { discordCopy } from "@factions/copy";
import { meEmbed } from "./embeds/me.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

/** Slash options are strings so autocomplete can carry a row id; the row id is a number to the roster. */
function idOf(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const show: Handler = async (ctx, input) => {
  const [viewer, attention, invites, requests] = await Promise.all([
    ctx.roster.viewerFor(input.actorDiscordId),
    ctx.roster.attention(input.actorDiscordId),
    ctx.roster.myInvites(input.actorDiscordId),
    ctx.roster.myRequests(input.actorDiscordId),
  ]);
  return { embeds: [meEmbed(viewer, attention, invites, requests, ctx.siteBaseUrl)], ephemeral: true };
};

const accept: Handler = async (ctx, input) => {
  const id = idOf(input.string("invite"));
  if (!id) return { content: "Pick an invite from the list.", ephemeral: true };
  return { content: discordCopy("accept", await ctx.roster.acceptInvite(input.actorDiscordId, id)), ephemeral: true };
};

const decline: Handler = async (ctx, input) => {
  const id = idOf(input.string("invite"));
  if (!id) return { content: "Pick an invite from the list.", ephemeral: true };
  const done = await ctx.roster.declineInvite(input.actorDiscordId, id);
  return { content: discordCopy("decline", done ? "declined" : "gone"), ephemeral: true };
};

const withdraw: Handler = async (ctx, input) => {
  const id = idOf(input.string("request"));
  if (!id) return { content: "Pick a request from the list.", ephemeral: true };
  const done = await ctx.roster.withdrawRequest(input.actorDiscordId, id);
  return { content: discordCopy("withdraw", done ? "withdrawn" : "gone"), ephemeral: true };
};

/** `myInvites` is already scoped to the actor — there is no wider list to leak. */
const invites: AutocompleteSource = async (ctx, a) => {
  const rows = await ctx.roster.myInvites(a.actorDiscordId);
  return rows.map((r) => ({ name: `${r.clanName} [${r.tag}]`, value: String(r.id) }));
};

const requests: AutocompleteSource = async (ctx, a) => {
  const rows = await ctx.roster.myRequests(a.actorDiscordId);
  return rows.map((r) => ({ name: `${r.clanName} [${r.tag}]`, value: String(r.id) }));
};

export const meGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("me")
    .setDescription("You: your character, your clan, and what is waiting on you")
    .addSubcommand((s) => s.setName("show").setDescription("Your page"))
    .addSubcommand((s) => s.setName("accept").setDescription("Accept a clan invite")
      .addStringOption((o) => o.setName("invite").setDescription("Which invite").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("decline").setDescription("Decline a clan invite")
      .addStringOption((o) => o.setName("invite").setDescription("Which invite").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("withdraw").setDescription("Withdraw one of your join requests")
      .addStringOption((o) => o.setName("request").setDescription("Which request").setRequired(true).setAutocomplete(true))),
  specs: [
    { path: "me show", handler: show },
    { path: "me accept", handler: accept, autocomplete: { invite: invites } },
    { path: "me decline", handler: decline, autocomplete: { invite: invites } },
    { path: "me withdraw", handler: withdraw, autocomplete: { request: requests } },
  ],
};
```

- [ ] **Step 5: Register the group and run the suite**

Add `meGroup` to `GROUPS` in `commands/index.ts`.
Run: `pnpm --filter @factions/bot exec vitest run test/commands-me.test.ts test/command-registration.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/bot/src/commands apps/bot/test/commands-me.test.ts
git commit -m "feat(bot): /me show, accept, decline, withdraw"
```

---

### Task 3: `/roster` — running the roster

Seven writes, six of them one-liners over `discordCopy`. `transfer` is the first confirm-gated action (R2).

**Files:**
- Create: `apps/bot/src/commands/roster.ts`
- Modify: `apps/bot/src/commands/index.ts`
- Test: `apps/bot/test/commands-roster.test.ts`

**Interfaces:**
- Produces: `export const rosterGroup: CommandGroup` with specs `roster invite|revoke|decide|kick|promote|demote|transfer`, and `components: { transfer: … }`.
- Roster calls and their return shapes:
  - `invite(actor, invitee: { discordId } | { gamertag })` → `{ outcome: InviteOutcome; inviteId: number | null }`
  - `revokeInvite(actor, inviteId)` → `"ok" | "not-permitted" | "gone" | ActorRefusal`
  - `decideRequest(actor, requestId, "accepted" | "declined")` → `DecideRequestOutcome | ActorRefusal`
  - `kick(actor, targetDiscordId)` → `KickOutcome | ActorRefusal`
  - `promote` / `demote(actor, targetDiscordId)` → `SetRoleOutcome | ActorRefusal`
  - `transfer(actor, targetDiscordId)` → `TransferOutcome | ActorRefusal`
- Copy actions: `invite`, `revoke`, `decide`, `kick`, `role` (both promote and demote), `transfer`.
- Autocomplete sources: `suggestGamertags(q, "linked")` for `gamertag`; `clanFor().invitesOut` for `invite`; `clanFor().requestsIn` for `request`. `kick`/`promote`/`demote`/`transfer` take a Discord **user** option — no autocomplete, `input.user("member")`.

- [ ] **Step 1: Write the failing tests**

Cover, at minimum:

```ts
describe("/roster invite", () => {
  it("sends a gamertag as a gamertag ref, not a Discord id", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ invite: async (_a: string, ref: unknown) => { seen.push(ref); return { outcome: "ok", inviteId: 1 }; } });
    await spec("roster invite").handler(ctx, input({ gamertag: "Survivor" }));
    expect(seen).toEqual([{ gamertag: "Survivor" }]);
  });

  it("renders every InviteOutcome from the shared table", async () => {
    for (const o of ["ok", "not-linked", "not-in-clan", "pending", "not-permitted", "already-member",
                     "cooldown", "not-holding", "cap", "invitee-not-linked", "ambiguous-gamertag"] as const) {
      const ctx = ctxWith({ invite: async () => ({ outcome: o, inviteId: null }) });
      expect((await spec("roster invite").handler(ctx, input({ gamertag: "x" }))).content, o).toBe(discordCopy("invite", o));
    }
  });
});

describe("/roster transfer", () => {
  /** R2: the slash command must not write. The button is the write. */
  it("does not call the roster — it asks for a confirm", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ transfer: async () => { seen.push("ran"); return "ok"; } });
    const reply = await spec("roster transfer").handler(ctx, input({ member: "222" }));
    expect(seen).toEqual([]);
    expect(reply.components).toHaveLength(1);
    expect(reply.content).toBe(discordCopy("transfer", "unconfirmed"));
  });

  it("writes when the button is pressed, carrying the target in the custom id", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ transfer: async (a: string, t: string) => { seen.push([a, t]); return "ok"; } });
    const reply = await rosterGroup.components!.transfer(ctx, { actorDiscordId: "111", arg: "222", values: [] });
    expect(seen).toEqual([["111", "222"]]);
    expect(reply.content).toBe(discordCopy("transfer", "ok"));
  });

  it("refuses a press whose custom id lost its target", async () => {
    const ctx = ctxWith({ transfer: async () => "ok" });
    const reply = await rosterGroup.components!.transfer(ctx, { actorDiscordId: "111", arg: null, values: [] });
    expect(reply.content).toContain("Run `/roster transfer`");
  });
});

describe("/roster promote and demote", () => {
  it("shares the one role table", async () => {
    for (const o of ["ok", "not-leader", "target-not-member", "cannot-target-leader", "not-linked", "not-in-clan", "pending"] as const) {
      for (const path of ["roster promote", "roster demote"]) {
        const ctx = ctxWith({ promote: async () => o, demote: async () => o });
        expect((await spec(path).handler(ctx, input({ member: "222" }))).content, `${path} ${o}`).toBe(discordCopy("role", o));
      }
    }
  });
});

describe("/roster autocomplete", () => {
  it("offers outstanding invites, and nothing when the actor has no clan", async () => {
    const ctx = ctxWith({ clanFor: async () => "not-in-clan" });
    expect(await spec("roster revoke").autocomplete!.invite(ctx, { actorDiscordId: "111", value: "" })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @factions/bot exec vitest run test/commands-roster.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `roster.ts`**

```ts
import { SlashCommandBuilder } from "discord.js";
import { discordCopy } from "@factions/copy";
import { confirmReply } from "./confirm.js";
import type { AutocompleteSource, CommandGroup, ComponentHandler, Handler } from "./types.js";

function idOf(raw: string | null): number | null {
  if (!raw) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/** `clanFor` answers a string when the actor has no clan to read; autocomplete then offers nothing. */
async function clanView(ctx: Parameters<Handler>[0], discordId: string) {
  const view = await ctx.roster.clanFor(discordId);
  return typeof view === "string" ? null : view;
}

const invite: Handler = async (ctx, input) => {
  const gamertag = input.string("gamertag");
  if (!gamertag) return { content: "Pick a player from the list.", ephemeral: true };
  const { outcome } = await ctx.roster.invite(input.actorDiscordId, { gamertag });
  return { content: discordCopy("invite", outcome), ephemeral: true };
};

const revoke: Handler = async (ctx, input) => {
  const id = idOf(input.string("invite"));
  if (!id) return { content: "Pick an invite from the list.", ephemeral: true };
  return { content: discordCopy("revoke", await ctx.roster.revokeInvite(input.actorDiscordId, id)), ephemeral: true };
};

const decide: Handler = async (ctx, input) => {
  const id = idOf(input.string("request"));
  if (!id) return { content: "Pick a request from the list.", ephemeral: true };
  const decision = input.boolean("accept") === true ? "accepted" : "declined";
  return { content: discordCopy("decide", await ctx.roster.decideRequest(input.actorDiscordId, id, decision)), ephemeral: true };
};

const kick: Handler = async (ctx, input) => {
  const target = input.user("member");
  if (!target) return { content: "Pick the member to remove.", ephemeral: true };
  return { content: discordCopy("kick", await ctx.roster.kick(input.actorDiscordId, target)), ephemeral: true };
};

const promote: Handler = async (ctx, input) => {
  const target = input.user("member");
  if (!target) return { content: "Pick the member to promote.", ephemeral: true };
  return { content: discordCopy("role", await ctx.roster.promote(input.actorDiscordId, target)), ephemeral: true };
};

const demote: Handler = async (ctx, input) => {
  const target = input.user("member");
  if (!target) return { content: "Pick the officer to demote.", ephemeral: true };
  return { content: discordCopy("role", await ctx.roster.demote(input.actorDiscordId, target)), ephemeral: true };
};

/** R2: no write here. The Confirm button carries the target and does the write. */
const transfer: Handler = async (ctx, input) => {
  const target = input.user("member");
  if (!target) return { content: "Pick the member to hand leadership to.", ephemeral: true };
  return confirmReply("transfer", input.actorDiscordId, discordCopy("transfer", "unconfirmed"), target);
};

const confirmTransfer: ComponentHandler = async (ctx, a) => {
  if (!a.arg) return { content: "That button lost its target. Run `/roster transfer` again.", ephemeral: true };
  return { content: discordCopy("transfer", await ctx.roster.transfer(a.actorDiscordId, a.arg)), ephemeral: true };
};

/** Linked players only: an invite to an unlinked account cannot be accepted. */
const linkedPlayers: AutocompleteSource = async (ctx, a) => {
  if (a.value.trim().length === 0) return [];
  const names = await ctx.roster.suggestGamertags(a.value.slice(0, 64), "linked");
  return names.map((n) => ({ name: n, value: n }));
};

const invitesOut: AutocompleteSource = async (ctx, a) => {
  const view = await clanView(ctx, a.actorDiscordId);
  return (view?.invitesOut ?? []).map((i) => ({ name: i.inviteeGamertag ?? i.inviteeDiscordId, value: String(i.id) }));
};

const requestsIn: AutocompleteSource = async (ctx, a) => {
  const view = await clanView(ctx, a.actorDiscordId);
  return (view?.requestsIn ?? []).map((r) => ({ name: r.gamertag ?? r.discordId, value: String(r.id) }));
};

export const rosterGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("roster")
    .setDescription("Your clan's roster")
    .addSubcommand((s) => s.setName("invite").setDescription("Invite a linked player")
      .addStringOption((o) => o.setName("gamertag").setDescription("Their in-game name").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("revoke").setDescription("Withdraw an invite you sent")
      .addStringOption((o) => o.setName("invite").setDescription("Which invite").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("decide").setDescription("Accept or decline a join request")
      .addStringOption((o) => o.setName("request").setDescription("Which request").setRequired(true).setAutocomplete(true))
      .addBooleanOption((o) => o.setName("accept").setDescription("Accept it (leave off to decline)").setRequired(true)))
    .addSubcommand((s) => s.setName("kick").setDescription("Remove a member")
      .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true)))
    .addSubcommand((s) => s.setName("promote").setDescription("Promote a member to officer")
      .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true)))
    .addSubcommand((s) => s.setName("demote").setDescription("Demote an officer to member")
      .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true)))
    .addSubcommand((s) => s.setName("transfer").setDescription("Hand leadership to another full member")
      .addUserOption((o) => o.setName("member").setDescription("Who").setRequired(true))),
  specs: [
    { path: "roster invite", handler: invite, autocomplete: { gamertag: linkedPlayers } },
    { path: "roster revoke", handler: revoke, autocomplete: { invite: invitesOut } },
    { path: "roster decide", handler: decide, autocomplete: { request: requestsIn } },
    { path: "roster kick", handler: kick },
    { path: "roster promote", handler: promote },
    { path: "roster demote", handler: demote },
    { path: "roster transfer", handler: transfer },
  ],
  components: { transfer: confirmTransfer },
};
```

- [ ] **Step 4: Register, run, commit**

Add `rosterGroup` to `GROUPS`.
Run: `pnpm --filter @factions/bot exec vitest run test/commands-roster.test.ts test/command-registration.test.ts`
Expected: PASS.

```bash
git add apps/bot/src/commands apps/bot/test/commands-roster.test.ts
git commit -m "feat(bot): /roster invite, revoke, decide, kick, promote, demote, transfer"
```

---

### Task 4: `/clan` — the clan page and the leader's settings

**Files:**
- Create: `apps/bot/src/commands/clan.ts`, `apps/bot/src/commands/embeds/clan.ts`
- Modify: `apps/bot/src/commands/index.ts`
- Test: `apps/bot/test/commands-clan.test.ts`

**Interfaces:**
- Produces: `export const clanGroup: CommandGroup` with specs `clan info|leave|rename|recruiting|rebind|disband` and `components: { disband: … }`; `export function clanEmbed(view: ClanView, siteBaseUrl: string): EmbedBuilder`.
- Roster calls: `clanFor` → `ClanView | "not-linked" | "not-in-clan"`; `leave(discordId)` → `LeaveOutcome | "not-in-clan"`; `rename(actor, { name, tag? })` → `RenameOutcome | ActorRefusal | "bad-name" | "bad-tag"`; `setRecruitingPost(actor, { recruiting, playWindow, language, pitch })` → `"ok" | "not-permitted" | ActorRefusal`; `confirmRebind(actor, poleKey)` → `"ok" | "refused" | "too-close" | "no-candidate" | "not-leader" | ActorRefusal`; `disband(actor)` → `"ok" | "not-leader" | "vote-open" | ActorRefusal`.
- Copy actions: `leave`, `rename`, `recruiting`, `rebind`, `disband`, plus `DISBAND_WARNING`.

⚠️ **Coordinates.** `ClanView.clan.base` is the viewer's OWN clan's pole and may be rendered. `ClanView.rebindCandidates` carries `{ poleKey, raisedAt, by }` and no coordinates — render `by` and the time, never the key.

- [ ] **Step 1: Write the failing tests**

```ts
describe("/clan info", () => {
  it("tells an unlinked player to link, without touching the clan read's shape", async () => {
    const ctx = ctxWith({ clanFor: async () => "not-linked" });
    expect((await spec("clan info").handler(ctx, input())).content).toBe(REFUSAL["not-linked"]);
  });

  it("tells a clanless player where to look", async () => {
    const ctx = ctxWith({ clanFor: async () => "not-in-clan" });
    expect((await spec("clan info").handler(ctx, input())).content).toContain("/clans list");
  });
});

describe("clanEmbed", () => {
  /** ⚠️ A rebind candidate names the raiser and the time. Never the pole. */
  it("never renders a pole key or a coordinate for a rebind candidate", () => {
    const view = viewFixture({ rebindCandidates: [{ poleKey: "3021_9944", raisedAt: new Date("2026-09-12T00:00:00Z"), by: "Vasily" }] });
    const json = JSON.stringify(clanEmbed(view, "https://x"));
    expect(json).toContain("Vasily");
    expect(json).not.toContain("3021_9944");
  });

  it("renders the clan's own base, which is the one coordinate a member may see", () => {
    const view = viewFixture({ clan: { ...viewFixture().clan, base: { x: 3021.4, z: 9944.6 } } });
    expect(JSON.stringify(clanEmbed(view, "https://x"))).toContain("3021");
  });
});

describe("/clan disband", () => {
  it("asks for a confirm and shows the warning, without writing", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ disband: async () => { seen.push("ran"); return "ok"; } });
    const reply = await spec("clan disband").handler(ctx, input());
    expect(seen).toEqual([]);
    expect(reply.content).toContain(DISBAND_WARNING);
    expect(reply.content).toContain(discordCopy("disband", "unconfirmed"));
    expect(reply.components).toHaveLength(1);
  });

  it("writes on the press", async () => {
    const ctx = ctxWith({ disband: async () => "ok" });
    expect((await clanGroup.components!.disband(ctx, { actorDiscordId: "111", arg: null, values: [] })).content)
      .toBe(discordCopy("disband", "ok"));
  });
});

describe("/clan rename", () => {
  it("passes the tag through only when one was given", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ rename: async (_a: string, r: unknown) => { seen.push(r); return "ok"; } });
    await spec("clan rename").handler(ctx, input({ name: "Wolves" }));
    await spec("clan rename").handler(ctx, input({ name: "Wolves", tag: "WLF" }));
    expect(seen).toEqual([{ name: "Wolves" }, { name: "Wolves", tag: "WLF" }]);
  });
});

describe("/clan recruiting", () => {
  it("sends the three optional fields as null when they are left off", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ setRecruitingPost: async (_a: string, p: unknown) => { seen.push(p); return "ok"; } });
    await spec("clan recruiting").handler(ctx, input({ open: true }));
    expect(seen).toEqual([{ recruiting: true, playWindow: null, language: null, pitch: null }]);
  });
});

describe("/clan rebind autocomplete", () => {
  it("labels a candidate by who raised it and when, and values it by the pole key", async () => {
    const ctx = ctxWith({ clanFor: async () => viewFixture({
      rebindCandidates: [{ poleKey: "3021_9944", raisedAt: new Date("2026-09-12T00:00:00Z"), by: "Vasily" }],
    }) });
    const [choice] = await spec("clan rebind").autocomplete!.pole(ctx, { actorDiscordId: "111", value: "" });
    expect(choice!.value).toBe("3021_9944");
    expect(choice!.name).toContain("Vasily");
  });
});
```

Write `viewFixture(over)` as a local helper returning a complete `ClanView` with `clan`, `me`, `roster: []`, `invitesOut: []`, `requestsIn: []`, `rebindCandidates: []`, `leadership: { openClaim: null, openVote: null, canClaim: "not-eligible", nextVoteAllowedAt: null, leaderLastSeenAt: null }`, `guestPasses: []`, merged with `over`.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @factions/bot exec vitest run test/commands-clan.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `embeds/clan.ts`**

```ts
import { EmbedBuilder } from "discord.js";
import type { ClanView } from "@factions/roster";
import { when } from "@factions/copy";

const GOLD = 0xc8a34a;

/**
 * `/clan info` — the site's /clan page.
 *
 * ⚠️ `clan.base` is the viewer's own clan's pole and is the ONLY coordinate
 * this card may carry. `rebindCandidates` is deliberately rendered by raiser
 * and time: a pole key is a coordinate in disguise, and this card is read by
 * every rank including a pending member.
 */
export function clanEmbed(view: ClanView, siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`${view.clan.name} [${view.clan.tag}]`)
    .setURL(`${siteBaseUrl}/clan`)
    .setDescription(`You are **${view.me.role}**${view.me.status === "full" ? "" : ` (${view.me.status})`}.`);

  if (view.clan.base) {
    embed.addFields({ name: "Base", value: `${Math.round(view.clan.base.x)}, ${Math.round(view.clan.base.z)}`, inline: true });
  }
  embed.addFields({ name: "Status", value: view.clan.status, inline: true });
  embed.addFields({ name: "Recruiting", value: view.clan.recruiting ? "Yes" : "No", inline: true });

  if (view.roster.length > 0) {
    embed.addFields({
      name: `Roster (${view.roster.length})`,
      value: view.roster.map((r) => `• ${r.gamertag ?? r.discordId} — ${r.role}${r.status === "full" ? "" : ` (${r.status})`}`)
        .join("\n").slice(0, 1024),
      inline: false,
    });
  }
  if (view.requestsIn.length > 0) {
    embed.addFields({ name: `Requests in (${view.requestsIn.length})`, value: "`/roster decide`", inline: true });
  }
  if (view.invitesOut.length > 0) {
    embed.addFields({ name: `Invites out (${view.invitesOut.length})`, value: "`/roster revoke`", inline: true });
  }
  if (view.rebindCandidates.length > 0) {
    embed.addFields({
      name: "Poles your flag was raised at",
      value: view.rebindCandidates.map((c) => `• by ${c.by}, ${when(c.raisedAt)} — \`/clan rebind\``).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  const lead = view.leadership;
  if (lead.openClaim) {
    embed.addFields({ name: "Succession claim open", value: `${lead.openClaim.claimantGamertag} claimed the seat.`, inline: false });
  }
  if (lead.openVote) {
    embed.addFields({
      name: "No-confidence vote open",
      value: `${lead.openVote.ballots} of ${lead.openVote.threshold} needed, nominating ${lead.openVote.nomineeGamertag}.`
        + (lead.openVote.inElectorate && !lead.openVote.myBallot ? " — `/lead ballot`" : ""),
      inline: false,
    });
  }
  return embed;
}
```

- [ ] **Step 4: Write `clan.ts`**

Handlers, in order. `info` renders the embed or the refusal; the four writes are one-liners; `disband` is confirm-gated.

```ts
import { SlashCommandBuilder } from "discord.js";
import { DISBAND_WARNING, REFUSAL, discordCopy } from "@factions/copy";
import { clanEmbed } from "./embeds/clan.js";
import { confirmReply } from "./confirm.js";
import type { AutocompleteSource, CommandGroup, ComponentHandler, Handler } from "./types.js";

const info: Handler = async (ctx, input) => {
  const view = await ctx.roster.clanFor(input.actorDiscordId);
  if (view === "not-linked") return { content: REFUSAL["not-linked"], ephemeral: true };
  if (view === "not-in-clan") return { content: "You are not in a clan. Browse with `/clans list`.", ephemeral: true };
  return { embeds: [clanEmbed(view, ctx.siteBaseUrl)], ephemeral: true };
};

/** R3: the site does not gate Leave behind a checkbox, so neither does Discord. */
const leave: Handler = async (ctx, input) =>
  ({ content: discordCopy("leave", await ctx.roster.leave(input.actorDiscordId)), ephemeral: true });

const rename: Handler = async (ctx, input) => {
  const name = input.string("name");
  if (!name) return { content: "Give the new name.", ephemeral: true };
  const tag = input.string("tag");
  const outcome = await ctx.roster.rename(input.actorDiscordId, tag ? { name, tag } : { name });
  return { content: discordCopy("rename", outcome), ephemeral: true };
};

const recruiting: Handler = async (ctx, input) => {
  const outcome = await ctx.roster.setRecruitingPost(input.actorDiscordId, {
    recruiting: input.boolean("open") === true,
    playWindow: input.string("hours"),
    language: input.string("language"),
    pitch: input.string("pitch"),
  });
  return { content: discordCopy("recruiting", outcome), ephemeral: true };
};

const rebind: Handler = async (ctx, input) => {
  const pole = input.string("pole");
  if (!pole) return { content: "Pick a pole from the list.", ephemeral: true };
  return { content: discordCopy("rebind", await ctx.roster.confirmRebind(input.actorDiscordId, pole)), ephemeral: true };
};

/** R2. The warning is part of the prompt because the button is one press from irreversible. */
const disband: Handler = async (ctx, input) =>
  confirmReply("disband", input.actorDiscordId, `${DISBAND_WARNING}\n\n${discordCopy("disband", "unconfirmed")}`);

const confirmDisband: ComponentHandler = async (ctx, a) =>
  ({ content: discordCopy("disband", await ctx.roster.disband(a.actorDiscordId)), ephemeral: true });

/** ⚠️ Label by raiser and time. The pole key is the VALUE, which Discord never shows. */
const poles: AutocompleteSource = async (ctx, a) => {
  const view = await ctx.roster.clanFor(a.actorDiscordId);
  if (typeof view === "string") return [];
  return view.rebindCandidates.map((c) => ({ name: `raised by ${c.by}`, value: c.poleKey }));
};
```

The builder registers six subcommands: `info`; `leave`; `rename` (`name` required string, `tag` optional string); `recruiting` (`open` required boolean, `hours`/`language`/`pitch` optional strings); `rebind` (`pole` required autocompleted string); `disband`. `components: { disband: confirmDisband }`.

- [ ] **Step 5: Register, run, commit**

Run: `pnpm --filter @factions/bot exec vitest run test/commands-clan.test.ts test/command-registration.test.ts`
Expected: PASS.

```bash
git add apps/bot/src/commands apps/bot/test/commands-clan.test.ts
git commit -m "feat(bot): /clan info, leave, rename, recruiting, rebind, disband"
```

---

### Task 5: `/clans` — the directory, and asking to join

**Files:**
- Create: `apps/bot/src/commands/clans.ts`, `apps/bot/src/commands/embeds/clans.ts`
- Modify: `apps/bot/src/commands/index.ts`
- Test: `apps/bot/test/commands-clans.test.ts`

**Interfaces:**
- Produces: `export const clansGroup: CommandGroup` with specs `clans list|show|join`; `export function directoryEmbed(entries: DirectoryEntry[], siteBaseUrl: string): EmbedBuilder` and `export function clanPageEmbed(page: ClanPage, siteBaseUrl: string): EmbedBuilder`.
- Roster calls: `directory()` → `{ clans: DirectoryEntry[]; flags: { taken: string[]; free: string[] } }`; `clanByTag(tag, viewerDiscordId)` → `ClanPage | null`; `requestJoin(discordId, tag)` → `{ outcome: RequestJoinOutcome | "not-linked" | "no-such-clan"; requestId: number | null }`.
- Copy action: `request`.

⚠️ `ClanPage` is the PUBLIC page. It has no `base` field and must never grow one here — the directory is readable by any player, including one planning a raid.

- [ ] **Step 1: Write the failing tests**

```ts
describe("/clans join", () => {
  it("renders every RequestJoinOutcome from the shared table", async () => {
    for (const o of ["ok", "not-recruiting", "not-holding", "already-member", "cooldown", "cap",
                     "already-requested", "not-linked", "no-such-clan"] as const) {
      const ctx = ctxWith({ requestJoin: async () => ({ outcome: o, requestId: null }) });
      expect((await spec("clans join").handler(ctx, input({ tag: "WLF" }))).content, o).toBe(discordCopy("request", o));
    }
  });
});

describe("/clans show", () => {
  it("says so plainly when no clan has that tag", async () => {
    const ctx = ctxWith({ clanByTag: async () => null });
    expect((await spec("clans show").handler(ctx, input({ tag: "NOPE" }))).content).toBe(discordCopy("request", "no-such-clan"));
  });

  it("passes the viewer through so canRequest is computed for them", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ clanByTag: async (t: string, v: string | null) => { seen.push([t, v]); return null; } });
    await spec("clans show").handler(ctx, input({ tag: "WLF" }));
    expect(seen).toEqual([["WLF", "111"]]);
  });
});

describe("directoryEmbed", () => {
  it("marks recruiting clans and never carries a base", () => {
    const json = JSON.stringify(directoryEmbed([entry({ recruiting: true }), entry({ tag: "OTH", recruiting: false })], "https://x"));
    expect(json).toContain("Recruiting");
    expect(json).not.toMatch(/base/iu);
  });

  it("stays inside Discord's field length with a long directory", () => {
    const many = Array.from({ length: 60 }, (_, n) => entry({ tag: `T${n}`, name: `Clan number ${n}` }));
    for (const f of directoryEmbed(many, "https://x").toJSON().fields ?? []) {
      expect(f.value.length).toBeLessThanOrEqual(1024);
    }
  });
});

describe("/clans autocomplete", () => {
  it("offers tags from the directory, filtered by what was typed", async () => {
    const ctx = ctxWith({ directory: async () => ({ clans: [entry({ tag: "WLF", name: "Wolves" }), entry({ tag: "BER", name: "Bears" })], flags: { taken: [], free: [] } }) });
    const choices = await spec("clans join").autocomplete!.tag(ctx, { actorDiscordId: "111", value: "wo" });
    expect(choices.map((c) => c.value)).toEqual(["WLF"]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @factions/bot exec vitest run test/commands-clans.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the embeds and the group**

`embeds/clans.ts`:

```ts
import { EmbedBuilder } from "discord.js";
import type { ClanPage, DirectoryEntry } from "@factions/roster";

const GOLD = 0xc8a34a;

/**
 * `/clans list`. Recruiting first — `directory()` already returns them in
 * that order, so this does not re-sort and cannot disagree with the site.
 *
 * ⚠️ Public data only. `DirectoryEntry` has no base and must never be joined
 * to one here: this card is readable by anyone, including a raider.
 */
export function directoryEmbed(entries: DirectoryEntry[], siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle("Clans").setURL(`${siteBaseUrl}/clans`);
  if (entries.length === 0) return embed.setDescription("No clans yet.");

  const line = (e: DirectoryEntry) =>
    `• **${e.name}** [${e.tag}] — ${e.memberCount} member${e.memberCount === 1 ? "" : "s"}`
    + (e.alpha ? " · Alpha" : "") + (e.recruiting ? " · Recruiting" : "");

  // One field per 1024-character chunk: Discord rejects a longer field value.
  let chunk: string[] = [];
  let n = 0;
  const flush = () => {
    if (chunk.length === 0) return;
    embed.addFields({ name: n === 0 ? `${entries.length} clans` : "…", value: chunk.join("\n"), inline: false });
    chunk = []; n += 1;
  };
  for (const e of entries) {
    const next = line(e);
    if ([...chunk, next].join("\n").length > 1024) flush();
    chunk.push(next);
  }
  flush();
  embed.setFooter({ text: "`/clans show tag:` for one clan, `/clans join tag:` to ask to join." });
  return embed;
}

/** `/clans show` — one clan's public page. Same fields the site shows a stranger. */
export function clanPageEmbed(page: ClanPage, siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setColor(GOLD)
    .setTitle(`${page.name} [${page.tag}]`)
    .setURL(`${siteBaseUrl}/clans/${page.tag}`)
    .addFields(
      { name: "Members", value: String(page.memberCount), inline: true },
      { name: "Recruiting", value: page.recruiting ? "Yes" : "No", inline: true },
      { name: "Raids / defenses", value: `${page.stats.raids} / ${page.stats.defenses}`, inline: true },
    );
  if (page.pitch) embed.setDescription(page.pitch.slice(0, 2048));
  if (page.playWindow) embed.addFields({ name: "Plays", value: page.playWindow, inline: true });
  if (page.language) embed.addFields({ name: "Language", value: page.language, inline: true });
  if (page.alphaWeeks > 0) embed.addFields({ name: "Alpha weeks", value: String(page.alphaWeeks), inline: true });
  if (page.roster.length > 0) {
    embed.addFields({
      name: "Roster",
      value: page.roster.map((r) => `• ${r.gamertag ?? "—"} — ${r.role}`).join("\n").slice(0, 1024),
      inline: false,
    });
  }
  if (page.canRequest === "yes") embed.setFooter({ text: `Ask to join with /clans join tag: ${page.tag}` });
  return embed;
}
```

`clans.ts` registers `list` (no options), `show` (`tag`, required, autocompleted) and `join` (`tag`, required, autocompleted). `list` calls `directory()` and renders `clans`; `show` calls `clanByTag(tag, actorDiscordId)` and answers `discordCopy("request", "no-such-clan")` on null; `join` calls `requestJoin` and renders `discordCopy("request", outcome)`. The `tag` source reads `directory()` and filters case-insensitively on name **or** tag:

```ts
const tags: AutocompleteSource = async (ctx, a) => {
  const { clans } = await ctx.roster.directory();
  const q = a.value.trim().toLowerCase();
  return clans
    .filter((c) => q === "" || c.tag.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    .map((c) => ({ name: `${c.name} [${c.tag}]${c.recruiting ? " · recruiting" : ""}`, value: c.tag }));
};
```

- [ ] **Step 4: Register, run, commit**

Run: `pnpm --filter @factions/bot exec vitest run test/commands-clans.test.ts test/command-registration.test.ts`
Expected: PASS.

```bash
git add apps/bot/src/commands apps/bot/test/commands-clans.test.ts
git commit -m "feat(bot): /clans list, show, join"
```

---

### Task 6: `/lead` — succession and no-confidence

**Files:**
- Create: `apps/bot/src/commands/lead.ts`
- Modify: `apps/bot/src/commands/index.ts`
- Test: `apps/bot/test/commands-lead.test.ts`

**Interfaces:**
- Produces: `export const leadGroup: CommandGroup` with specs `lead claim|vote|ballot` and `components: { claim: …, vote: … }`.
- Roster calls: `claimSuccession(discordId)` → `ClaimOutcome | ActorRefusal`; `openVote(discordId, nomineeDiscordId)` → `{ outcome: OpenVoteOutcome | ActorRefusal; voteId: number | null }`; `castVote(discordId)` → `CastOutcome | ActorRefusal`.
- Copy: `discordLeadershipCopy("claim-succession" | "open-vote" | "cast-vote", outcome)` — **not** `discordCopy`. These tables live in `leadership.ts` and have their own override map.
- R2 applies to `claim` and `vote`; R3 says `ballot` writes immediately.

- [ ] **Step 1: Write the failing tests**

```ts
describe("/lead claim", () => {
  it("asks first, writes on the press", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ claimSuccession: async () => { seen.push("ran"); return "ok"; } });
    const asked = await spec("lead claim").handler(ctx, input());
    expect(seen).toEqual([]);
    expect(asked.content).toBe(discordLeadershipCopy("claim-succession", "unconfirmed"));
    const pressed = await leadGroup.components!.claim(ctx, { actorDiscordId: "111", arg: null, values: [] });
    expect(seen).toEqual(["ran"]);
    expect(pressed.content).toBe(discordLeadershipCopy("claim-succession", "ok"));
  });

  it("renders every claim outcome", async () => {
    for (const o of ["ok", "claim-open", "is-leader", "not-eligible", "leader-active",
                     "not-member", "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ claimSuccession: async () => o });
      expect((await leadGroup.components!.claim(ctx, { actorDiscordId: "111", arg: null, values: [] })).content, o)
        .toBe(discordLeadershipCopy("claim-succession", o));
    }
  });
});

describe("/lead vote", () => {
  it("carries the nominee through the confirm button", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ openVote: async (a: string, n: string) => { seen.push([a, n]); return { outcome: "ok", voteId: 1 }; } });
    const asked = await spec("lead vote").handler(ctx, input({ nominee: "222" }));
    expect(seen).toEqual([]);
    expect(asked.components).toHaveLength(1);
    await leadGroup.components!.vote(ctx, { actorDiscordId: "111", arg: "222", values: [] });
    expect(seen).toEqual([["111", "222"]]);
  });
});

describe("/lead ballot", () => {
  /** R3: no confirm. The site does not gate casting a ballot either. */
  it("casts immediately", async () => {
    const ctx = ctxWith({ castVote: async () => "passed" });
    expect((await spec("lead ballot").handler(ctx, input())).content).toBe(discordLeadershipCopy("cast-vote", "passed"));
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @factions/bot exec vitest run test/commands-lead.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `lead.ts`**

```ts
import { SlashCommandBuilder } from "discord.js";
import { discordLeadershipCopy } from "@factions/copy";
import { confirmReply } from "./confirm.js";
import type { CommandGroup, ComponentHandler, Handler } from "./types.js";

/** R2. `claimSuccession` is not called until the button is pressed. */
const claim: Handler = async (_ctx, input) =>
  confirmReply("claim", input.actorDiscordId, discordLeadershipCopy("claim-succession", "unconfirmed"));

const confirmClaim: ComponentHandler = async (ctx, a) =>
  ({ content: discordLeadershipCopy("claim-succession", await ctx.roster.claimSuccession(a.actorDiscordId)), ephemeral: true });

const vote: Handler = async (_ctx, input) => {
  const nominee = input.user("nominee");
  if (!nominee) return { content: "Pick who should lead instead.", ephemeral: true };
  return confirmReply("vote", input.actorDiscordId, discordLeadershipCopy("open-vote", "unconfirmed"), nominee);
};

const confirmVote: ComponentHandler = async (ctx, a) => {
  if (!a.arg) return { content: "That button lost its nominee. Run `/lead vote` again.", ephemeral: true };
  const { outcome } = await ctx.roster.openVote(a.actorDiscordId, a.arg);
  return { content: discordLeadershipCopy("open-vote", outcome), ephemeral: true };
};

/** R3: cast straight through, as the site does. */
const ballot: Handler = async (ctx, input) =>
  ({ content: discordLeadershipCopy("cast-vote", await ctx.roster.castVote(input.actorDiscordId)), ephemeral: true });

export const leadGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("lead")
    .setDescription("Succession and no-confidence votes")
    .addSubcommand((s) => s.setName("claim").setDescription("Claim a silent leader's seat"))
    .addSubcommand((s) => s.setName("vote").setDescription("Open a no-confidence vote, nominating a replacement")
      .addUserOption((o) => o.setName("nominee").setDescription("Who should lead instead").setRequired(true)))
    .addSubcommand((s) => s.setName("ballot").setDescription("Cast your ballot in your clan's open vote")),
  specs: [
    { path: "lead claim", handler: claim },
    { path: "lead vote", handler: vote },
    { path: "lead ballot", handler: ballot },
  ],
  components: { claim: confirmClaim, vote: confirmVote },
};
```

- [ ] **Step 4: Register, run, commit**

Run: `pnpm --filter @factions/bot exec vitest run test/commands-lead.test.ts test/command-registration.test.ts`
Expected: PASS.

```bash
git add apps/bot/src/commands apps/bot/test/commands-lead.test.ts
git commit -m "feat(bot): /lead claim, vote, ballot"
```

---

### Task 7: `/found` — flag, crew, name

The one genuinely multi-step interaction in this plan: two select menus, a button, and a modal. Nothing is written until the modal is submitted.

**Files:**
- Create: `apps/bot/src/commands/found.ts`, `apps/bot/src/commands/founding-draft.ts`, `apps/bot/src/commands/embeds/found.ts`
- Modify: `apps/bot/src/commands/index.ts`
- Test: `apps/bot/test/founding-draft.test.ts`, `apps/bot/test/commands-found.test.ts`

**Interfaces:**
- Produces:
  - `export const foundGroup: CommandGroup` — one bare command (`path: "found"`), `components: { "found-flag", "found-crew", "found-name" }`, `modals: { found }`, `modalOpeners: ["found-name"]`.
  - `founding-draft.ts`: `export function putDraft(actorDiscordId: string, d: Draft, now: Date): void`, `export function getDraft(actorDiscordId: string, now: Date): Draft | null`, `export function clearDraft(actorDiscordId: string): void`, `export const DRAFT_TTL_MS = 15 * 60_000`, `export type Draft = { ceremonyId: number; texture: string | null; memberDayzIds: string[] }`.
- Roster calls: `claimContext(discordId)` → `ClaimContext`; `claimCeremony(discordId, ceremonyId, { name, tag, texture, memberDayzIds })`.
- Copy action: `claim`, plus `discordCopy("input", "bad-input")` for a modal that arrives with no draft behind it.

`ClaimContext`, verbatim:

```ts
type ClaimContext = {
  ceremony: { id: number; detectedAt: Date; expiresAt: Date; participants: { dayzId: string; gamertag: string; discordId: string }[] };
  freeFlags: string[];
} | null;
```

The flow, and why each step exists:

1. `/found` reads `claimContext`. Null → "No open ceremony", and stop. Otherwise it seeds a draft (`texture: null`, `memberDayzIds`: every participant) and replies with the ceremony card, a flag select, a crew multi-select, and a **Name it** button.
2. `found-flag` and `found-crew` write the choice into the draft and re-render the same reply, so the player can see what they picked.
3. `found-name` opens the modal — it is in `modalOpeners`, so `route.ts` does not defer it (R2's machinery; Discord refuses `showModal` on an acknowledged interaction).
4. The modal submit reads name and tag from its fields, the flag and crew from the draft, and calls `claimCeremony`. On `"ok"` it clears the draft.

- [ ] **Step 1: Write the failing draft-store test**

`apps/bot/test/founding-draft.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { putDraft, getDraft, clearDraft, DRAFT_TTL_MS } from "../src/commands/founding-draft.js";

const t0 = new Date("2026-09-13T00:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);

describe("founding drafts", () => {
  it("keeps one draft per actor", () => {
    putDraft("111", { ceremonyId: 1, texture: null, memberDayzIds: ["a"] }, t0);
    putDraft("222", { ceremonyId: 2, texture: "Zenit", memberDayzIds: ["b"] }, t0);
    expect(getDraft("111", t0)!.ceremonyId).toBe(1);
    expect(getDraft("222", t0)!.texture).toBe("Zenit");
  });

  /** R4: a stale draft is worse than none — it would found a clan from a ceremony that has since expired. */
  it("forgets a draft older than the TTL", () => {
    putDraft("111", { ceremonyId: 1, texture: null, memberDayzIds: [] }, t0);
    expect(getDraft("111", at(DRAFT_TTL_MS - 1))).not.toBeNull();
    expect(getDraft("111", at(DRAFT_TTL_MS + 1))).toBeNull();
  });

  it("clears on demand, so a founded clan cannot be founded twice from one draft", () => {
    putDraft("111", { ceremonyId: 1, texture: null, memberDayzIds: [] }, t0);
    clearDraft("111");
    expect(getDraft("111", t0)).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @factions/bot exec vitest run test/founding-draft.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `founding-draft.ts`**

```ts
/**
 * `/found`'s in-progress choices (R4).
 *
 * A Discord `custom_id` caps at 100 characters and ten 17-character
 * participant ids do not fit, so the flag and crew live here between the
 * select menus and the modal.
 *
 * ⚠️ This is process memory, and it is safe ONLY because exactly one bot
 * instance may run — a project invariant, not an assumption. Nothing is
 * written from a draft alone: `claimCeremony` re-reads the ceremony, re-checks
 * that the actor is on it, and re-checks the flag is still free. A lost draft
 * (restart, TTL) costs the player one re-run of `/found` and nothing else.
 */
export type Draft = { ceremonyId: number; texture: string | null; memberDayzIds: string[] };

export const DRAFT_TTL_MS = 15 * 60_000;

const drafts = new Map<string, { draft: Draft; at: Date }>();

export function putDraft(actorDiscordId: string, draft: Draft, now: Date): void {
  drafts.set(actorDiscordId, { draft, at: now });
}

export function getDraft(actorDiscordId: string, now: Date): Draft | null {
  const held = drafts.get(actorDiscordId);
  if (!held) return null;
  if (now.getTime() - held.at.getTime() > DRAFT_TTL_MS) { drafts.delete(actorDiscordId); return null; }
  return held.draft;
}

export function clearDraft(actorDiscordId: string): void {
  drafts.delete(actorDiscordId);
}
```

- [ ] **Step 4: Write the failing command tests**

`apps/bot/test/commands-found.test.ts`:

```ts
describe("/found", () => {
  it("says so when there is no open ceremony", async () => {
    const ctx = ctxWith({ claimContext: async () => null });
    const reply = await spec("found").handler(ctx, input());
    expect(reply.content).toContain("ceremony");
    expect(reply.components).toBeUndefined();
  });

  it("seeds a draft with every participant and no flag", async () => {
    const ctx = ctxWith({ claimContext: async () => context() });
    await spec("found").handler(ctx, input());
    expect(getDraft("111", ctx.now)).toEqual({ ceremonyId: 9, texture: null, memberDayzIds: ["a", "b", "c"] });
  });

  it("offers at most 25 flags — Discord rejects a longer select menu", async () => {
    const flags = Array.from({ length: 40 }, (_, n) => `Flag_${n}`);
    const ctx = ctxWith({ claimContext: async () => context({ freeFlags: flags }) });
    const reply = await spec("found").handler(ctx, input());
    const menu = reply.components![0]!.toJSON() as { components: { options: unknown[] }[] };
    expect(menu.components[0]!.options).toHaveLength(25);
  });
});

describe("/found selections", () => {
  it("records the chosen flag without writing anything", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ claimContext: async () => context(), claimCeremony: async () => { seen.push("ran"); return "ok"; } });
    await spec("found").handler(ctx, input());
    await foundGroup.components!["found-flag"]!(ctx, { actorDiscordId: "111", arg: null, values: ["Flag_Zenit"] });
    expect(getDraft("111", ctx.now)!.texture).toBe("Flag_Zenit");
    expect(seen).toEqual([]);
  });

  it("records a pruned crew", async () => {
    const ctx = ctxWith({ claimContext: async () => context() });
    await spec("found").handler(ctx, input());
    await foundGroup.components!["found-crew"]!(ctx, { actorDiscordId: "111", arg: null, values: ["a", "c"] });
    expect(getDraft("111", ctx.now)!.memberDayzIds).toEqual(["a", "c"]);
  });
});

describe("/found modal submit", () => {
  it("sends the draft's flag and crew with the modal's name and tag", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({
      claimContext: async () => context(),
      claimCeremony: async (d: string, id: number, a: unknown) => { seen.push([d, id, a]); return "ok"; },
    });
    await spec("found").handler(ctx, input());
    await foundGroup.components!["found-flag"]!(ctx, { actorDiscordId: "111", arg: null, values: ["Flag_Zenit"] });
    const reply = await foundGroup.modals!.found!(ctx, {
      actorDiscordId: "111", arg: "9", field: (n) => (n === "name" ? "Wolves" : "WLF"),
    });
    expect(seen).toEqual([["111", 9, { name: "Wolves", tag: "WLF", texture: "Flag_Zenit", memberDayzIds: ["a", "b", "c"] }]]);
    expect(reply.content).toBe(discordCopy("claim", "ok"));
  });

  it("clears the draft on success, so one draft cannot found two clans", async () => {
    const ctx = ctxWith({ claimContext: async () => context(), claimCeremony: async () => "ok" });
    await spec("found").handler(ctx, input());
    await foundGroup.components!["found-flag"]!(ctx, { actorDiscordId: "111", arg: null, values: ["Flag_Zenit"] });
    await foundGroup.modals!.found!(ctx, { actorDiscordId: "111", arg: "9", field: () => "x" });
    expect(getDraft("111", ctx.now)).toBeNull();
  });

  it("keeps the draft when the roster refuses, so the player can fix the name", async () => {
    const ctx = ctxWith({ claimContext: async () => context(), claimCeremony: async () => "name-taken" });
    await spec("found").handler(ctx, input());
    await foundGroup.components!["found-flag"]!(ctx, { actorDiscordId: "111", arg: null, values: ["Flag_Zenit"] });
    const reply = await foundGroup.modals!.found!(ctx, { actorDiscordId: "111", arg: "9", field: () => "x" });
    expect(reply.content).toBe(discordCopy("claim", "name-taken"));
    expect(getDraft("111", ctx.now)).not.toBeNull();
  });

  it("refuses a submit with no flag chosen, without calling the roster", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ claimContext: async () => context(), claimCeremony: async () => { seen.push("ran"); return "ok"; } });
    await spec("found").handler(ctx, input());
    const reply = await foundGroup.modals!.found!(ctx, { actorDiscordId: "111", arg: "9", field: () => "x" });
    expect(seen).toEqual([]);
    expect(reply.content).toBe(discordCopy("claim", "bad-flag"));
  });

  it("refuses a submit whose draft has expired", async () => {
    const ctx = ctxWith({ claimContext: async () => context(), claimCeremony: async () => "ok" });
    await spec("found").handler(ctx, input());
    const later = { ...ctx, now: new Date(ctx.now.getTime() + DRAFT_TTL_MS + 1) };
    const reply = await foundGroup.modals!.found!(later, { actorDiscordId: "111", arg: "9", field: () => "x" });
    expect(reply.content).toContain("/found");
  });
});
```

`context(over)` returns a `ClaimContext` with `ceremony.id = 9`, three participants `a`/`b`/`c`, and `freeFlags: ["Flag_Zenit", "Flag_Livonia"]`, merged with `over`. Each test that seeds a draft must `clearDraft("111")` in an `afterEach` — the store is module state and leaks between tests otherwise.

- [ ] **Step 5: Run and watch it fail**

Run: `pnpm --filter @factions/bot exec vitest run test/commands-found.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 6: Write `embeds/found.ts` and `found.ts`**

`embeds/found.ts` exports `foundEmbed(c: NonNullable<ClaimContext>, draft: Draft, siteBaseUrl: string): EmbedBuilder` — the ceremony's participants, the chosen flag (or "not chosen yet"), the crew count, and `when(c.ceremony.expiresAt)`.

`found.ts`:

```ts
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, SlashCommandBuilder, StringSelectMenuBuilder, TextInputBuilder, TextInputStyle } from "discord.js";
import { CLAN_NAME_LENGTH, CLAN_TAG_LENGTH } from "@factions/domain";
import { discordCopy } from "@factions/copy";
import { confirmId, modalId } from "./confirm.js";
import { clearDraft, getDraft, putDraft, type Draft } from "./founding-draft.js";
import { foundEmbed } from "./embeds/found.js";
import type { CommandGroup, ComponentHandler, Ctx, Handler, ModalHandler, Reply } from "./types.js";

const NO_CEREMONY = "No open founding ceremony. Get three linked players together at a free pole and the log will spot it.";
const LOST = "That took too long — run `/found` again.";

/** The whole card: ceremony, flag select, crew select, and the Name it button. */
async function screen(ctx: Ctx, actorDiscordId: string, draft: Draft): Promise<Reply> {
  const context = await ctx.roster.claimContext(actorDiscordId);
  if (!context) return { content: NO_CEREMONY, ephemeral: true };

  // ⚠️ 25 is Discord's hard cap on select options; a 26th makes the whole
  // interaction fail, which would take `/found` down entirely for a player
  // in a season with a large free pool.
  const flags = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(confirmId("found-flag", actorDiscordId))
      .setPlaceholder(draft.texture ?? "Pick your flag")
      .addOptions(context.freeFlags.slice(0, 25).map((f) => ({ label: f, value: f, default: f === draft.texture }))),
  );
  const crew = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(confirmId("found-crew", actorDiscordId))
      .setPlaceholder("Who was really there")
      .setMinValues(1)
      .setMaxValues(Math.min(context.ceremony.participants.length, 25))
      .addOptions(context.ceremony.participants.slice(0, 25).map((p) => ({
        label: p.gamertag, value: p.dayzId, default: draft.memberDayzIds.includes(p.dayzId),
      }))),
  );
  const go = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(confirmId("found-name", actorDiscordId, String(draft.ceremonyId)))
      .setLabel("Name it").setStyle(ButtonStyle.Primary),
  );
  return { embeds: [foundEmbed(context, draft, ctx.siteBaseUrl)], components: [flags, crew, go], ephemeral: true };
}

const found: Handler = async (ctx, input) => {
  const context = await ctx.roster.claimContext(input.actorDiscordId);
  if (!context) return { content: NO_CEREMONY, ephemeral: true };
  const draft: Draft = {
    ceremonyId: context.ceremony.id,
    texture: null,
    memberDayzIds: context.ceremony.participants.map((p) => p.dayzId),
  };
  putDraft(input.actorDiscordId, draft, ctx.now);
  return screen(ctx, input.actorDiscordId, draft);
};

const pickFlag: ComponentHandler = async (ctx, a) => {
  const draft = getDraft(a.actorDiscordId, ctx.now);
  if (!draft) return { content: LOST, ephemeral: true };
  const next = { ...draft, texture: a.values[0] ?? null };
  putDraft(a.actorDiscordId, next, ctx.now);
  return screen(ctx, a.actorDiscordId, next);
};

const pickCrew: ComponentHandler = async (ctx, a) => {
  const draft = getDraft(a.actorDiscordId, ctx.now);
  if (!draft) return { content: LOST, ephemeral: true };
  const next = { ...draft, memberDayzIds: a.values };
  putDraft(a.actorDiscordId, next, ctx.now);
  return screen(ctx, a.actorDiscordId, next);
};

/**
 * ⚠️ Listed in `modalOpeners`, so `route.ts` does NOT defer this one —
 * Discord refuses `showModal` on an interaction that has been acknowledged.
 */
const openNameModal: ComponentHandler = async (ctx, a) => {
  const draft = getDraft(a.actorDiscordId, ctx.now);
  if (!draft) return { content: LOST, ephemeral: true };
  const modal = new ModalBuilder()
    .setCustomId(modalId("found", a.actorDiscordId, String(draft.ceremonyId)))
    .setTitle("Name your clan")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("name").setLabel("Clan name").setStyle(TextInputStyle.Short)
          .setMinLength(CLAN_NAME_LENGTH.min).setMaxLength(CLAN_NAME_LENGTH.max).setRequired(true)),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("tag").setLabel("Tag").setStyle(TextInputStyle.Short)
          .setMinLength(CLAN_TAG_LENGTH.min).setMaxLength(CLAN_TAG_LENGTH.max).setRequired(true)),
    );
  return { modal, ephemeral: true };
};

const submit: ModalHandler = async (ctx, a) => {
  const draft = getDraft(a.actorDiscordId, ctx.now);
  if (!draft) return { content: LOST, ephemeral: true };
  // The flag is the one choice with no sensible default: `claimCeremony`
  // would answer "bad-flag" anyway, so answer it here without the round trip.
  if (!draft.texture) return { content: discordCopy("claim", "bad-flag"), ephemeral: true };

  const outcome = await ctx.roster.claimCeremony(a.actorDiscordId, draft.ceremonyId, {
    name: a.field("name"), tag: a.field("tag"), texture: draft.texture, memberDayzIds: draft.memberDayzIds,
  });
  // Keep the draft on a refusal: the player fixes the name and re-submits
  // without re-picking a flag and a crew.
  if (outcome === "ok") clearDraft(a.actorDiscordId);
  return { content: discordCopy("claim", outcome), ephemeral: true };
};

export const foundGroup: CommandGroup = {
  command: new SlashCommandBuilder().setName("found").setDescription("Found your clan from an open ceremony"),
  specs: [{ path: "found", handler: found }],
  components: { "found-flag": pickFlag, "found-crew": pickCrew, "found-name": openNameModal },
  modals: { found: submit },
  modalOpeners: ["found-name"],
};
```

- [ ] **Step 7: Register, run, commit**

Run: `pnpm --filter @factions/bot exec vitest run test/commands-found.test.ts test/founding-draft.test.ts test/command-registration.test.ts`
Expected: PASS.

```bash
git add apps/bot/src/commands apps/bot/test/commands-found.test.ts apps/bot/test/founding-draft.test.ts
git commit -m "feat(bot): /found — flag, crew and name"
```

---

### Task 8: `/guest`, parity, and the deploy note

`/guest` becomes a real group and `handleGuestCommand` — the last hand-written copy table in the bot — is deleted. Then the parity map is updated and the deploy note written.

**Files:**
- Create: `apps/bot/src/commands/guest.ts`, `apps/bot/test/commands-guest.test.ts`
- Delete: `apps/bot/src/guest-command.ts`, `apps/bot/test/guest-command.test.ts`
- Modify: `apps/bot/src/discord.ts`, `apps/bot/src/commands/index.ts`, `apps/bot/test/parity.test.ts`, `CLAUDE.md`
- Create: `docs/deploy/2026-09-13-discord-commands-2.md`

**Interfaces:**
- Produces: `export const guestGroup: CommandGroup` with specs `guest grant|revoke`.
- Roster calls: `grantGuestPass(discordId, { discordId } | { gamertag })` → `{ outcome: GuestGrantOutcome; passId: number | null }`; `revokeGuestPass(discordId, passId)` → `"ok" | "not-permitted" | "gone" | ActorRefusal`.
- Copy actions: `guest`, `revoke-guest`.
- `OpenGuestPass` is `{ id: number; userDiscordId: string; grantedBy: string; expiresAt: Date }`, read from `clanFor().guestPasses` for the `pass` autocomplete.

⚠️ **This changes `/guest`'s shape.** It was a bare `/guest user:`; it becomes `/guest grant user:` and `/guest revoke pass:`. That is a breaking change to a command players use today, and it is why this task also writes the deploy note.

⚠️ **It also drops the channel requirement.** `handleGuestCommand` resolved the clan from `interaction.channelId` and refused outside a clan channel. `grantGuestPassDbFor` derives the clan from the actor's own membership, so the new command works anywhere — a strictly wider surface with the same permission check, since the actor's officer role is re-derived under the clan's row lock either way.

- [ ] **Step 1: Write the failing tests**

```ts
describe("/guest grant", () => {
  it("prefers the user option and falls back to the gamertag", async () => {
    const seen: unknown[] = [];
    const ctx = ctxWith({ grantGuestPass: async (_a: string, t: unknown) => { seen.push(t); return { outcome: "ok", passId: 1 }; } });
    await spec("guest grant").handler(ctx, input({ user: "222" }));
    await spec("guest grant").handler(ctx, input({ gamertag: "Survivor" }));
    expect(seen).toEqual([{ discordId: "222" }, { gamertag: "Survivor" }]);
  });

  it("asks for one of the two when given neither", async () => {
    const seen: string[] = [];
    const ctx = ctxWith({ grantGuestPass: async () => { seen.push("ran"); return { outcome: "ok", passId: 1 }; } });
    expect((await spec("guest grant").handler(ctx, input())).content).toContain("Pick");
    expect(seen).toEqual([]);
  });

  it("renders every GuestGrantOutcome from the shared table", async () => {
    for (const o of ["ok", "not-permitted", "already-active", "is-member", "self",
                     "target-not-linked", "ambiguous-gamertag", "not-linked", "not-in-clan", "pending"] as const) {
      const ctx = ctxWith({ grantGuestPass: async () => ({ outcome: o, passId: null }) });
      expect((await spec("guest grant").handler(ctx, input({ user: "222" }))).content, o).toBe(discordCopy("guest", o));
    }
  });
});

describe("/guest revoke", () => {
  it("offers the clan's open passes and revokes the chosen one", async () => {
    const ctx = ctxWith({
      clanFor: async () => viewFixture({ guestPasses: [{ id: 3, userDiscordId: "222", grantedBy: "111", expiresAt: new Date() }] }),
      revokeGuestPass: async (_a: string, id: number) => (id === 3 ? "ok" : "gone"),
    });
    const [choice] = await spec("guest revoke").autocomplete!.pass(ctx, { actorDiscordId: "111", value: "" });
    expect(choice!.value).toBe("3");
    expect((await spec("guest revoke").handler(ctx, input({ pass: "3" }))).content).toBe(discordCopy("revoke-guest", "ok"));
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @factions/bot exec vitest run test/commands-guest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `guest.ts`**

```ts
import { SlashCommandBuilder } from "discord.js";
import { discordCopy } from "@factions/copy";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

const grant: Handler = async (ctx, input) => {
  const user = input.user("user");
  const gamertag = input.string("gamertag");
  if (!user && !gamertag) return { content: "Pick a Discord user or type a linked gamertag.", ephemeral: true };
  const target = user ? { discordId: user } : { gamertag: gamertag! };
  const { outcome } = await ctx.roster.grantGuestPass(input.actorDiscordId, target);
  return { content: discordCopy("guest", outcome), ephemeral: true };
};

const revoke: Handler = async (ctx, input) => {
  const raw = input.string("pass");
  const id = raw ? Number(raw) : NaN;
  if (!Number.isInteger(id) || id <= 0) return { content: "Pick a pass from the list.", ephemeral: true };
  return { content: discordCopy("revoke-guest", await ctx.roster.revokeGuestPass(input.actorDiscordId, id)), ephemeral: true };
};

const passes: AutocompleteSource = async (ctx, a) => {
  const view = await ctx.roster.clanFor(a.actorDiscordId);
  if (typeof view === "string") return [];
  return view.guestPasses.map((p) => ({ name: `guest ${p.userDiscordId}`, value: String(p.id) }));
};

export const guestGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("guest")
    .setDescription("Voice guest passes for your clan's channel")
    .addSubcommand((s) => s.setName("grant").setDescription("Give someone a 24h voice guest pass")
      .addUserOption((o) => o.setName("user").setDescription("Who, by Discord account"))
      .addStringOption((o) => o.setName("gamertag").setDescription("Who, by linked in-game name").setAutocomplete(true)))
    .addSubcommand((s) => s.setName("revoke").setDescription("End an open guest pass early")
      .addStringOption((o) => o.setName("pass").setDescription("Which pass").setRequired(true).setAutocomplete(true))),
  specs: [
    { path: "guest grant", handler: grant, autocomplete: { gamertag: linkedPlayers } },
    { path: "guest revoke", handler: revoke, autocomplete: { pass: passes } },
  ],
};
```

`linkedPlayers` is the same `suggestGamertags(q, "linked")` source Task 3 wrote for `/roster invite`. Export it from `roster.ts` and import it here rather than writing it twice.

- [ ] **Step 4: Remove the old command**

In `commands/index.ts`, delete the hand-rolled `/guest` `SlashCommandBuilder` from `buildCommands()` and add `guestGroup` to `GROUPS`.
In `apps/bot/src/discord.ts`, delete the `interaction.commandName === "guest"` branch and the `handleGuestCommand` import.
Delete `apps/bot/src/guest-command.ts` and `apps/bot/test/guest-command.test.ts`.

- [ ] **Step 5: Move 22 writes from PENDING to COMMANDS**

In `apps/bot/test/parity.test.ts`, `COMMANDS` becomes 27 entries and `PENDING` keeps only the 8 `"plan 3"` ones:

```ts
const COMMANDS: Record<string, string> = {
  startLink: "link start", cancelLink: "link cancel", unlink: "link unlink",
  declareSolo: "base declare", releaseSolo: "base release",
  acceptInvite: "me accept", declineInvite: "me decline", withdrawRequest: "me withdraw",
  invite: "roster invite", revokeInvite: "roster revoke", decideRequest: "roster decide",
  kick: "roster kick", promote: "roster promote", demote: "roster demote", transfer: "roster transfer",
  leave: "clan leave", rename: "clan rename", setRecruitingPost: "clan recruiting",
  confirmRebind: "clan rebind", disband: "clan disband",
  requestJoin: "clans join",
  claimSuccession: "lead claim", openVote: "lead vote", castVote: "lead ballot",
  claimCeremony: "found",
  grantGuestPass: "guest grant", revokeGuestPass: "guest revoke",
};

const PENDING: Record<string, string> = {
  addLock: "plan 3", editLock: "plan 3", deleteLock: "plan 3", revealLock: "plan 3",
  confirmLock: "plan 3", rotateLocks: "plan 3", dropPin: "plan 3", deletePin: "plan 3",
};
```

`transfer`, `disband`, `claimSuccession` and `openVote` map to the slash path a player types, even though the write happens on the button — the path is what a player has to know, and `SPECS.has(path)` is still true for each.

- [ ] **Step 6: Run the whole bot suite, then the full gate**

Run: `pnpm --filter @factions/bot test`
Expected: PASS — including `parity.test.ts` with all 22 moved and `command-registration.test.ts` covering nine groups.

Then, and only when nothing else is running:

Run: `pnpm test`
Expected: every package green.

- [ ] **Step 7: Write the deploy note and update CLAUDE.md**

`docs/deploy/2026-09-13-discord-commands-2.md`, following the plan-1 note's structure and correcting nothing this time:

- **No migration.** Nothing here touches `factions_live`'s schema.
- **No new workspace package**, so no `pnpm install` step is strictly required — but run it anyway, because the deploy that skipped it is the one that broke.
- **Order:** stop the bot (`sudo systemctl stop clan-wars-bot` — ⚠️ never `pkill -f "src/main.ts"`, ~15 dayzonelife.com services match), `git pull --ff-only`, `pnpm install`, start, then `journalctl -u clan-wars-bot -n 40 --no-pager` and read for the ready line. `systemctl status` is not evidence: the bot holds no eager connection and every tick is individually try/caught.
- ⚠️ **`/guest` changes shape.** `/guest user:` becomes `/guest grant user:`. Registration is one PUT, so the change is instant and total — say so in the clan channels before deploying, or the first thing officers meet is a command that no longer exists in the form they know.
- **Web is unaffected** — this deploy touches `apps/bot` only. Do not run `deploy-web.sh`.
- **Acceptance** (needs a human in Discord): `/me show` on a linked account; `/me accept` autocompletes an open invite; `/roster invite` autocompletes a linked gamertag; `/clan info` shows your roster and your own base and NOT a rebind candidate's pole; `/clan disband` shows a Confirm button and writes nothing until pressed; `/lead ballot`; `/found` when a ceremony is open; `/guest grant user:`; `/guest revoke` autocompletes. ⚠️ Every one of these replies must be **ephemeral** — a roster, a base and a vault are raid targets.
- **Rollback:** stop, `git checkout <previous sha>`, `pnpm install`, start. The old `buildCommands()` PUT restores the old command list including bare `/guest`. Nothing this deploy writes is unreadable by the old bot.

In `CLAUDE.md`: update the live command list to `/link /base /me /roster /clan /clans /lead /found /guest` plus the two remaining retired stubs, and the test count.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat(bot): /guest grant and revoke; parity map, deploy note"
```

---

## Self-review

**Spec coverage.** Spec §4's plan-2 groups: `/me` (T2), `/clan` (T4), `/roster` (T3), `/clans` (T5), `/found` (T6→T7), `/lead` (T6), `/guest` (T8). §4.1's `/found` modal: T7. §4.2's autocomplete table: every plan-2 row is covered — `/roster invite gamertag` (T3), `/roster revoke invite` (T3), `/roster decide request` (T3), `/me accept|decline invite` (T2), `/me withdraw request` (T2), `/guest revoke pass` (T8), `/clan rebind pole` (T4), `/clans show|join tag` (T5). §4.3's four confirm-gated actions: `disband` (T4), `transfer` (T3), `claim-succession` and `open-vote` (T6). §5's four interaction kinds: chat input and autocomplete already shipped, components and modals in T1. §4.4 (`/map` coordinates), `/vault`, `/player`, `/board` and the flat read commands are plan 3.

**Writes.** 3 (T2) + 7 (T3) + 5 (T4) + 1 (T5) + 3 (T6) + 1 (T7) + 2 (T8) = 22, exactly the entries `parity.test.ts` marks `"plan 2"`.

**Conflicts found and settled while writing.** `/me` and `/clan` had no legal bare form (R1). A confirm button's press had to be the write, or `unconfirmed` would need a Discord-only code path (R2). `/found`'s state did not fit in a `custom_id` (R4). A modal-opening interaction cannot be deferred, which is why `modalOpeners` exists in T1 and is used only by T7 — T1's implementer must build it even though nothing in T1 uses it.

**Type consistency.** `Reply` gains `components` and `modal` in T1 and every later task returns that shape. `ComponentHandler` takes `{ actorDiscordId, arg, values }` everywhere. `confirmReply(action, actorDiscordId, prompt, arg?)` — four parameters, in that order, in T3, T4, T6 and T7. `idOf` appears in T2 and T3; the T3 implementer should import it from `me.ts` rather than re-declare it, and if that reads wrong, move it to a shared `parse.ts` and update both.
