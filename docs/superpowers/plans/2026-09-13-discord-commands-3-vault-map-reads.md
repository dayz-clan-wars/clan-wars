# Discord commands, plan 3 — the vault, the map, the reads, and the end of the stubs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `/vault`, `/map` and the seven read commands, clear the last 8 writes that `apps/bot/test/parity.test.ts` marks `"plan 3"`, and delete `retired-commands.ts` — the last piece of the retirement this design reverses.

**Architecture:** Plans 1 and 2 built everything structural: `makeRoster` (one domain layer, two front doors), `@factions/copy` (one exhaustive outcome table per action, `DISCORD_*_OVERRIDES` for wording only), the `CommandSpec`/`CommandGroup` registry with its bijection test, and a router that handles chat input, autocomplete, message components and modal submits. Plan 3 adds three things the earlier plans did not need: **a slash command that opens a modal** (the router defers chat input today, and Discord refuses `showModal` on an acknowledged interaction), **an embed-length budget** that counts every field including the "+N more" line, and **read commands over `@factions/roster`'s read exports**. No new rules and no new domain code: every string a player sees already exists in `packages/copy`, and every read already backs a page.

**Tech Stack:** TypeScript ESM, discord.js ^14.27.0, vitest, `@factions/roster`, `@factions/copy`, `@factions/domain`.

**Spec:** `docs/superpowers/specs/2026-09-13-discord-command-parity-design.md`
**Predecessors:** `docs/superpowers/plans/2026-09-13-discord-commands-1-foundation.md`, `docs/superpowers/plans/2026-09-13-discord-commands-2-clan.md`

## Global Constraints

- **Every reply is ephemeral, always.** `Reply.ephemeral` is the literal type `true`; there is no public option and there must never be one. `command-registration.test.ts` greps the whole `src/commands` tree for `ephemeral: false` and asserts `route.ts` acknowledges only with `MessageFlags.Ephemeral`. **Every new acknowledgement path added in Task 2 must satisfy that same test** — including the modal-opening path, which does not defer.
- **A vault code never leaves an ephemeral reply body.** Not in a `custom_id` (the client holds it and echoes it back), not in an embed footer, not in an autocomplete label, not in a log line, not in an error message. `/vault reveal` puts the code in `Reply.content` and nowhere else. This is the single sharpest rule in this plan: a leaked code is a raid.
- **No player sees another player's base coordinates.** `/base show`, `/clan info`'s own-base field and `/map pins` are the only places a coordinate may appear, and all three show the viewer's own or their own clan's. `mapState().publicBases` and `.intruders` carry coordinates and **must not be rendered by any command in this plan** — `/map view` answers with a link to the site, which is where that picture is drawn under its own gate.
- **Copy comes from `@factions/copy`.** Never hand-write a player-facing outcome sentence in `apps/bot`. Reach a table through `discordCopy(action, outcome)` / `discordVaultCopy(action, outcome)` / `discordLeadershipCopy(...)`, or `PIN_RESULT_COPY` / `PIN_ICON_LABELS` for the map. If Discord needs different wording, add an override in `packages/copy/src/discord.ts` — do not fork the table.
- **This plan adds a surface, not a capability** (spec §10). If a command appears to need a roster call that does not exist, the command is wrong, not the roster. See R3.
- **`route.ts` is the only file that reads `interaction.*`.** Handlers are pure functions of `(Ctx, CommandInput)` and are unit-testable with no discord.js client.
- **The roster call is the permission check.** A button, a select menu or a modal is never a permission. Every handler re-passes `actorDiscordId` and lets `@factions/roster` re-derive role, clan and eligibility under its own row lock.
- **Test isolation:** run only `pnpm --filter @factions/bot test` (or the package you touched) while working, and always with an explicit Bash `timeout: 600000` — the bot suite takes ~140s and the tool's 2-minute default backgrounds it silently. Never start a second turbo run: concurrent runs share the `factions_test_<package>` databases and each run's `globalSetup` drops the other's.

---

## Rulings made while writing this plan

**R1 — `/map` cannot be invoked bare; the link lives on `/map view`.** Spec §2.2 says "`/map` replies with the link", but Discord has no bare form for a command that declares subcommands (the same constraint that produced plan 2's `/me show` and `/clan info`). `/map view` replies with one line and the site link. Cost if wrong: one extra word to type.

**R2 — `/vault delete` and `/vault rotate` are confirm-button actions.** Both carry an `unconfirmed` string in `VAULT_TABLES` because the site gates them behind a checkbox, but neither `deleteLock` nor `rotateLocks` has an `unconfirmed` outcome — the gate is in the form, not the domain. So Discord follows plan 2's R2 exactly: the slash command replies with the `unconfirmed` copy and a Confirm button, and **the press is the write**. The `unconfirmed` string is used; the (nonexistent) code path is not. Cost if wrong: an extra round trip on two destructive actions, which is the point.

**R3 — `/vault rotate` takes no code, and opens no modal.** Spec §4.1 lists a modal for "`/vault rotate` — when rotating one lock to a chosen code rather than a generated one". No such capability exists: `rotateLocksDb` always calls `randomVaultCode`, `rotateLocks(discordId, lockId | "all")` has no code parameter, and `/api/vault/rotate` sends none. The spec describes a feature neither surface has. Adding one would break the Global Constraint above. `/vault rotate` therefore takes `lock:` (a lock, or every lock) and a Confirm button; the new code is generated, and the player reads it with `/vault reveal`. Cost if wrong: a player who wanted to choose a code must instead delete and re-add the lock — exactly what the site makes them do today.

**R4 — `/vault add` and `/vault edit` carry `minrole:` as a slash choice and the rest in a modal.** discord.js 14.27 modals hold text inputs only, so a role picker cannot live inside one; typing "officer" into a text box is worse than Discord's own choice list. `minrole:` is a required slash option with three choices, and the modal carries name, note and (add only) the code. The chosen role rides to the modal submit in the custom id's `arg`: `cw:m:vault-add:<actor>:<minRole>` for add, and `cw:m:vault-edit:<actor>:<lockId>.<minRole>` for edit — a `.` separator because `:` is the id's own delimiter. `/vault edit`'s modal is **prefilled** with the lock's current name and note, so a player re-gating a lock does not retype its description (the site's form is prefilled the same way, and `editLock` overwrites all three fields regardless). Cost if wrong: one visible option per command, and one more thing the arg encoding has to survive.

**R5 — `/map pin` uses `icon:` choices, not autocomplete.** Spec §4.2 lists the icon as autocompleted from `PIN_ICONS`. It is a fixed list of six with fixed labels in `PIN_ICON_LABELS`; Discord's `addChoices` renders it without a round trip and cannot be empty on a slow query. Cost if wrong: none — a seventh icon means editing one array in two places instead of one, and `map-copy.test.ts` already pins the labels.

**R6 — `/map pins` prints metres, `/map unpin`'s autocomplete prints none.** The pins are the viewer's own clan's, in an ephemeral reply, which is exactly the privacy footing `/base show` already stands on — and `baseEmbed` prints the viewer's own coordinates as metres. So the embed does too. The autocomplete label is different: it is rendered by the client while typing, in a list the player may be screen-sharing, and a pin is trivially re-identified from its icon, note and age. Labels are `<icon label> · <note excerpt> · <age>`, no coordinate. Cost if wrong: a player picks the wrong pin to delete and drops another.

**R7 — The scope of a stats read is one autocompleted `scope:` option.** `StatScope` is `{kind:"all"} | {kind:"season", number} | {kind:"current"}`. Rather than two options (`scope:` plus `season:`) that can contradict each other, `/board`, `/player` and the boards take one optional `scope:` string, autocompleted to `current` (the default), `all`, and one entry per closed season from `ctx.roster.seasons()`. `parseScope` in `commands/parse.ts` is the single place the string becomes a `StatScope`. Cost if wrong: a player typing a season number that has not closed gets the current season's numbers with the scope the read resolved, which every embed prints.

**R8 — The "+N more" line is budgeted (the gap parked at the end of plan 2).** `directoryEmbed` truncates each field to 1024 characters but adds its overflow line without counting it against Discord's 6000-character total, so `/clans list` could be refused above roughly 120 clans. Task 1 builds `embeds/budget.ts` and retrofits `directoryEmbed` onto it before any new list embed is written; every list embed in this plan uses it. Cost if wrong: nothing — the failure it prevents is a command that answers with an API error instead of a card.

**R9 — The retirement fallback is replaced, not deleted outright.** Removing `retired-commands.ts` (Task 7) removes the answer an unrouted chat input or an old DM's button gets. `route.ts` already owns the sentence (`UNKNOWN`); Task 7 moves the fallback into `discord.ts` as one branch that answers any unrouted interaction with `UNKNOWN` plus the site link, rather than leaving nothing behind. Cost if wrong: a player pressing a two-month-old button gets a generic sentence instead of a page-specific one.

---

## File Structure

**Created in `apps/bot/src/commands/`:**
- `embeds/budget.ts` — the 6000-character accountant (R8). One file because six embeds need it and none owns it.
- `vault.ts`, `embeds/vault.ts` — the vault group and its card.
- `map.ts`, `embeds/map.ts` — the map group and its pin list.
- `scoring.ts`, `embeds/scoring.ts` — `/scoreboard`, `/alphas`, `/seasons`, `/warlog`.
- `stats.ts`, `embeds/stats.ts` — `/player`, `/board`, `/achievements`.

**Modified:**
- `commands/types.ts` — `CommandSpec` gains `opensModal?: true` (Task 2).
- `commands/route.ts` — the no-defer modal-opening path for chat input, and in-place updates for select menus (Task 2).
- `commands/parse.ts` — gains `parseScope` (R7).
- `commands/index.ts` — the four new groups; `buildCommands()` stops emitting the retired stubs (Task 7).
- `commands/embeds/clans.ts` — retrofitted onto `budget.ts` (Task 1).
- `commands/found.ts` — its select handlers update in place (Task 2).
- `apps/bot/src/discord.ts` — the retirement fallback becomes the `UNKNOWN` fallback (Task 7).
- `apps/bot/test/parity.test.ts` — the last 8 entries move from `PENDING` to `COMMANDS`; `PENDING` becomes empty (Task 7).
- `apps/bot/test/vocabulary.test.ts` — `retired-commands.ts` leaves `PLAYER_FACING` (Task 7).
- `CLAUDE.md` — the command-surface paragraph, and the retired-stub invariant (Task 7).

**Deleted (Task 7):** `apps/bot/src/retired-commands.ts`, `apps/bot/test/retired-commands.test.ts`.

**Created outside `apps/bot/src`:** `apps/bot/test/commands-e2e.test.ts` (Task 7), `docs/deploy/2026-09-13-discord-commands-3.md` and `docs/acceptance/2026-09-13-discord-commands-3.md` (Task 8).

---

### Task 1: The embed budget, and `/vault list`

Six list embeds land in this plan. Before any of them is written, fix the accounting gap `directoryEmbed` already has (R8) and put every list on the same accountant. Then ship the vault's read, which is the smallest real user of it and carries the lock autocomplete every later vault subcommand needs.

**Files:**
- Create: `apps/bot/src/commands/embeds/budget.ts`
- Create: `apps/bot/src/commands/embeds/vault.ts`
- Create: `apps/bot/src/commands/vault.ts`
- Modify: `apps/bot/src/commands/embeds/clans.ts`
- Modify: `apps/bot/src/commands/index.ts`
- Test: `apps/bot/test/embed-budget.test.ts` (create), `apps/bot/test/commands-vault.test.ts` (create), `apps/bot/test/commands-clans.test.ts` (extend)

**Interfaces:**
- Consumes: `CommandGroup`, `Handler`, `AutocompleteSource`, `Ctx` from `commands/types.js`. `REFUSAL`, `discordVaultCopy`, `VAULT_INTRO` from `@factions/copy` — note `VAULT_INTRO` is **not** currently re-exported from `packages/copy/src/index.ts`; add it to the existing `export { VAULT_TABLES, type VaultAction } from "./vault";` line. `VaultState`, `VaultLockView` and `ActorRefusal` from `@factions/roster`.
- Produces:
  - `budget(spentAlready: number): Budget` in `embeds/budget.ts`, with `EMBED_TOTAL_MAX`, `FIELD_VALUE_MAX`, `MAX_FIELDS`.
  - `vaultEmbed(state: VaultState, siteBaseUrl: string): EmbedBuilder` in `embeds/vault.ts`.
  - `vaultGroup: CommandGroup` in `vault.ts`, registering `/vault list` only. Handlers call `ctx.roster.vaultFor` directly — no local wrapper (P1). Later tasks add subcommands to the same builder and the same `specs` array.
  - `locks: AutocompleteSource` exported from `vault.ts`, reused by Tasks 2 and 3.

- [ ] **Step 1: Write the failing budget test**

`apps/bot/test/embed-budget.test.ts`:

```ts
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
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @factions/bot test embed-budget` with Bash `timeout: 600000`.
Expected: FAIL — `Cannot find module '../src/commands/embeds/budget.js'`.

- [ ] **Step 3: Write `embeds/budget.ts`**

```ts
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
```

- [ ] **Step 4: Run the budget test again**

Run: `pnpm --filter @factions/bot test embed-budget` with Bash `timeout: 600000`.
Expected: PASS, 5 tests.

- [ ] **Step 5: Retrofit `directoryEmbed` onto the budget**

Replace the whole body of `directoryEmbed` in `apps/bot/src/commands/embeds/clans.ts`, keeping `FOOTER_TEXT`, `TITLE`, `line()` and the `⚠️ Public data only` comment exactly as they are, and deleting the local `MAX_FIELDS`/`MAX_TOTAL` constants and the long comment above them (the reasoning now lives in `budget.ts`):

```ts
export function directoryEmbed(entries: DirectoryEntry[], siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(TITLE).setURL(`${siteBaseUrl}/clans`);
  if (entries.length === 0) return embed.setDescription("No clans yet.");

  const line = (e: DirectoryEntry) =>
    `• **${e.name}** [${e.tag}] — ${e.memberCount} member${e.memberCount === 1 ? "" : "s"}`
    + (e.alpha ? " · Alpha" : "") + (e.recruiting ? " · Recruiting" : "");

  budget(TITLE.length + FOOTER_TEXT.length).list(
    embed,
    `${entries.length} clans`,
    entries.map(line),
    (n) => `+${n} more — see the site.`,
  );
  embed.setFooter({ text: FOOTER_TEXT });
  return embed;
}
```

Add `import { budget } from "./budget.js";` at the top.

- [ ] **Step 6: Add the regression test for the case that used to overflow**

Append to `apps/bot/test/commands-clans.test.ts`:

```ts
it("keeps /clans list inside Discord's embed cap at four thousand clans", () => {
  const entries = Array.from({ length: 4000 }, (_, i) => ({
    tag: `T${i}`, name: `Clan ${i}`, texture: "wolf", memberCount: 8, recruiting: i % 2 === 0, alpha: false,
  })) as Parameters<typeof directoryEmbed>[0];
  const j = directoryEmbed(entries, "https://x").toJSON();
  const total = (j.title?.length ?? 0) + (j.description?.length ?? 0) + (j.footer?.text.length ?? 0)
    + (j.fields ?? []).reduce((s, f) => s + f.name.length + f.value.length, 0);
  expect(total).toBeLessThanOrEqual(6000);
  expect((j.fields ?? []).at(-1)!.value).toMatch(/^\+\d+ more/u);
});
```

Import `directoryEmbed` from `../src/commands/embeds/clans.js` if the file does not already.

- [ ] **Step 7: Run the clans tests**

Run: `pnpm --filter @factions/bot test commands-clans` with Bash `timeout: 600000`.
Expected: PASS, existing cases plus the new one.

- [ ] **Step 8: Commit the budget**

```bash
git add apps/bot/src/commands/embeds/budget.ts apps/bot/src/commands/embeds/clans.ts apps/bot/test/embed-budget.test.ts apps/bot/test/commands-clans.test.ts
git commit -m "fix(bot): budget the '+N more' line against Discord's 6000-char embed cap"
```

- [ ] **Step 9: Write the failing `/vault list` test**

`apps/bot/test/commands-vault.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { VAULT_INTRO } from "@factions/copy";
import { locks, vaultGroup } from "../src/commands/vault.js";
import { ctxWith, input, specOf } from "./command-fakes.js";
import type { VaultLockView, VaultState } from "@factions/roster";

const lock = (over: Partial<VaultLockView> = {}): VaultLockView => ({
  id: 1, name: "Front gate", note: "the big one", minRole: "member",
  createdAt: new Date("2026-09-01T00:00:00Z"), createdBy: "Ada",
  rotatedAt: null, rotatedBy: null, confirmedAt: null, changedInGame: false, exposed: false,
  ...over,
});
const state = (over: Partial<VaultState> = {}): VaultState => ({ locks: [lock()], history: null, ...over });

describe("/vault list", () => {
  it("refuses a player with no link, in the shared words", async () => {
    const ctx = ctxWith({ vaultFor: async () => "not-linked" });
    const reply = await specOf(vaultGroup, "vault list").handler(ctx, input());
    expect(reply.content).toMatch(/Link your character first/u);
    expect(reply.embeds).toBeUndefined();
    expect(reply.ephemeral).toBe(true);
  });

  it("renders the locks the rank may see, and the standing warning", async () => {
    const ctx = ctxWith({ vaultFor: async () => state() });
    const reply = await specOf(vaultGroup, "vault list").handler(ctx, input());
    const j = reply.embeds![0].toJSON();
    expect(j.description).toBe(VAULT_INTRO);
    expect(JSON.stringify(j.fields)).toContain("Front gate");
  });

  /** ⚠️ The one thing this card may never contain. `VaultLockView` carries no code — keep it that way. */
  it("never prints a code", async () => {
    const ctx = ctxWith({ vaultFor: async () => state({ locks: [lock({ name: "1234" })] }) });
    const reply = await specOf(vaultGroup, "vault list").handler(ctx, input());
    expect(JSON.stringify(reply.embeds![0].toJSON())).not.toMatch(/\bcode\b\s*[:=]/iu);
  });

  it("shows history to a leader and nothing to anyone else", async () => {
    const withHistory = state({ history: [{ at: new Date("2026-09-02T00:00:00Z"), action: "rotated", lockName: "Front gate", by: "Ada" }] });
    const leader = await specOf(vaultGroup, "vault list").handler(ctxWith({ vaultFor: async () => withHistory }), input());
    expect(JSON.stringify(leader.embeds![0].toJSON().fields)).toContain("rotated");
    const member = await specOf(vaultGroup, "vault list").handler(ctxWith({ vaultFor: async () => state() }), input());
    expect(JSON.stringify(member.embeds![0].toJSON().fields ?? [])).not.toContain("rotated");
  });

  it("says so plainly when the vault is empty", async () => {
    const ctx = ctxWith({ vaultFor: async () => state({ locks: [] }) });
    const reply = await specOf(vaultGroup, "vault list").handler(ctx, input());
    expect(reply.embeds![0].toJSON().fields ?? []).toEqual([]);
  });
});

describe("/vault lock autocomplete", () => {
  it("offers only the locks the roster returned, filtered by what was typed", async () => {
    const ctx = ctxWith({ vaultFor: async () => state({ locks: [lock({ id: 1, name: "Front gate" }), lock({ id: 2, name: "Back shed" })] }) });
    expect(await locks(ctx, { actorDiscordId: "111", value: "back" })).toEqual([{ name: "Back shed", value: "2" }]);
  });

  it("offers nothing rather than throwing when the actor cannot see a vault", async () => {
    const ctx = ctxWith({ vaultFor: async () => "not-in-clan" });
    expect(await locks(ctx, { actorDiscordId: "111", value: "" })).toEqual([]);
  });
});
```

⚠️ `locks` is called directly, not through `sourceOf`: no subcommand carries a `lock:` option until Task 2, and `sourceOf` looks a source up off a registered spec. Import it as `import { locks, vaultGroup } from "../src/commands/vault.js";`. From Task 2 onward the same source is also reachable as `sourceOf(vaultGroup, "vault edit", "lock")`, and one test there should use that form so the wiring itself is covered.

- [ ] **Step 10: Run it and watch it fail**

Run: `pnpm --filter @factions/bot test commands-vault` with Bash `timeout: 600000`.
Expected: FAIL — `Cannot find module '../src/commands/vault.js'`.

- [ ] **Step 11: Write `embeds/vault.ts`**

```ts
import { EmbedBuilder } from "discord.js";
import type { VaultLockView, VaultState } from "@factions/roster";
import { VAULT_INTRO, when } from "@factions/copy";
import { budget } from "./budget.js";

const GOLD = 0xc8a34a;
const TITLE = "Vault";
const FOOTER_TEXT = "`/vault reveal lock:` shows a code — only to you.";

/** "Front gate — officer+ · the big one" plus whatever needs attention. */
function lockLine(l: VaultLockView): string {
  const marks = [
    l.changedInGame ? "⚠️ changed in game" : null,
    l.exposed ? "⚠️ exposed" : null,
  ].filter((m): m is string => m !== null);
  return `• **${l.name}** — ${l.minRole}+`
    + (l.note ? ` · ${l.note}` : "")
    + (marks.length > 0 ? ` · ${marks.join(" · ")}` : "");
}

/**
 * `/vault list`.
 *
 * ⚠️ `VaultState` carries no code and this card must never gain a field that
 * could hold one. `vaultFor` has already filtered `locks` to the ranks the
 * viewer may see, and `history` is null for anyone but the leader — neither
 * is re-filtered here, because re-deriving a permission in the bot is the
 * mistake the whole design exists to prevent.
 */
export function vaultEmbed(state: VaultState, siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(TITLE).setURL(`${siteBaseUrl}/clan/vault`)
    .setDescription(VAULT_INTRO).setFooter({ text: FOOTER_TEXT });
  const b = budget(TITLE.length + VAULT_INTRO.length + FOOTER_TEXT.length);

  b.list(embed, `${state.locks.length} lock${state.locks.length === 1 ? "" : "s"}`,
    state.locks.map(lockLine), (n) => `+${n} more — see the site.`);

  if (state.history && state.history.length > 0) {
    b.list(embed, "Recent changes",
      state.history.map((h) => `• ${when(h.at)} — ${h.lockName} ${h.action} by ${h.by}`),
      (n) => `+${n} more — see the site.`);
  }
  return embed;
}
```

⚠️ Check `when`'s signature in `packages/copy/src/format.ts` before using it; if it does not take a bare `Date`, format the timestamp with whatever the other embeds in `apps/bot/src/commands/embeds/` already use and do not invent a new formatter.

- [ ] **Step 12: Write `vault.ts` with `/vault list` and the shared lock source**

```ts
import { SlashCommandBuilder } from "discord.js";
import { REFUSAL } from "@factions/copy";
import { vaultEmbed } from "./embeds/vault.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

/**
 * ⚠️ `vaultFor` IS the permission check, on every subcommand that needs one:
 * it rank-filters the locks and returns a refusal string for a player who is
 * unlinked, clanless or pending. A refusal is a sentence, never an empty
 * card, so each handler narrows with `typeof state === "string"` and answers
 * from `REFUSAL`.
 */
const list: Handler = async (ctx, input) => {
  const state = await ctx.roster.vaultFor(input.actorDiscordId);
  if (typeof state === "string") return { content: REFUSAL[state], ephemeral: true };
  return { embeds: [vaultEmbed(state, ctx.siteBaseUrl)], ephemeral: true };
};

/**
 * The `lock:` option on every other vault subcommand.
 *
 * ⚠️ Labels carry the name and the rank gate, never a code — `VaultLockView`
 * has no code field, and nothing here may join one on. An actor who cannot
 * see a vault at all gets an empty list rather than an error: Discord shows
 * "no options match", which is the truthful answer.
 */
export const locks: AutocompleteSource = async (ctx, a) => {
  const state = await ctx.roster.vaultFor(a.actorDiscordId);
  if (typeof state === "string") return [];
  const q = a.value.trim().toLowerCase();
  return state.locks
    .filter((l) => q === "" || l.name.toLowerCase().includes(q))
    .map((l) => ({ name: l.name, value: String(l.id) }));
};

export const vaultGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("vault")
    .setDescription("Your clan's lock codes")
    .addSubcommand((s) => s.setName("list").setDescription("The locks your rank may see")),
  specs: [
    { path: "vault list", handler: list },
  ],
};
```

- [ ] **Step 13: Register the group**

In `apps/bot/src/commands/index.ts`, add `import { vaultGroup } from "./vault.js";` and append `vaultGroup` to `GROUPS`.

- [ ] **Step 14: Run the vault tests and the registration test**

Run: `pnpm --filter @factions/bot test commands-vault command-registration` with Bash `timeout: 600000`.
Expected: PASS.

- [ ] **Step 15: Typecheck and run the whole bot suite**

Run: `pnpm --filter @factions/bot typecheck && pnpm --filter @factions/bot test` with Bash `timeout: 600000`.
Expected: both clean. ⚠️ Typecheck is part of the gate, not an afterthought — CI runs `turbo run typecheck test`, and a vitest-only pass has hidden `tsc` failures on this branch before.

- [ ] **Step 16: Commit**

```bash
git add apps/bot/src/commands/vault.ts apps/bot/src/commands/embeds/vault.ts apps/bot/src/commands/index.ts apps/bot/test/commands-vault.test.ts packages/copy/src/index.ts
git commit -m "feat(bot): /vault list"
```

---

### Task 2: A slash command that opens a modal, select menus that update in place, and `/vault add` / `/vault edit`

Two router changes and the two vault writes that need them. The router half comes first because `/vault add` cannot exist without it: `handleChatInput` defers every chat input, and Discord refuses `showModal` on an interaction that has already been acknowledged — the same constraint `modalOpeners` solved for buttons in plan 2, now needed one level up.

The second router change is the defect plan 2 shipped knowingly: `/found`'s select menus reply with `deferReply` + `editReply`, so every flag or crew pick stacks a **new** ephemeral card underneath the old one instead of updating the card the player is looking at.

**Files:**
- Modify: `apps/bot/src/commands/types.ts`
- Modify: `apps/bot/src/commands/route.ts`
- Modify: `apps/bot/src/commands/index.ts`
- Modify: `apps/bot/src/commands/found.ts`
- Modify: `apps/bot/src/commands/vault.ts`
- Test: `apps/bot/test/route.test.ts` (extend), `apps/bot/test/commands-vault.test.ts` (extend)

**Interfaces:**
- Consumes: `Reply.modal`, `modalId`, `confirmId`, `parseCustomId`, `MODAL_OPENERS`, `COMPONENTS`, `MODALS` from plan 2. `locks` from Task 1. `VAULT_NAME_MAX`, `VAULT_NOTE_MAX` from `@factions/roster`; `VAULT_CODE_DIGITS` from `@factions/domain`.
- Produces:
  - `CommandSpec.opensModal?: true` — the router does not defer this spec; its handler returns `{ modal }`.
  - `CommandGroup.updatesInPlace?: string[]` and `index.ts`'s `UPDATERS: Set<string>` — component actions the router acknowledges with `deferUpdate()` so the reply edits the card the component sits on.
  - `roleOf(raw: string | null): Role | null` in `commands/parse.ts`.
  - `/vault add` and `/vault edit` on `vaultGroup`, with modal handlers keyed `vault-add` and `vault-edit`.

- [ ] **Step 1: Write the failing router tests**

Append to `apps/bot/test/route.test.ts`, following the fake-interaction style the file already uses:

```ts
describe("a slash command that opens a modal", () => {
  it("shows the modal without deferring first", async () => {
    // ⚠️ The whole point. Discord refuses showModal on an acknowledged
    // interaction, so a deferReply here makes /vault add answer with
    // nothing at all, forever, with no error a player can see.
    const calls: string[] = [];
    const modal = new ModalBuilder().setCustomId("cw:m:x:111:").setTitle("t");
    SPECS.set("t opener", { path: "t opener", handler: async () => ({ modal, ephemeral: true }), opensModal: true });
    const i = fakeChatInput({ commandName: "t", subcommand: "opener", userId: "111", calls });
    await handleChatInput(ctx, i);
    expect(calls).toEqual(["showModal"]);
    SPECS.delete("t opener");
  });

  it("falls back to an ephemeral reply when the handler returns no modal", async () => {
    const calls: string[] = [];
    SPECS.set("t opener", { path: "t opener", handler: async () => ({ content: "nope", ephemeral: true }), opensModal: true });
    const i = fakeChatInput({ commandName: "t", subcommand: "opener", userId: "111", calls });
    await handleChatInput(ctx, i);
    expect(calls).toEqual(["reply"]);
    SPECS.delete("t opener");
  });
});

describe("a select menu that updates in place", () => {
  it("acknowledges with deferUpdate so the card is edited, not duplicated", async () => {
    const calls: string[] = [];
    COMPONENTS.set("t-pick", async () => ({ content: "picked", ephemeral: true }));
    UPDATERS.add("t-pick");
    const i = fakeComponent({ customId: confirmId("t-pick", "111"), userId: "111", calls });
    await handleComponent(ctx, i);
    expect(calls).toEqual(["deferUpdate", "editReply"]);
    COMPONENTS.delete("t-pick"); UPDATERS.delete("t-pick");
  });

  it("still defers a plain confirm button as a new ephemeral reply", async () => {
    const calls: string[] = [];
    COMPONENTS.set("t-press", async () => ({ content: "done", ephemeral: true }));
    const i = fakeComponent({ customId: confirmId("t-press", "111"), userId: "111", calls });
    await handleComponent(ctx, i);
    expect(calls).toEqual(["deferReply", "editReply"]);
    COMPONENTS.delete("t-press");
  });
});
```

⚠️ `fakeChatInput`/`fakeComponent` may not exist under those names — read `apps/bot/test/route.test.ts` first and use whatever fakes it already builds, extending them with a `calls` log if they do not record one. Do not add a second, parallel set of fakes.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @factions/bot test route` with Bash `timeout: 600000`.
Expected: FAIL — `UPDATERS` is not exported, and `opensModal` is not a property of `CommandSpec`.

- [ ] **Step 3: Add the two declarations to `types.ts`**

On `CommandSpec`:

```ts
  /**
   * The handler returns `{ modal }` and the router must NOT defer.
   *
   * ⚠️ Discord refuses `showModal` on an interaction that has already been
   * acknowledged, and a deferred interaction is acknowledged. A spec marked
   * this way therefore has ~3 seconds total: one indexed read before
   * building the modal is fine, a chain of them is not.
   */
  opensModal?: true;
```

On `CommandGroup`:

```ts
  /**
   * Component actions whose reply should EDIT the message the component sits
   * on rather than post a new ephemeral one — select menus that refine a
   * card in place.
   *
   * ⚠️ Without this the router defers a fresh reply per interaction, so a
   * player who picks a flag and then a crew ends up looking at three copies
   * of the same card, only the last of which is current.
   */
  updatesInPlace?: string[];
```

- [ ] **Step 4: Export `UPDATERS` from `index.ts`**

```ts
export const UPDATERS: Set<string> = new Set(GROUPS.flatMap((g) => g.updatesInPlace ?? []));
```

Placed beside `MODAL_OPENERS`, and covered by the same comment about staying mutable for tests.

- [ ] **Step 5: Teach `route.ts` both paths**

In `handleChatInput`, before the defer:

```ts
export async function handleChatInput(ctx: Ctx, i: ChatInputCommandInteraction): Promise<void> {
  const path = pathOf(i.commandName, i.options.getSubcommand(false));
  const spec = SPECS.get(path);
  if (!spec) return;
  // ⚠️ Before the defer, for the same reason `handleComponent` has this
  // branch: a modal cannot be shown on an acknowledged interaction.
  if (spec.opensModal) {
    const reply = await spec.handler(ctx, inputFor(i));
    if (reply.modal) { await i.showModal(reply.modal); return; }
    // ⚠️ Same invariant as the component opener: a non-modal reply from an
    // opener carries `content` only. Embeds and components are dropped here
    // silently — do not return them from an `opensModal` handler.
    await i.reply({ content: reply.content ?? UNKNOWN, flags: MessageFlags.Ephemeral });
    return;
  }
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  await finish(i, () => spec.handler(ctx, inputFor(i)), `/${path}`);
}
```

⚠️ A throw inside an `opensModal` handler is NOT caught by `finish` — nothing has been acknowledged, so there is no `editReply` to make. `discord.ts`'s outer try/catch logs it and Discord shows the player "This interaction failed". That is the correct outcome (the alternative is acknowledging, which forecloses the modal); do not add a catch here that replies.

In `handleComponent`, replace the single defer with:

```ts
  const inPlace = UPDATERS.has(parsed.action);
  if (inPlace) await i.deferUpdate(); else await i.deferReply({ flags: MessageFlags.Ephemeral });
```

Everything after it — the actor re-check, the handler lookup, `finish` — is unchanged: `editReply` after `deferUpdate` edits the component's own message, which is the whole fix.

⚠️ `command-registration.test.ts` asserts `route.ts` matches `deferReply({ flags: MessageFlags.Ephemeral })` and that no `.reply({` lacks the flag. `deferUpdate()` takes no flags and is not an initial reply — it acknowledges an interaction on a message that is already ephemeral — so it does not weaken that test. Add a case to the ephemeral describe asserting `deferUpdate` appears only in the in-place branch if the reviewer asks; do not relax the existing regexes.

- [ ] **Step 6: Mark `/found`'s selects in place**

In `found.ts`, add to `foundGroup`:

```ts
  // The flag and crew selects refine the card the player is looking at. The
  // "Name it" button is not here: it opens a modal, and a modal opener must
  // not be acknowledged at all.
  updatesInPlace: ["found-flag", "found-crew"],
```

- [ ] **Step 7: Run the router and found tests**

Run: `pnpm --filter @factions/bot test route commands-found` with Bash `timeout: 600000`.
Expected: PASS.

- [ ] **Step 8: Commit the router**

```bash
git add apps/bot/src/commands/types.ts apps/bot/src/commands/route.ts apps/bot/src/commands/index.ts apps/bot/src/commands/found.ts apps/bot/test/route.test.ts
git commit -m "feat(bot): slash commands that open modals, and select menus that update in place"
```

- [ ] **Step 9: Write the failing `/vault add` and `/vault edit` tests**

Append to `apps/bot/test/commands-vault.test.ts`:

```ts
import { modalId } from "../src/commands/confirm.js";

describe("/vault add", () => {
  it("opens a modal and never puts the code on the command line", async () => {
    const reply = await specOf(vaultGroup, "vault add").handler(ctxWith({}), input({ minrole: "officer" }));
    const j = reply.modal!.toJSON();
    expect(j.custom_id).toBe(modalId("vault-add", "111", "officer"));
    const ids = j.components.flatMap((r) => r.components.map((c) => c.custom_id));
    expect(ids).toEqual(["name", "note", "code"]);
    // ⚠️ The option list must not carry a `code` — a slash option is visible
    // while typed and persists in Discord's client-side command history.
    const sub = vaultGroup.command.toJSON().options!.find((o) => o.name === "add")!;
    const opts = (sub as { options?: { name: string }[] }).options ?? [];
    expect(opts.map((o) => o.name)).toEqual(["minrole"]);
  });

  it("refuses a minrole that is not a role, in the shared words", async () => {
    const reply = await specOf(vaultGroup, "vault add").handler(ctxWith({}), input({ minrole: "emperor" }));
    expect(reply.modal).toBeUndefined();
    expect(reply.content).toMatch(/missing or too long/u);
  });

  it("adds the lock the modal described, and answers with the table's words", async () => {
    let got: unknown;
    const ctx = ctxWith({ addLock: async (_id: string, a: unknown) => { got = a; return { outcome: "ok", lockId: 7 }; } });
    const reply = await vaultGroup.modals!["vault-add"](ctx, {
      actorDiscordId: "111", arg: "officer",
      field: (n) => ({ name: "Front gate", note: "the big one", code: "1234" })[n] ?? "",
    });
    expect(got).toEqual({ name: "Front gate", note: "the big one", minRole: "officer", code: "1234" });
    expect(reply.content).toBe("Lock added.");
  });

  it("leaves the code undefined when the field was left blank, so one is generated", async () => {
    let got: { code?: string } | undefined;
    const ctx = ctxWith({ addLock: async (_id: string, a: { code?: string }) => { got = a; return { outcome: "ok", lockId: 7 }; } });
    await vaultGroup.modals!["vault-add"](ctx, {
      actorDiscordId: "111", arg: "member",
      field: (n) => ({ name: "Shed", note: "", code: "  " })[n] ?? "",
    });
    expect(got!.code).toBeUndefined();
  });

  it("passes a refusal straight through from the roster", async () => {
    const ctx = ctxWith({ addLock: async () => ({ outcome: "not-permitted", lockId: null }) });
    const reply = await vaultGroup.modals!["vault-add"](ctx, {
      actorDiscordId: "111", arg: "member", field: (n) => (n === "name" ? "Shed" : ""),
    });
    expect(reply.content).toMatch(/Only an officer or the leader/u);
  });
});

describe("/vault edit", () => {
  it("prefills the modal with the lock as it stands", async () => {
    const ctx = ctxWith({ vaultFor: async () => state({ locks: [lock({ id: 4, name: "Back shed", note: "spare fuel" })] }) });
    const reply = await specOf(vaultGroup, "vault edit").handler(ctx, input({ lock: "4", minrole: "leader" }));
    const j = reply.modal!.toJSON();
    expect(j.custom_id).toBe(modalId("vault-edit", "111", "4.leader"));
    const values = j.components.flatMap((r) => r.components.map((c) => (c as { value?: string }).value));
    expect(values).toEqual(["Back shed", "spare fuel"]);
  });

  it("says the lock is gone rather than opening a modal for nothing", async () => {
    const ctx = ctxWith({ vaultFor: async () => state({ locks: [] }) });
    const reply = await specOf(vaultGroup, "vault edit").handler(ctx, input({ lock: "4", minrole: "leader" }));
    expect(reply.modal).toBeUndefined();
    expect(reply.content).toBe("That lock no longer exists.");
  });

  it("edits the lock the arg named, with the role the arg carried", async () => {
    let got: unknown;
    const ctx = ctxWith({ editLock: async (_id: string, a: unknown) => { got = a; return "ok"; } });
    const reply = await vaultGroup.modals!["vault-edit"](ctx, {
      actorDiscordId: "111", arg: "4.leader",
      field: (n) => ({ name: "Back shed", note: "" })[n] ?? "",
    });
    expect(got).toEqual({ lockId: 4, name: "Back shed", note: null, minRole: "leader" });
    expect(reply.content).toBe("Saved.");
  });

  it("refuses a malformed arg instead of writing with a guess", async () => {
    const ctx = ctxWith({ editLock: async () => { throw new Error("must not be called"); } });
    const reply = await vaultGroup.modals!["vault-edit"](ctx, {
      actorDiscordId: "111", arg: "4.emperor", field: () => "x",
    });
    expect(reply.content).toMatch(/missing or too long/u);
  });
});
```

- [ ] **Step 10: Run and watch it fail**

Run: `pnpm --filter @factions/bot test commands-vault` with Bash `timeout: 600000`.
Expected: FAIL — no `vault add` spec.

- [ ] **Step 11: Add `roleOf` to `commands/parse.ts`**

```ts
import type { Role } from "@factions/roster";

const ROLES: readonly Role[] = ["leader", "officer", "member"];

/**
 * A role name off a slash choice or a custom id's `arg`, or null.
 *
 * ⚠️ Validated rather than cast: `arg` is client-supplied data that has
 * round-tripped through Discord, and it decides which ranks can read a lock.
 */
export function roleOf(raw: string | null): Role | null {
  return ROLES.find((r) => r === raw) ?? null;
}
```

⚠️ Check that `Role` is exported from `@factions/roster`'s public surface. If it is not, export the type there (it is already exported from `internal/roster-store.ts`) rather than re-declaring the union in the bot.

- [ ] **Step 12: Add `/vault add` and `/vault edit` to `vault.ts`**

```ts
const MIN_ROLE_CHOICES = [
  { name: "Members and up", value: "member" },
  { name: "Officers and the leader", value: "officer" },
  { name: "The leader only", value: "leader" },
] as const;

function textRow(id: string, label: string, style: TextInputStyle, max: number, required: boolean, value?: string) {
  const input = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required);
  if (value) input.setValue(value);
  return new ActionRowBuilder<TextInputBuilder>().addComponents(input);
}

/**
 * `/vault add` — the code goes in the modal, never in a slash option (spec
 * §4.1). A slash option is echoed into the channel's command bar while it is
 * being typed and persists in Discord's client-side command history; a modal
 * field is neither.
 *
 * ⚠️ `opensModal`, so this runs BEFORE any acknowledgement and must stay
 * free of database work.
 */
const add: Handler = async (_ctx, input) => {
  const minRole = roleOf(input.string("minrole"));
  if (!minRole) return { content: discordCopy("input", "bad-input"), ephemeral: true };
  const modal = new ModalBuilder()
    .setCustomId(modalId("vault-add", input.actorDiscordId, minRole))
    .setTitle("Add a lock")
    .addComponents(
      textRow("name", "What it locks", TextInputStyle.Short, VAULT_NAME_MAX, true),
      textRow("note", "Note (optional)", TextInputStyle.Paragraph, VAULT_NOTE_MAX, false),
      textRow("code", `Code (${VAULT_CODE_DIGITS} digits — blank to generate)`, TextInputStyle.Short, VAULT_CODE_DIGITS, false),
    );
  return { modal, ephemeral: true };
};

const submitAdd: ModalHandler = async (ctx, a) => {
  const minRole = roleOf(a.arg);
  if (!minRole) return { content: discordCopy("input", "bad-input"), ephemeral: true };
  const code = a.field("code").trim();
  const note = a.field("note").trim();
  const { outcome } = await ctx.roster.addLock(a.actorDiscordId, {
    name: a.field("name").trim(),
    note: note === "" ? null : note,
    minRole,
    ...(code === "" ? {} : { code }),
  });
  return { content: discordVaultCopy("add", outcome), ephemeral: true };
};

/**
 * `/vault edit` — prefilled from the lock as it stands, because `editLock`
 * overwrites name, note and rank together and a player re-gating a lock
 * should not have to retype its description.
 *
 * ⚠️ `opensModal`: one indexed read (`vaultFor`) before `showModal`, and no
 * more. Discord gives three seconds and there is no defer to fall back on.
 */
const edit: Handler = async (ctx, input) => {
  const minRole = roleOf(input.string("minrole"));
  const lockId = idOf(input.string("lock"));
  if (!minRole || lockId === null) return { content: discordCopy("input", "bad-input"), ephemeral: true };
  const state = await ctx.roster.vaultFor(input.actorDiscordId);
  if (typeof state === "string") return { content: REFUSAL[state], ephemeral: true };
  const current = state.locks.find((l) => l.id === lockId);
  if (!current) return { content: discordVaultCopy("edit", "gone"), ephemeral: true };
  const modal = new ModalBuilder()
    .setCustomId(modalId("vault-edit", input.actorDiscordId, `${lockId}.${minRole}`))
    .setTitle("Edit a lock")
    .addComponents(
      textRow("name", "What it locks", TextInputStyle.Short, VAULT_NAME_MAX, true, current.name),
      textRow("note", "Note (optional)", TextInputStyle.Paragraph, VAULT_NOTE_MAX, false, current.note ?? undefined),
    );
  return { modal, ephemeral: true };
};

const submitEdit: ModalHandler = async (ctx, a) => {
  // `arg` is "<lockId>.<minRole>" (R4). Both halves are client-supplied and
  // both are validated: neither is trusted to be what we wrote.
  const [rawId, rawRole] = (a.arg ?? "").split(".");
  const lockId = idOf(rawId ?? null);
  const minRole = roleOf(rawRole ?? null);
  if (lockId === null || !minRole) return { content: discordCopy("input", "bad-input"), ephemeral: true };
  const note = a.field("note").trim();
  const outcome = await ctx.roster.editLock(a.actorDiscordId, {
    lockId, name: a.field("name").trim(), note: note === "" ? null : note, minRole,
  });
  return { content: discordVaultCopy("edit", outcome), ephemeral: true };
};
```

Register them on the group:

```ts
    .addSubcommand((s) => s.setName("add").setDescription("Add a lock")
      .addStringOption((o) => o.setName("minrole").setDescription("Who may see the code").setRequired(true).addChoices(...MIN_ROLE_CHOICES)))
    .addSubcommand((s) => s.setName("edit").setDescription("Rename a lock or change who may see it")
      .addStringOption((o) => o.setName("lock").setDescription("Which lock").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("minrole").setDescription("Who may see the code").setRequired(true).addChoices(...MIN_ROLE_CHOICES)))
```

```ts
  specs: [
    { path: "vault list", handler: list },
    { path: "vault add", handler: add, opensModal: true },
    { path: "vault edit", handler: edit, opensModal: true, autocomplete: { lock: locks } },
  ],
  modals: { "vault-add": submitAdd, "vault-edit": submitEdit },
```

- [ ] **Step 13: Run the vault, registration and route tests**

Run: `pnpm --filter @factions/bot test commands-vault command-registration route` with Bash `timeout: 600000`.
Expected: PASS.

- [ ] **Step 14: Typecheck and the whole suite**

Run: `pnpm --filter @factions/bot typecheck && pnpm --filter @factions/bot test` with Bash `timeout: 600000`.
Expected: both clean.

- [ ] **Step 15: Commit**

```bash
git add apps/bot/src/commands/vault.ts apps/bot/src/commands/parse.ts apps/bot/test/commands-vault.test.ts packages/roster/src/index.ts
git commit -m "feat(bot): /vault add and /vault edit, with the code in a modal"
```

---

### Task 3: `/vault reveal`, `/vault confirm`, `/vault delete`, `/vault rotate`

The rest of the vault. Two are plain writes, two are destructive and get Confirm buttons (R2), and one hands the player a secret — which is the sharpest constraint in this plan.

**Files:**
- Modify: `packages/copy/src/vault.ts`, `packages/copy/src/discord.ts`, `packages/copy/src/index.ts`
- Modify: `apps/bot/src/commands/vault.ts`
- Test: `packages/copy/test/overrides.test.ts` (extend), `apps/bot/test/commands-vault.test.ts` (extend)

**Interfaces:**
- Consumes: `confirmReply`, `confirmId` from `commands/confirm.js`; `locks` from Task 1; `idOf` from `commands/parse.js`.
- Produces:
  - `revealedCopy(lockName: string, code: string): string` and `rotatedCopy(n: number): string` exported from `@factions/copy`.
  - `DISCORD_VAULT_OVERRIDES.delete.unconfirmed` and `.rotate.unconfirmed` — button wording, replacing the site's "tick the box".
  - `locksOrAll: AutocompleteSource` in `vault.ts`.
  - `/vault reveal`, `/vault confirm`, `/vault delete`, `/vault rotate` on `vaultGroup`; component actions `vault-del` and `vault-rot`.

- [ ] **Step 1: Write the failing copy test**

Append to `packages/copy/test/overrides.test.ts`:

```ts
describe("the vault's Discord wording", () => {
  it("asks for a button press, not a checkbox", () => {
    for (const action of ["delete", "rotate"] as const) {
      expect(discordVaultCopy(action, "unconfirmed")).toMatch(/Press Confirm/u);
      expect(discordVaultCopy(action, "unconfirmed")).not.toMatch(/tick|box/iu);
    }
  });

  /**
   * ⚠️ The revealed code is the one string in this package that carries a
   * secret. It exists here, rather than in apps/bot, for the same reason
   * every other sentence does — but it must stay a pure function of its two
   * arguments, with nothing logged and nothing cached.
   */
  it("names the lock beside the code, and says the code is not to be shared", () => {
    const line = revealedCopy("Front gate", "1234");
    expect(line).toContain("Front gate");
    expect(line).toContain("1234");
    expect(line).toMatch(/only you/iu);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @factions/copy test` with Bash `timeout: 600000`.
Expected: FAIL — `revealedCopy` is not exported.

- [ ] **Step 3: Add the copy**

In `packages/copy/src/vault.ts`:

```ts
/**
 * What `/vault reveal` answers with on `ok`. The site's reveal button gets
 * the raw code as JSON and paints it behind a tap; Discord has no tap, so
 * the sentence carries the warning instead.
 *
 * ⚠️ A code appears in exactly two places in this codebase: the
 * `vault_locks` row, and the string this function returns. Do not log it, do
 * not put it in a custom id, do not interpolate it into an embed.
 */
export const revealedCopy = (lockName: string, code: string) =>
  `**${lockName}** — \`${code}\`. Only you can see this message; do not paste it anywhere else.`;

/**
 * What a rotate answers with once it has landed. The count is the part the
 * `ROTATE.ok` table string cannot carry, and it is the part that tells a
 * leader whether "all" did what they meant.
 */
export const rotatedCopy = (n: number) =>
  `${n} lock${n === 1 ? "" : "s"} rotated. ${ROTATE.ok}`;
```

⚠️ `ROTATE` is module-private in `vault.ts` today. Either move `rotatedCopy` below `ROTATE`'s declaration in that file (simplest), or read it as `VAULT_TABLES.rotate.ok` — do not paste the sentence a second time.

In `packages/copy/src/discord.ts`, fill in the empty override table:

```ts
export const DISCORD_VAULT_OVERRIDES: {
  [A in VaultAction]?: Partial<Record<keyof (typeof VAULT_TABLES)[A] & string, string>>
} = {
  delete: { unconfirmed: "Press Confirm to delete this lock. Its code goes with it." },
  rotate: { unconfirmed: "Press Confirm to rotate. Nothing changes in game until someone sets the new code on the lock." },
};
```

In `packages/copy/src/index.ts`, add `revealedCopy` and `rotatedCopy` to the `./vault` export line.

- [ ] **Step 4: Run the copy tests**

Run: `pnpm --filter @factions/copy typecheck && pnpm --filter @factions/copy test` with Bash `timeout: 600000`.
Expected: PASS.

- [ ] **Step 5: Write the failing handler tests**

Append to `apps/bot/test/commands-vault.test.ts`:

```ts
import { componentOf } from "./command-fakes.js";

describe("/vault reveal", () => {
  it("hands back the code, and nothing else does", async () => {
    const ctx = ctxWith({
      vaultFor: async () => state({ locks: [lock({ id: 4, name: "Front gate" })] }),
      revealLock: async () => ({ outcome: "ok", code: "9182" }),
    });
    const reply = await specOf(vaultGroup, "vault reveal").handler(ctx, input({ lock: "4" }));
    expect(reply.content).toContain("9182");
    expect(reply.embeds).toBeUndefined();
    expect(reply.components).toBeUndefined();
    expect(reply.ephemeral).toBe(true);
  });

  it("says why, without a code, when the rank is too low", async () => {
    const ctx = ctxWith({
      vaultFor: async () => state({ locks: [lock({ id: 4 })] }),
      revealLock: async () => ({ outcome: "not-visible", code: null }),
    });
    const reply = await specOf(vaultGroup, "vault reveal").handler(ctx, input({ lock: "4" }));
    expect(reply.content).toBe("That lock is above your rank.");
  });

  it("passes a refusal through", async () => {
    const ctx = ctxWith({ vaultFor: async () => state(), revealLock: async () => ({ outcome: "not-in-clan", code: null }) });
    const reply = await specOf(vaultGroup, "vault reveal").handler(ctx, input({ lock: "4" }));
    expect(reply.content).toBe("You are not in a clan.");
  });
});

describe("/vault confirm", () => {
  it("confirms the lock the option named", async () => {
    let got: number | undefined;
    const ctx = ctxWith({ confirmLock: async (_id: string, lockId: number) => { got = lockId; return "ok"; } });
    const reply = await specOf(vaultGroup, "vault confirm").handler(ctx, input({ lock: "4" }));
    expect(got).toBe(4);
    expect(reply.content).toMatch(/no longer flags this lock/u);
  });

  it("asks for a lock rather than guessing", async () => {
    const ctx = ctxWith({ confirmLock: async () => { throw new Error("must not be called"); } });
    const reply = await specOf(vaultGroup, "vault confirm").handler(ctx, input());
    expect(reply.content).toMatch(/Pick a lock/u);
  });
});

describe("/vault delete", () => {
  it("writes nothing and offers a Confirm button", async () => {
    const ctx = ctxWith({ deleteLock: async () => { throw new Error("must not be called before the press"); } });
    const reply = await specOf(vaultGroup, "vault delete").handler(ctx, input({ lock: "4" }));
    expect(reply.content).toMatch(/Press Confirm/u);
    expect(reply.components![0].toJSON().components[0].custom_id).toBe(confirmId("vault-del", "111", "4"));
  });

  it("deletes on the press, and the press is the write", async () => {
    let got: number | undefined;
    const ctx = ctxWith({ deleteLock: async (_id: string, lockId: number) => { got = lockId; return "ok"; } });
    const reply = await componentOf(vaultGroup, "vault-del")(ctx, { actorDiscordId: "111", arg: "4", values: [] });
    expect(got).toBe(4);
    expect(reply.content).toBe("Deleted.");
  });
});

describe("/vault rotate", () => {
  it("offers Confirm for one lock and for every lock", async () => {
    const ctx = ctxWith({});
    const one = await specOf(vaultGroup, "vault rotate").handler(ctx, input({ lock: "4" }));
    expect(one.components![0].toJSON().components[0].custom_id).toBe(confirmId("vault-rot", "111", "4"));
    const all = await specOf(vaultGroup, "vault rotate").handler(ctx, input({ lock: "all" }));
    expect(all.components![0].toJSON().components[0].custom_id).toBe(confirmId("vault-rot", "111", "all"));
  });

  it("rotates every lock when the arg says all, and says how many", async () => {
    let got: unknown;
    const ctx = ctxWith({ rotateLocks: async (_id: string, l: unknown) => { got = l; return { outcome: "ok", rotated: 3 }; } });
    const reply = await componentOf(vaultGroup, "vault-rot")(ctx, { actorDiscordId: "111", arg: "all", values: [] });
    expect(got).toBe("all");
    expect(reply.content).toContain("3");
  });

  /** ⚠️ R3: there is no chosen-code path on either surface. A rotate never carries a code in or out. */
  it("never accepts or returns a code", async () => {
    const sub = vaultGroup.command.toJSON().options!.find((o) => o.name === "rotate")!;
    const opts = (sub as { options?: { name: string }[] }).options ?? [];
    expect(opts.map((o) => o.name)).toEqual(["lock"]);
    const ctx = ctxWith({ rotateLocks: async () => ({ outcome: "ok", rotated: 1 }) });
    const reply = await componentOf(vaultGroup, "vault-rot")(ctx, { actorDiscordId: "111", arg: "4", values: [] });
    expect(reply.content).not.toMatch(/\d{4}/u);
  });
});
```

- [ ] **Step 6: Run and watch it fail**

Run: `pnpm --filter @factions/bot test commands-vault` with Bash `timeout: 600000`.
Expected: FAIL — no `vault reveal` spec.

- [ ] **Step 7: Write the four handlers**

In `vault.ts`:

```ts
const PICK_A_LOCK = "Pick a lock from the list.";

/**
 * `/vault reveal`.
 *
 * ⚠️ The only place in `apps/bot` that holds a code. It goes into
 * `Reply.content` and nowhere else — no embed, no log line, no custom id, no
 * autocomplete label. The lock's name is read from `vaultFor` (which has
 * already rank-filtered) purely so the sentence can name what was revealed;
 * `revealLock` is still the permission check and can refuse after that read.
 */
const reveal: Handler = async (ctx, input) => {
  const lockId = idOf(input.string("lock"));
  if (lockId === null) return { content: PICK_A_LOCK, ephemeral: true };
  const state = await ctx.roster.vaultFor(input.actorDiscordId);
  if (typeof state === "string") return { content: REFUSAL[state], ephemeral: true };
  const { outcome, code } = await ctx.roster.revealLock(input.actorDiscordId, lockId);
  if (outcome !== "ok" || code === null) return { content: discordVaultCopy("reveal", outcome), ephemeral: true };
  const name = state.locks.find((l) => l.id === lockId)?.name ?? "That lock";
  return { content: revealedCopy(name, code), ephemeral: true };
};

const confirm: Handler = async (ctx, input) => {
  const lockId = idOf(input.string("lock"));
  if (lockId === null) return { content: PICK_A_LOCK, ephemeral: true };
  return { content: discordVaultCopy("confirm", await ctx.roster.confirmLock(input.actorDiscordId, lockId)), ephemeral: true };
};

/** R2: the slash command writes nothing. The press is the write. */
const del: Handler = async (_ctx, input) => {
  const lockId = idOf(input.string("lock"));
  if (lockId === null) return { content: PICK_A_LOCK, ephemeral: true };
  return confirmReply("vault-del", input.actorDiscordId, discordVaultCopy("delete", "unconfirmed"), String(lockId));
};

const pressDelete: ComponentHandler = async (ctx, a) => {
  const lockId = idOf(a.arg);
  if (lockId === null) return { content: PICK_A_LOCK, ephemeral: true };
  return { content: discordVaultCopy("delete", await ctx.roster.deleteLock(a.actorDiscordId, lockId)), ephemeral: true };
};

/** R2 and R3: a Confirm button, one lock or every lock, and never a chosen code. */
const rotate: Handler = async (_ctx, input) => {
  const raw = input.string("lock");
  const target = raw === "all" ? "all" : idOf(raw);
  if (target === null) return { content: PICK_A_LOCK, ephemeral: true };
  return confirmReply("vault-rot", input.actorDiscordId, discordVaultCopy("rotate", "unconfirmed"), String(target));
};

const pressRotate: ComponentHandler = async (ctx, a) => {
  const target = a.arg === "all" ? "all" : idOf(a.arg);
  if (target === null) return { content: PICK_A_LOCK, ephemeral: true };
  const { outcome, rotated } = await ctx.roster.rotateLocks(a.actorDiscordId, target);
  if (outcome !== "ok") return { content: discordVaultCopy("rotate", outcome), ephemeral: true };
  // ⚠️ P2: the count needs a sentence around it, and a sentence a player
  // reads is copy — so it lives in `packages/copy`, not here.
  return { content: rotatedCopy(rotated), ephemeral: true };
};

/** `/vault rotate`'s option: every lock the rank may see, plus "all". */
export const locksOrAll: AutocompleteSource = async (ctx, a) => [
  { name: "Every lock", value: "all" },
  ...(await locks(ctx, a)),
];
```

Register:

```ts
    .addSubcommand((s) => s.setName("reveal").setDescription("Show a code — only to you")
      .addStringOption((o) => o.setName("lock").setDescription("Which lock").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("confirm").setDescription("Say the new code is set on the lock in game")
      .addStringOption((o) => o.setName("lock").setDescription("Which lock").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("delete").setDescription("Delete a lock")
      .addStringOption((o) => o.setName("lock").setDescription("Which lock").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("rotate").setDescription("Give a lock a new code")
      .addStringOption((o) => o.setName("lock").setDescription("Which lock, or every lock").setRequired(true).setAutocomplete(true)))
```

```ts
    { path: "vault reveal", handler: reveal, autocomplete: { lock: locks } },
    { path: "vault confirm", handler: confirm, autocomplete: { lock: locks } },
    { path: "vault delete", handler: del, autocomplete: { lock: locks } },
    { path: "vault rotate", handler: rotate, autocomplete: { lock: locksOrAll } },
  ],
  components: { "vault-del": pressDelete, "vault-rot": pressRotate },
```

- [ ] **Step 8: Run the vault, registration and ephemeral tests**

Run: `pnpm --filter @factions/bot test commands-vault command-registration` with Bash `timeout: 600000`.
Expected: PASS.

- [ ] **Step 9: Typecheck both packages and run both suites**

Run: `pnpm --filter @factions/copy typecheck && pnpm --filter @factions/copy test && pnpm --filter @factions/bot typecheck && pnpm --filter @factions/bot test` with Bash `timeout: 600000`.
Expected: all clean.

- [ ] **Step 10: Commit**

```bash
git add packages/copy/src apps/bot/src/commands/vault.ts apps/bot/test/commands-vault.test.ts packages/copy/test/overrides.test.ts
git commit -m "feat(bot): /vault reveal, confirm, delete and rotate"
```

---

### Task 4: `/map` — pins, pin, unpin, view

The last two writes in `parity.test.ts`, plus the read that makes them usable and the pointer to the picture Discord cannot draw (R1).

**Files:**
- Modify: `packages/domain/src/rules.ts`, `packages/roster/src/map.ts` (move `WORLD_SIZE_M` to the domain — P5)
- Create: `apps/bot/src/commands/map.ts`, `apps/bot/src/commands/embeds/map.ts`
- Modify: `apps/bot/src/commands/index.ts`
- Test: `apps/bot/test/commands-map.test.ts` (create)

**Interfaces:**
- Consumes: `budget` from Task 1; `PIN_RESULT_COPY`, `PIN_ICON_LABELS`, `discordCopy` from `@factions/copy`; `PIN_ICONS`, `PIN_NOTE_MAX`, `WORLD_SIZE_M`, `type PinIcon` from `@factions/domain`; `mapState`, `dropPin`, `deletePin`, `type MapState` from `@factions/roster`.
- Produces: `pinsEmbed(state: MapState, siteBaseUrl: string): EmbedBuilder`; `mapGroup: CommandGroup`; `WORLD_SIZE_M` on `@factions/domain` (P5).

- [ ] **Step 1: Write the failing tests**

`apps/bot/test/commands-map.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { mapGroup } from "../src/commands/map.js";
import { ctxWith, input, sourceOf, specOf } from "./command-fakes.js";
import type { MapState } from "@factions/roster";

const pin = (over: Partial<MapState["pins"][number]> = {}): MapState["pins"][number] => ({
  id: 1, x: 4200, z: 8100, icon: "loot", note: "crates", by: "Ada",
  at: new Date("2026-09-12T10:00:00Z"), expiresAt: new Date("2026-09-19T10:00:00Z"), ...over,
});

const mapFixture = (over: Partial<MapState> = {}): MapState => ({
  world: { size: 12800 },
  you: { gamertag: "Ada", fix: null },
  base: null,
  clanmates: [],
  intruders: [{ gamertag: "Rat", x: 1, z: 2, lastSeenAt: new Date(), distanceM: 300 }],
  publicBases: [{ x: 9, z: 9, texture: "wolf" }],
  pins: [pin()],
  travelPoints: [],
  hub: { x: 0, z: 0 },
  layers: { base: true, clanmates: true, intruders: true, pins: true },
  ...over,
});

describe("/map pins", () => {
  it("lists the clan's own pins with their ids", async () => {
    const ctx = ctxWith({ mapState: async () => mapFixture() });
    const reply = await specOf(mapGroup, "map pins").handler(ctx, input());
    const j = reply.embeds![0].toJSON();
    expect(JSON.stringify(j.fields)).toContain("crates");
    expect(JSON.stringify(j.fields)).toContain("#1");
    expect(reply.ephemeral).toBe(true);
  });

  /**
   * ⚠️ The card renders the VIEWER'S OWN clan's pins and nothing else.
   * `MapState` also carries intruders and public bases — other players'
   * positions and other clans' bases. Those are raid targets and the site
   * draws them under its own gate; no Discord reply may carry them.
   */
  it("never renders an intruder or another clan's base", async () => {
    const ctx = ctxWith({ mapState: async () => mapFixture() });
    const reply = await specOf(mapGroup, "map pins").handler(ctx, input());
    const rendered = JSON.stringify(reply.embeds![0].toJSON());
    expect(rendered).not.toContain("Rat");
    expect(rendered).not.toContain("wolf");
  });

  it("refuses a player with no link, in the shared words", async () => {
    const ctx = ctxWith({ mapState: async () => "not-linked" });
    const reply = await specOf(mapGroup, "map pins").handler(ctx, input());
    expect(reply.content).toBe(PIN_RESULT_COPY["not-linked"]);
  });

  it("says so plainly when there are no pins", async () => {
    const ctx = ctxWith({ mapState: async () => mapFixture({ pins: [] }) });
    const reply = await specOf(mapGroup, "map pins").handler(ctx, input());
    expect(reply.embeds![0].toJSON().description).toMatch(/No pins/u);
  });
});

describe("/map pin", () => {
  it("drops the pin the options described", async () => {
    let got: unknown;
    const ctx = ctxWith({ dropPin: async (_id: string, p: unknown) => { got = p; return { ok: true, id: 5 }; } });
    const reply = await specOf(mapGroup, "map pin").handler(ctx, input({ x: 4200, z: 8100, icon: "loot", note: "crates" }));
    expect(got).toEqual({ x: 4200, z: 8100, icon: "loot", note: "crates" });
    expect(reply.content).toBe(PIN_RESULT_COPY.dropped);
  });

  it("sends a blank note as null, not as an empty string", async () => {
    let got: { note: string | null } | undefined;
    const ctx = ctxWith({ dropPin: async (_id: string, p: { note: string | null }) => { got = p; return { ok: true, id: 5 }; } });
    await specOf(mapGroup, "map pin").handler(ctx, input({ x: 1, z: 2, icon: "note" }));
    expect(got!.note).toBeNull();
  });

  it("answers a refusal in the map's own words", async () => {
    const ctx = ctxWith({ dropPin: async () => ({ ok: false, reason: "off-map" }) });
    const reply = await specOf(mapGroup, "map pin").handler(ctx, input({ x: 1, z: 2, icon: "loot" }));
    expect(reply.content).toBe(PIN_RESULT_COPY["off-map"]);
  });

  it("offers the six icons as choices, not as free text", () => {
    const sub = mapGroup.command.toJSON().options!.find((o) => o.name === "pin")!;
    const icon = ((sub as { options?: { name: string; choices?: unknown[] }[] }).options ?? []).find((o) => o.name === "icon")!;
    expect(icon.choices).toHaveLength(6);
  });
});

describe("/map unpin", () => {
  it("deletes the pin the option named", async () => {
    let got: number | undefined;
    const ctx = ctxWith({ deletePin: async (_id: string, pinId: number) => { got = pinId; return { deleted: true }; } });
    const reply = await specOf(mapGroup, "map unpin").handler(ctx, input({ pin: "7" }));
    expect(got).toBe(7);
    expect(reply.content).toBe(PIN_RESULT_COPY.deleted);
  });

  it("says so when the pin was not the actor's to delete", async () => {
    const ctx = ctxWith({ deletePin: async () => ({ deleted: false }) });
    const reply = await specOf(mapGroup, "map unpin").handler(ctx, input({ pin: "7" }));
    expect(reply.content).toBe(PIN_RESULT_COPY["not-deleted"]);
  });

  /** ⚠️ R6: an autocomplete list is rendered while the player types, possibly on a shared screen. */
  it("offers pins by icon, note and age — never by coordinate", async () => {
    const ctx = ctxWith({ mapState: async () => mapFixture({ pins: [pin({ id: 3, x: 4200, z: 8100, note: "crates" })] }) });
    const choices = await sourceOf(mapGroup, "map unpin", "pin")(ctx, { actorDiscordId: "111", value: "" });
    expect(choices).toHaveLength(1);
    expect(choices[0]!.value).toBe("3");
    expect(choices[0]!.name).toContain("crates");
    expect(choices[0]!.name).not.toContain("4200");
    expect(choices[0]!.name).not.toContain("8100");
  });
});

describe("/map view", () => {
  it("answers with the link and nothing else — the map is a picture", async () => {
    const reply = await specOf(mapGroup, "map view").handler(ctxWith({}), input());
    expect(reply.content).toContain("https://x/map");
    expect(reply.embeds).toBeUndefined();
  });
});
```

⚠️ Import `PIN_RESULT_COPY` from `@factions/copy` at the top of the test file.

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @factions/bot test commands-map` with Bash `timeout: 600000`.
Expected: FAIL — `Cannot find module '../src/commands/map.js'`.

- [ ] **Step 3: Move `WORLD_SIZE_M` into `@factions/domain`**

The bot needs the world size at *registration* time, for `setMinValue`/`setMaxValue`, so it cannot read it off `mapState().world.size` at call time.

**P5 — it does not become a roster export.** `packages/roster/test/roster-exports.ts` is an allowlist whose own comment says "the export list IS the permission list", pinned again by `packages/roster/test/exports.test.ts` and `apps/web/test/smoke.test.ts`; growing a permission list to publish a constant is the wrong trade, and it would also need a fourth edit in `parity.test.ts`'s `reads` set.

Instead:

1. Move the declaration to `packages/domain/src/rules.ts`, beside `PIN_ICONS` and `PIN_NOTE_MAX` — the map's other rules already live there, and `rules.ts` is re-exported by `packages/domain/src/index.ts`.
2. In `packages/roster/src/map.ts`, replace the local `export const WORLD_SIZE_M = 12800;` with an import from `@factions/domain`, and keep re-exporting it from that module so nothing inside the package breaks.
3. Keep the comment that says what it is ("Livonia. The one map this deployment runs; `servers.map` says \"livonia\".") with the declaration as it moves.

⚠️ No allowlist file changes, and `parity.test.ts` is untouched by this step. If `exports.test.ts` goes red, the constant leaked onto the roster's public surface — undo that rather than widening the allowlist.

- [ ] **Step 4: Write `embeds/map.ts`**

```ts
import { EmbedBuilder } from "discord.js";
import type { MapState } from "@factions/roster";
import { PIN_ICON_LABELS, when } from "@factions/copy";
import { budget } from "./budget.js";

const GOLD = 0xc8a34a;
const TITLE = "Pins";
const FOOTER_TEXT = "`/map unpin pin:` removes one. `/map view` opens the map.";

/**
 * `/map pins`.
 *
 * ⚠️ Reads `state.pins` and NOTHING else off `MapState`. The same object
 * carries `intruders` (other players' live positions), `publicBases` (other
 * clans' declared bases) and `clanmates` — every one of them a raid target,
 * every one of them drawn only by the site's own map under its own gate. A
 * field added here that touches any of them turns an ephemeral convenience
 * into a targeting service.
 *
 * The viewer's own clan's pin coordinates DO appear, in metres, on the same
 * footing as `baseEmbed`'s own-base coordinates: the reply is ephemeral and
 * the data is the viewer's own clan's.
 */
export function pinsEmbed(state: MapState, siteBaseUrl: string): EmbedBuilder {
  const embed = new EmbedBuilder().setColor(GOLD).setTitle(TITLE).setURL(`${siteBaseUrl}/map`).setFooter({ text: FOOTER_TEXT });
  if (state.pins.length === 0) return embed.setDescription("No pins. Drop one with `/map pin`.");

  const line = (p: MapState["pins"][number]) =>
    `• **#${p.id}** ${PIN_ICON_LABELS[p.icon]} — ${Math.round(p.x)}, ${Math.round(p.z)}`
    + (p.note ? ` · ${p.note}` : "") + ` · by ${p.by} · expires ${when(p.expiresAt)}`;

  budget(TITLE.length + FOOTER_TEXT.length).list(
    embed, `${state.pins.length} pin${state.pins.length === 1 ? "" : "s"}`,
    state.pins.map(line), (n) => `+${n} more — see the map.`,
  );
  return embed;
}
```

- [ ] **Step 5: Write `map.ts`**

```ts
import { SlashCommandBuilder } from "discord.js";
import { PIN_ICONS, PIN_NOTE_MAX, WORLD_SIZE_M, type PinIcon } from "@factions/domain";
import { PIN_ICON_LABELS, PIN_RESULT_COPY, discordCopy } from "@factions/copy";
import { pinsEmbed } from "./embeds/map.js";
import { idOf } from "./parse.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

/**
 * ⚠️ Every player-facing sentence here is `PIN_RESULT_COPY`'s. Do not write
 * one inline. `PIN_RESULT_COPY` is a `Record<string, string>`, so a key the
 * table does not hold reads back as `undefined` — the fallback is the shared
 * bad-input sentence, NOT another pin outcome. Falling back to a real
 * outcome's words would tell a player their pin was refused for a reason
 * that never happened (P3).
 */
const copy = (key: string) => PIN_RESULT_COPY[key] ?? discordCopy("input", "bad-input");

const pins: Handler = async (ctx, input) => {
  const state = await ctx.roster.mapState(input.actorDiscordId);
  if (state === "not-linked") return { content: copy("not-linked"), ephemeral: true };
  return { embeds: [pinsEmbed(state, ctx.siteBaseUrl)], ephemeral: true };
};

const drop: Handler = async (ctx, input) => {
  const x = input.integer("x");
  const z = input.integer("z");
  const icon = input.string("icon");
  if (x === null || z === null || !icon) return { content: copy("off-map"), ephemeral: true };
  const note = input.string("note");
  const outcome = await ctx.roster.dropPin(input.actorDiscordId, { x, z, icon, note: note ?? null });
  return { content: outcome.ok ? copy("dropped") : copy(outcome.reason), ephemeral: true };
};

const unpin: Handler = async (ctx, input) => {
  const pinId = idOf(input.string("pin"));
  if (pinId === null) return { content: copy("not-deleted"), ephemeral: true };
  const { deleted } = await ctx.roster.deletePin(input.actorDiscordId, pinId);
  return { content: deleted ? copy("deleted") : copy("not-deleted"), ephemeral: true };
};

/**
 * R1: a command with subcommands has no bare form, so the pointer to the
 * picture lives here. Spec §2.2 — the map itself is site-only by design.
 */
const view: Handler = async (ctx) =>
  ({ content: `The map is a picture — open it here: ${ctx.siteBaseUrl}/map`, ephemeral: true });

/** ⚠️ R6: no coordinate in a label. Icon, note and age are enough to pick the right pin. */
const pinChoices: AutocompleteSource = async (ctx, a) => {
  const state = await ctx.roster.mapState(a.actorDiscordId);
  if (state === "not-linked") return [];
  const q = a.value.trim().toLowerCase();
  const ageH = (at: Date) => Math.max(0, Math.round((ctx.now.getTime() - at.getTime()) / 3_600_000));
  return state.pins
    .filter((p) => q === "" || (p.note ?? "").toLowerCase().includes(q) || PIN_ICON_LABELS[p.icon].toLowerCase().includes(q))
    .map((p) => ({
      name: `#${p.id} ${PIN_ICON_LABELS[p.icon]}${p.note ? ` · ${p.note}` : ""} · ${ageH(p.at)} h ago`,
      value: String(p.id),
    }));
};

export const mapGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("map")
    .setDescription("Your clan's pins, and the map itself")
    .addSubcommand((s) => s.setName("pins").setDescription("Your clan's pins"))
    .addSubcommand((s) => s.setName("pin").setDescription("Drop a pin for your clan")
      .addIntegerOption((o) => o.setName("x").setDescription("Metres east").setRequired(true).setMinValue(0).setMaxValue(WORLD_SIZE_M))
      .addIntegerOption((o) => o.setName("z").setDescription("Metres north").setRequired(true).setMinValue(0).setMaxValue(WORLD_SIZE_M))
      .addStringOption((o) => o.setName("icon").setDescription("What it marks").setRequired(true)
        .addChoices(...PIN_ICONS.map((i: PinIcon) => ({ name: PIN_ICON_LABELS[i], value: i }))))
      .addStringOption((o) => o.setName("note").setDescription("Optional note").setMaxLength(PIN_NOTE_MAX)))
    .addSubcommand((s) => s.setName("unpin").setDescription("Remove one of your pins")
      .addStringOption((o) => o.setName("pin").setDescription("Which pin").setRequired(true).setAutocomplete(true)))
    .addSubcommand((s) => s.setName("view").setDescription("Open the map")),
  specs: [
    { path: "map pins", handler: pins },
    { path: "map pin", handler: drop },
    { path: "map unpin", handler: unpin, autocomplete: { pin: pinChoices } },
    { path: "map view", handler: view },
  ],
};
```

⚠️ `setMinValue`/`setMaxValue` give a client-side guard only; `dropPin` re-checks with `inWorld` and answers `off-map`. Do not treat the option bounds as the validation.

- [ ] **Step 6: Register and run**

Add `mapGroup` to `GROUPS` in `commands/index.ts`.

Run: `pnpm --filter @factions/bot test commands-map command-registration` with Bash `timeout: 600000`.
Expected: PASS.

- [ ] **Step 7: Typecheck the workspace packages this touched, and run their suites**

Run: `pnpm --filter @factions/domain test && pnpm --filter @factions/roster typecheck && pnpm --filter @factions/roster test && pnpm --filter @factions/bot typecheck && pnpm --filter @factions/bot test` with Bash `timeout: 600000`.
Expected: all clean.

- [ ] **Step 8: Commit**

```bash
git add packages/domain/src packages/roster/src apps/bot/src/commands/map.ts apps/bot/src/commands/embeds/map.ts apps/bot/src/commands/index.ts apps/bot/test/commands-map.test.ts
git commit -m "feat(bot): /map pins, pin, unpin and view"
```

---

### Task 5: `/scoreboard`, `/alphas`, `/seasons`, `/warlog`

Four flat commands — no subcommands, so each is its own `CommandGroup` with one spec whose `path` is the bare name (the shape `/found` already has). All four are pure reads over existing roster exports; none writes anything and none needs a confirm, a modal or a component.

**Files:**
- Create: `apps/bot/src/commands/scoring.ts`, `apps/bot/src/commands/embeds/scoring.ts`
- Modify: `apps/bot/src/commands/index.ts`
- Test: `apps/bot/test/commands-scoring.test.ts` (create)

**Interfaces:**
- Consumes: `budget` (Task 1); `when` from `@factions/copy`; `scoreboard`, `alphas`, `seasons`, `warLog`, `directory` and the types `Scoreboard`, `AlphaWeek`, `SeasonSummary`, `WarLogEntry` from `@factions/roster`.
- Produces: `scoreboardEmbed`, `alphasEmbed`, `seasonsEmbed`, `warLogEmbed` in `embeds/scoring.ts`; `scoreboardGroup`, `alphasGroup`, `seasonsGroup`, `warlogGroup` in `scoring.ts`.

- [ ] **Step 1: Write the failing tests**

`apps/bot/test/commands-scoring.test.ts`, covering one shape and one empty case per command — the empty case is the one that bites, because three of these four read a season that may not exist yet:

```ts
import { describe, it, expect } from "vitest";
import { alphasGroup, scoreboardGroup, seasonsGroup, warlogGroup } from "../src/commands/scoring.js";
import { ctxWith, input, sourceOf, specOf } from "./command-fakes.js";

describe("/scoreboard", () => {
  it("renders the open season's table in the order the roster returned", async () => {
    const ctx = ctxWith({ scoreboard: async () => ({
      season: { number: 3, startedAt: new Date("2026-09-01T00:00:00Z"), weekClosedThrough: null },
      rows: [
        { rank: 1, tag: "WLF", name: "Wolves", texture: "wolf", status: "active", points: 40, raids: 4, timesRaided: 1, defenses: 2, alpha: true },
        { rank: 2, tag: "BR", name: "Bears", texture: "bear", status: "active", points: 10, raids: 1, timesRaided: 0, defenses: 0, alpha: false },
      ],
    }) });
    const reply = await specOf(scoreboardGroup, "scoreboard").handler(ctx, input());
    const value = JSON.stringify(reply.embeds![0].toJSON());
    expect(value.indexOf("Wolves")).toBeLessThan(value.indexOf("Bears"));
    expect(value).toContain("Season 3");
    expect(reply.ephemeral).toBe(true);
  });

  it("says there is no season rather than rendering an empty table", async () => {
    const ctx = ctxWith({ scoreboard: async () => ({ season: null, rows: [] }) });
    const reply = await specOf(scoreboardGroup, "scoreboard").handler(ctx, input());
    expect(reply.embeds![0].toJSON().description).toMatch(/No season/u);
  });
});

describe("/alphas", () => {
  it("renders each closed week's top three", async () => {
    const ctx = ctxWith({ alphas: async () => ({ season: { number: 3 }, weeks: [
      { weekStart: new Date("2026-09-07T00:00:00Z"), entries: [
        { rank: 1, tag: "WLF", name: "Wolves", texture: "wolf", points: 30 },
        { rank: 2, tag: "BR", name: "Bears", texture: "bear", points: 20 },
      ] },
    ] }) });
    const reply = await specOf(alphasGroup, "alphas").handler(ctx, input());
    expect(JSON.stringify(reply.embeds![0].toJSON())).toContain("Wolves");
  });

  it("says no week has closed yet", async () => {
    const ctx = ctxWith({ alphas: async () => ({ season: { number: 3 }, weeks: [] }) });
    const reply = await specOf(alphasGroup, "alphas").handler(ctx, input());
    expect(reply.embeds![0].toJSON().description).toMatch(/No week has closed/u);
  });
});

describe("/seasons", () => {
  it("names each closed season's champion", async () => {
    const ctx = ctxWith({ seasons: async () => [{
      number: 2, startedAt: new Date("2026-06-01T00:00:00Z"), endedAt: new Date("2026-08-31T00:00:00Z"),
      champion: { tag: "WLF", name: "Wolves", texture: "wolf", points: 90 }, rows: [],
    }] });
    const reply = await specOf(seasonsGroup, "seasons").handler(ctx, input());
    expect(JSON.stringify(reply.embeds![0].toJSON())).toContain("Wolves");
  });

  it("says no season has closed yet", async () => {
    const reply = await specOf(seasonsGroup, "seasons").handler(ctxWith({ seasons: async () => [] }), input());
    expect(reply.embeds![0].toJSON().description).toMatch(/No season has closed/u);
  });
});

describe("/warlog", () => {
  it("renders raids and defenses newest first, as the roster ordered them", async () => {
    const ctx = ctxWith({ warLog: async () => [
      { kind: "raid", at: new Date("2026-09-12T10:00:00Z"), raider: { tag: "WLF", name: "Wolves" }, victim: { tag: "BR", name: "Bears", texture: "bear" }, gamertag: "Ada", points: 10, lowers: 1 },
      { kind: "defense", at: new Date("2026-09-11T10:00:00Z"), victim: { tag: "BR", name: "Bears", texture: "bear" }, gamertag: "Bo", durationSeconds: 3600 },
    ] });
    const reply = await specOf(warlogGroup, "warlog").handler(ctx, input());
    const value = JSON.stringify(reply.embeds![0].toJSON());
    expect(value.indexOf("Wolves")).toBeLessThan(value.indexOf("under siege"));
  });

  it("passes the clan and kind filters to the roster rather than filtering locally", async () => {
    let got: unknown;
    const ctx = ctxWith({ warLog: async (_limit: number, filter: unknown) => { got = filter; return []; } });
    await specOf(warlogGroup, "warlog").handler(ctx, input({ clan: "WLF", kind: "raid" }));
    expect(got).toEqual({ clanTag: "WLF", kind: "raid" });
  });

  it("says the log is empty rather than rendering nothing", async () => {
    const reply = await specOf(warlogGroup, "warlog").handler(ctxWith({ warLog: async () => [] }), input());
    expect(reply.embeds![0].toJSON().description).toMatch(/Nothing yet/u);
  });

  it("offers clans from the directory", async () => {
    const ctx = ctxWith({ directory: async () => ({ clans: [{ tag: "WLF", name: "Wolves", texture: "wolf", memberCount: 4, recruiting: false, alpha: false }] }) });
    const choices = await sourceOf(warlogGroup, "warlog", "clan")(ctx, { actorDiscordId: "111", value: "wol" });
    expect(choices).toEqual([{ name: "Wolves [WLF]", value: "WLF" }]);
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `pnpm --filter @factions/bot test commands-scoring` with Bash `timeout: 600000`.
Expected: FAIL — `Cannot find module '../src/commands/scoring.js'`.

- [ ] **Step 3: Write `embeds/scoring.ts`**

Four builders, each following the same shape as `directoryEmbed`: a title, a site URL, a `budget()` seeded with the title and footer lengths, one `list()` of lines, and a plain description when there is nothing to list. Exact content:

- `scoreboardEmbed(board: Scoreboard, siteBaseUrl: string)` — title `Season ${n}` (or "Scoreboard" with description `"No season is open yet."` when `board.season === null`), URL `${siteBaseUrl}/scoreboard`, one line per row:
  `• **${rank ?? "—"}. ${name}** [${tag}] — ${points} pts · ${raids}/${timesRaided}/${defenses}${alpha ? " · Alpha" : ""}`, and a footer naming what the three numbers are: `"raids / times raided / defenses"`.
- `alphasEmbed(a: { season: { number: number } | null; weeks: AlphaWeek[] }, siteBaseUrl: string)` — URL `${siteBaseUrl}/alphas`; description `"No week has closed yet."` when `weeks` is empty; otherwise one field per week (`b.field(embed, when(w.weekStart), lines)`) with `• ${rank}. ${name} [${tag}] — ${points} pts`. ⚠️ Use `b.field`, not raw `addFields`, so a long season cannot walk past the cap.
- `seasonsEmbed(list: SeasonSummary[], siteBaseUrl: string)` — URL `${siteBaseUrl}/seasons`; description `"No season has closed yet."` when empty; one line per season: `• **Season ${number}** — ${champion ? `${champion.name} [${champion.tag}], ${champion.points} pts` : "no champion"} · ended ${when(endedAt)}`.
- `warLogEmbed(entries: WarLogEntry[], siteBaseUrl: string)` — URL `${siteBaseUrl}/war-log`; description `"Nothing yet this season."` when empty; one line per entry, keyed on `kind`:
  - raid: `• ⚔️ ${when(at)} — **${raider?.name ?? "no clan"}** raided **${victim.name}** (${points} pts)`
  - defense: `• 🛡️ ${when(at)} — **${victim.name}** held, ${Math.round(durationSeconds / 60)} min under siege`

⚠️ Do not import `war-log-text.ts`. That renders the public `#war-log` channel post from a `NoticePayload` and answers a different question; reusing it here would couple a private read to a public feed's wording and neither would be free to change.

- [ ] **Step 4: Write `scoring.ts`**

```ts
import { SlashCommandBuilder } from "discord.js";
import { alphasEmbed, scoreboardEmbed, seasonsEmbed, warLogEmbed } from "./embeds/scoring.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

/** How many war-log rows fit one card comfortably. The site paginates; Discord shows the newest. */
const WAR_LOG_LIMIT = 25;

const scoreboard: Handler = async (ctx) =>
  ({ embeds: [scoreboardEmbed(await ctx.roster.scoreboard(), ctx.siteBaseUrl)], ephemeral: true });

const alphas: Handler = async (ctx) =>
  ({ embeds: [alphasEmbed(await ctx.roster.alphas(), ctx.siteBaseUrl)], ephemeral: true });

const seasons: Handler = async (ctx) =>
  ({ embeds: [seasonsEmbed(await ctx.roster.seasons(), ctx.siteBaseUrl)], ephemeral: true });

/** ⚠️ The filter goes to the roster; nothing is fetched wide and narrowed here. */
const warlog: Handler = async (ctx, input) => {
  const clanTag = input.string("clan");
  const kind = input.string("kind");
  const filter = {
    ...(clanTag ? { clanTag } : {}),
    ...(kind === "raid" || kind === "defense" ? { kind } : {}),
  };
  return { embeds: [warLogEmbed(await ctx.roster.warLog(WAR_LOG_LIMIT, filter), ctx.siteBaseUrl)], ephemeral: true };
};

/** Shared with nothing else: `/clans` has its own, which also offers "recruiting". */
const clanTags: AutocompleteSource = async (ctx, a) => {
  const { clans } = await ctx.roster.directory();
  const q = a.value.trim().toLowerCase();
  return clans
    .filter((c) => q === "" || c.tag.toLowerCase().includes(q) || c.name.toLowerCase().includes(q))
    .map((c) => ({ name: `${c.name} [${c.tag}]`, value: c.tag }));
};

const flat = (name: string, description: string, handler: Handler): CommandGroup => ({
  command: new SlashCommandBuilder().setName(name).setDescription(description),
  specs: [{ path: name, handler }],
});

export const scoreboardGroup = flat("scoreboard", "The open season's table", scoreboard);
export const alphasGroup = flat("alphas", "Closed weeks of the open season", alphas);
export const seasonsGroup = flat("seasons", "Closed seasons and their champions", seasons);

export const warlogGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("warlog")
    .setDescription("Recent raids and defenses")
    .addStringOption((o) => o.setName("clan").setDescription("Only this clan").setAutocomplete(true))
    .addStringOption((o) => o.setName("kind").setDescription("Only raids, or only defenses")
      .addChoices({ name: "Raids", value: "raid" }, { name: "Defenses", value: "defense" })),
  specs: [{ path: "warlog", handler: warlog, autocomplete: { clan: clanTags } }],
};
```

- [ ] **Step 5: Register the four groups and run**

Add all four to `GROUPS` in `commands/index.ts`.

Run: `pnpm --filter @factions/bot test commands-scoring command-registration` with Bash `timeout: 600000`.
Expected: PASS.

- [ ] **Step 6: Typecheck and the whole suite**

Run: `pnpm --filter @factions/bot typecheck && pnpm --filter @factions/bot test` with Bash `timeout: 600000`.
Expected: both clean.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/commands/scoring.ts apps/bot/src/commands/embeds/scoring.ts apps/bot/src/commands/index.ts apps/bot/test/commands-scoring.test.ts
git commit -m "feat(bot): /scoreboard, /alphas, /seasons and /warlog"
```

---

### Task 6: `/player`, `/board`, `/achievements`

The last three reads. All three take a scope, so `parseScope` (R7) lands here and is shared by all of them.

**Files:**
- Modify: `apps/bot/src/commands/parse.ts`
- Create: `apps/bot/src/commands/stats.ts`, `apps/bot/src/commands/embeds/stats.ts`
- Modify: `apps/bot/src/commands/index.ts`
- Test: `apps/bot/test/commands-stats.test.ts` (create), `apps/bot/test/parse.test.ts` (create or extend)

**Interfaces:**
- Consumes: `budget` (Task 1); `playerProfile`, `boardPage`, `clanBoardPage`, `achievementsFor`, `linkStatus`, `suggestGamertags`, `seasons`, `BOARD_KINDS`, `BOARD_PAGE_SIZE`, and the types `StatScope`, `BoardKind`, `BoardPage`, `PlayerProfile`, `AchievementWall` from `@factions/roster`.
- Produces: `parseScope(raw: string | null): StatScope` in `parse.ts`; `playerEmbed`, `boardEmbed`, `achievementsEmbed` in `embeds/stats.ts`; `playerGroup`, `boardGroup`, `achievementsGroup` in `stats.ts`.

- [ ] **Step 1: Write the failing `parseScope` test**

```ts
import { describe, it, expect } from "vitest";
import { parseScope } from "../src/commands/parse.js";

describe("parseScope", () => {
  it("defaults to the current season", () => {
    expect(parseScope(null)).toEqual({ kind: "current" });
    expect(parseScope("")).toEqual({ kind: "current" });
    expect(parseScope("current")).toEqual({ kind: "current" });
  });

  it("reads all-time and a season number", () => {
    expect(parseScope("all")).toEqual({ kind: "all" });
    expect(parseScope("2")).toEqual({ kind: "season", number: 2 });
  });

  /** ⚠️ Anything else is the current season, not a throw: this parses a client-supplied string. */
  it("falls back to the current season for anything it does not recognise", () => {
    for (const raw of ["-1", "0", "1.5", "season two", "  "]) expect(parseScope(raw)).toEqual({ kind: "current" });
  });
});
```

- [ ] **Step 2: Write `parseScope`**

```ts
import type { StatScope } from "@factions/roster";

/**
 * R7: one `scope:` option, autocompleted to `current`, `all` and each closed
 * season's number. Unrecognised input resolves to the current season rather
 * than throwing — the string comes from a client and every read echoes back
 * the scope it actually resolved, so a wrong guess is visible, not silent.
 */
export function parseScope(raw: string | null): StatScope {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "all") return { kind: "all" };
  if (/^[1-9]\d*$/u.test(v)) return { kind: "season", number: Number(v) };
  return { kind: "current" };
}
```

- [ ] **Step 3: Write the failing handler tests**

`apps/bot/test/commands-stats.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { achievementsGroup, boardGroup, playerGroup } from "../src/commands/stats.js";
import { ctxWith, input, sourceOf, specOf } from "./command-fakes.js";

const profile = (over = {}) => ({
  dayzId: "p1", gamertag: "Ada", linked: true, scope: { kind: "season", number: 3 }, seasons: [3, 2],
  playTimeSeconds: 7200, sessions: 4, lastSeenAt: new Date("2026-09-12T00:00:00Z"),
  pvpKills: 10, pvpDeaths: 5, kd: 2, killedBy: [], killed: [],
  friendlyFireKills: 0, friendlyFireDeaths: 0, raidCredits: 2, upkeepRaises: 1,
  buildPoints: 30, bestStreak: 4, longestKill: { distanceM: 412, weapon: "SVD" },
  clanHistory: [], clan: { tag: "WLF", name: "Wolves", texture: "wolf" }, kills: [],
  ...over,
});

const page = (over = {}) => ({
  scope: { kind: "all" }, clans: {}, seasons: [3], kind: "raiders", page: 2, perPage: 50,
  rows: [{ dayzId: "p1", gamertag: "Ada", value: 12 }], hasNext: true, ...over,
});

describe("/player", () => {
  it("renders the profile, naming the scope the read resolved to", async () => {
    const ctx = ctxWith({ playerProfile: async () => profile() });
    const reply = await specOf(playerGroup, "player").handler(ctx, input({ gamertag: "Ada" }));
    const j = reply.embeds![0].toJSON();
    expect(j.title).toContain("Ada");
    expect(JSON.stringify(j)).toContain("Season 3");
    expect(reply.ephemeral).toBe(true);
  });

  it("passes the scope through instead of resolving it locally", async () => {
    let got: unknown;
    const ctx = ctxWith({ playerProfile: async (_g: string, scope: unknown) => { got = scope; return profile(); } });
    await specOf(playerGroup, "player").handler(ctx, input({ gamertag: "Ada", scope: "2" }));
    expect(got).toEqual({ kind: "season", number: 2 });
  });

  it("says no such player rather than rendering an empty card", async () => {
    const ctx = ctxWith({ playerProfile: async () => null });
    const reply = await specOf(playerGroup, "player").handler(ctx, input({ gamertag: "Nobody" }));
    expect(reply.embeds).toBeUndefined();
    expect(reply.content).toMatch(/seen on the server/u);
  });

  it("offers gamertags the server has seen, not only linked ones", async () => {
    let scope: string | undefined;
    const ctx = ctxWith({ suggestGamertags: async (_q: string, s: string) => { scope = s; return ["Ada"]; } });
    const choices = await sourceOf(playerGroup, "player", "gamertag")(ctx, { actorDiscordId: "111", value: "ad" });
    expect(scope).toBe("seen");
    expect(choices).toEqual([{ name: "Ada", value: "Ada" }]);
  });
});

describe("/board", () => {
  it("reads the public board by default, with kind, scope and page passed through", async () => {
    let got: unknown[] = [];
    const ctx = ctxWith({
      boardPage: async (...a: unknown[]) => { got = a; return page(); },
      clanBoardPage: async () => { throw new Error("must not be called"); },
    });
    const reply = await specOf(boardGroup, "board").handler(ctx, input({ kind: "raiders", scope: "all", page: 2 }));
    expect(got).toEqual(["raiders", { kind: "all" }, 2]);
    expect(JSON.stringify(reply.embeds![0].toJSON())).toContain("Ada");
  });

  /** ⚠️ `mine` routes to a different roster export, which is the one that checks membership. */
  it("reads the clan board when mine is true", async () => {
    let called = false;
    const ctx = ctxWith({
      clanBoardPage: async () => { called = true; return page(); },
      boardPage: async () => { throw new Error("must not be called"); },
    });
    await specOf(boardGroup, "board").handler(ctx, input({ kind: "raiders", mine: true }));
    expect(called).toBe(true);
  });

  it("answers a clan-board refusal in the shared words", async () => {
    const ctx = ctxWith({ clanBoardPage: async () => "not-in-clan" });
    const reply = await specOf(boardGroup, "board").handler(ctx, input({ kind: "raiders", mine: true }));
    expect(reply.content).toBe("You are not in a clan.");
  });

  it("numbers rows from the page it is on and says whether another exists", async () => {
    const ctx = ctxWith({ boardPage: async () => page() });
    const reply = await specOf(boardGroup, "board").handler(ctx, input({ kind: "raiders", page: 2 }));
    const j = reply.embeds![0].toJSON();
    expect(JSON.stringify(j.fields)).toContain("51.");
    expect(j.footer!.text).toMatch(/More on the site/u);
  });

  it("asks for a board rather than guessing one", async () => {
    const ctx = ctxWith({ boardPage: async () => { throw new Error("must not be called"); } });
    const reply = await specOf(boardGroup, "board").handler(ctx, input({ kind: "nonsense" }));
    expect(reply.content).toMatch(/Pick a board/u);
  });
});

describe("/achievements", () => {
  const wall = { tiles: [], earned: 3, closest: [] };

  it("defaults to the caller's own linked gamertag", async () => {
    let asked: unknown;
    const ctx = ctxWith({
      linkStatus: async () => ({ link: { dayzId: "p1", gamertag: "Ada", verifiedAt: new Date() }, challenge: null, ended: null }),
      achievementsFor: async (s: unknown) => { asked = s; return wall; },
    });
    const reply = await specOf(achievementsGroup, "achievements").handler(ctx, input());
    expect(asked).toEqual({ gamertag: "Ada" });
    expect(reply.embeds![0].toJSON().title).toContain("Ada");
  });

  it("reads a clan's wall when clan: is given", async () => {
    let asked: unknown;
    const ctx = ctxWith({ achievementsFor: async (s: unknown) => { asked = s; return wall; } });
    await specOf(achievementsGroup, "achievements").handler(ctx, input({ clan: "wlf" }));
    expect(asked).toEqual({ clanTag: "wlf" });
  });

  it("says to link first when the caller has no link and named nobody", async () => {
    const ctx = ctxWith({ linkStatus: async () => ({ link: null, challenge: null, ended: null }) });
    const reply = await specOf(achievementsGroup, "achievements").handler(ctx, input());
    expect(reply.content).toMatch(/Link your character first/u);
  });

  it("says no such clan when the wall comes back null", async () => {
    const ctx = ctxWith({ achievementsFor: async () => null });
    const reply = await specOf(achievementsGroup, "achievements").handler(ctx, input({ clan: "zzz" }));
    expect(reply.embeds).toBeUndefined();
    expect(reply.content).toBeTruthy();
  });
});
```

⚠️ The fixtures above are typed loosely (`= {}` defaults) so the plan stays readable. Type them properly against `PlayerProfile` and `BoardPage` in the real file — `tsc --noEmit` runs over `apps/bot/test` and an untyped fixture will not survive it.

- [ ] **Step 4: Write `embeds/stats.ts`**

Three builders, same budgeted shape as Task 5:

- `playerEmbed(p: PlayerProfile, siteBaseUrl: string)` — title `p.gamertag`, URL `${siteBaseUrl}/players/${encodeURIComponent(p.gamertag)}`, a description naming the resolved scope (`"All time"` or `"Season ${n}"`), inline fields for kills/deaths/KD, play time (hours), sessions, raid credits, build points, best streak, longest kill, and a `Clan` field when `p.clan` is set. ⚠️ `PlayerProfile` carries `clanHistory` and a kill list; render at most the current clan and the headline numbers — this is a card, not the page.
- `boardEmbed(page: BoardPage, siteBaseUrl: string)` — title `${kind} — page ${page}`, one line per row `• ${i}. ${gamertag}${clan ? ` [${clan.tag}]` : ""} — ${value}` numbering from `(page - 1) * perPage + 1`, and a footer that says `hasNext ? "More on the site." : "That is the whole board."`.
- `achievementsEmbed(wall: AchievementWall, subject: string, siteBaseUrl: string)` — title `${subject} — ${wall.earned} earned`, a list of earned tiles (`• ${name}`) and a `Closest` field from `wall.closest` with `• ${name} — ${count}/${target} ${unit}`.

- [ ] **Step 5: Write `stats.ts`**

Three flat command groups. The parts that need care:

```ts
/** R7: one option, autocompleted from the seasons that exist. */
const scopes: AutocompleteSource = async (ctx) => [
  { name: "This season", value: "current" },
  { name: "All time", value: "all" },
  ...(await ctx.roster.seasons()).map((s) => ({ name: `Season ${s.number}`, value: String(s.number) })),
];

const gamertags: AutocompleteSource = async (ctx, a) =>
  (await ctx.roster.suggestGamertags(a.value, "seen")).map((g) => ({ name: g, value: g }));

const board: Handler = async (ctx, input) => {
  const kind = input.string("kind");
  if (!kind || !BOARD_KINDS.includes(kind as BoardKind)) return { content: "Pick a board from the list.", ephemeral: true };
  const scope = parseScope(input.string("scope"));
  const page = Math.max(1, input.integer("page") ?? 1);
  // ⚠️ `mine` routes to a DIFFERENT roster export, not to a local filter:
  // `clanBoardPage` is the one that checks membership, and its refusals are
  // the shared `REFUSAL` strings.
  const result = input.boolean("mine") === true
    ? await ctx.roster.clanBoardPage(input.actorDiscordId, kind as BoardKind, scope, page)
    : await ctx.roster.boardPage(kind as BoardKind, scope, page);
  if (typeof result === "string") return { content: REFUSAL[result], ephemeral: true };
  return { embeds: [boardEmbed(result, ctx.siteBaseUrl)], ephemeral: true };
};

/**
 * `/achievements` — a player's wall or a clan's. With neither option given,
 * the caller's own, resolved through `linkStatus` rather than guessed.
 */
const achievements: Handler = async (ctx, input) => {
  const clan = input.string("clan");
  if (clan) {
    const wall = await ctx.roster.achievementsFor({ clanTag: clan });
    return wall
      ? { embeds: [achievementsEmbed(wall, `[${clan.toUpperCase()}]`, ctx.siteBaseUrl)], ephemeral: true }
      : { content: discordCopy("request", "no-such-clan"), ephemeral: true };
  }
  let gamertag = input.string("gamertag");
  if (!gamertag) {
    const status = await ctx.roster.linkStatus(input.actorDiscordId);
    if (!status.link) return { content: REFUSAL["not-linked"], ephemeral: true };
    gamertag = status.link.gamertag;
  }
  const wall = await ctx.roster.achievementsFor({ gamertag });
  return wall
    ? { embeds: [achievementsEmbed(wall, gamertag, ctx.siteBaseUrl)], ephemeral: true }
    : { content: "No player by that name has been seen on the server.", ephemeral: true };
};
```

Registration:

```
/player      gamertag: (required, autocomplete)  scope: (autocomplete)
/board       kind: (choices from BOARD_KINDS)  scope: (autocomplete)  page: (integer, min 1)  mine: (boolean)
/achievements  gamertag: (autocomplete)  clan: (autocomplete from directory)
```

⚠️ `BOARD_KINDS` is nine values and Discord allows 25 choices, so render them as `addChoices`, not autocomplete. Give each a readable name (`"Raiders"`, `"K/D"`, `"Longest kills"`, …) rather than the raw key.

⚠️ `/achievements`'s "no player by that name" sentence is the one new player-facing string in this task. Every other sentence comes from `@factions/copy`. If the reviewer objects, move it to `packages/copy/src/stats.ts` rather than arguing the exception — a new copy file is cheap and the constraint is the point.

- [ ] **Step 6: Register, run, typecheck**

Add the three groups to `GROUPS`.

Run: `pnpm --filter @factions/bot test commands-stats parse command-registration` then `pnpm --filter @factions/bot typecheck && pnpm --filter @factions/bot test`, both with Bash `timeout: 600000`.
Expected: all clean.

- [ ] **Step 7: Commit**

```bash
git add apps/bot/src/commands/stats.ts apps/bot/src/commands/embeds/stats.ts apps/bot/src/commands/parse.ts apps/bot/src/commands/index.ts apps/bot/test/commands-stats.test.ts apps/bot/test/parse.test.ts
git commit -m "feat(bot): /player, /board and /achievements"
```

---

### Task 7: Delete the retirement, close the parity list, and prove one command end to end against a database

Parity is complete after Task 6, which is the condition `retired-commands.ts`'s own comment sets for its removal. This task removes it, replaces what it was doing (R9), empties `PENDING`, and adds the one test the whole command layer still lacks: every handler test so far stubs the roster, so nothing anywhere proves a slash command actually writes a row.

**Files:**
- Delete: `apps/bot/src/retired-commands.ts`, `apps/bot/test/retired-commands.test.ts`
- Modify: `apps/bot/src/discord.ts`, `apps/bot/src/commands/index.ts`, `apps/bot/test/parity.test.ts`, `apps/bot/test/vocabulary.test.ts`, `CLAUDE.md`
- Test: `apps/bot/test/commands-e2e.test.ts` (create)

**Interfaces:**
- Consumes: `UNKNOWN` from `commands/route.js` (already exported); `makeRoster` from `@factions/roster`; `seedFaction` from `apps/bot/test/seed.js`.
- Produces: nothing new. This task only removes and closes.

- [ ] **Step 1: Write the failing end-to-end test**

`apps/bot/test/commands-e2e.test.ts`. One command, over a real database, through the real `makeRoster` — not a stub:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, vaultLocks, type Database } from "@factions/db";
import { eq } from "drizzle-orm";
import { makeRoster } from "@factions/roster";
import { vaultGroup } from "../src/commands/vault.js";
import { specOf } from "./command-fakes.js";
import { seedFaction } from "./seed.js";

/**
 * ⚠️ The only test in `apps/bot` that runs a command against a database.
 * Every other command test stubs the roster, which proves the handler asks
 * the right question but never that the answer lands in a row — so a wiring
 * mistake between `makeRoster` and the handler (a wrong argument order, a
 * dropped field) would pass the entire suite. One command is enough to hold
 * that wire down; this is not a second copy of the vault's unit tests.
 */
describe("a slash command, end to end", () => {
  const URL = requireTestDatabaseUrl();
  let db: Database;
  const now = new Date("2026-09-13T12:00:00Z");

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    // Truncate and seed the same way roster-store.test.ts does — copy that
    // file's beforeEach rather than inventing a second reset.
  });

  it("writes the lock /vault add's modal described, and /vault list reads it back", async () => {
    // Seed a server, an active clan, a linked leader — see seed.ts.
    const ctx = { roster: makeRoster(() => db, () => now), now, siteBaseUrl: "https://x" };

    const added = await vaultGroup.modals!["vault-add"](ctx, {
      actorDiscordId: LEADER_DISCORD, arg: "officer",
      field: (n) => ({ name: "Front gate", note: "the big one", code: "1234" })[n] ?? "",
    });
    expect(added.content).toBe("Lock added.");

    const rows = await db.select().from(vaultLocks).where(eq(vaultLocks.factionId, factionId));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.name).toBe("Front gate");
    expect(rows[0]!.minRole).toBe("officer");

    const listed = await specOf(vaultGroup, "vault list").handler(ctx, {
      actorDiscordId: LEADER_DISCORD, string: () => null, integer: () => null, boolean: () => null, user: () => null,
    });
    expect(JSON.stringify(listed.embeds![0].toJSON())).toContain("Front gate");
    // ⚠️ And the code is nowhere in the card.
    expect(JSON.stringify(listed.embeds![0].toJSON())).not.toContain("1234");
  });
});
```

⚠️ `makeRoster`'s real signature is `makeRoster(getDb, getNow)` — check it in `packages/roster/src/api.ts` and match it exactly rather than trusting the sketch above. Fill in the seeding and the truncate from `apps/bot/test/roster-store.test.ts`, which already does both correctly for this schema.

- [ ] **Step 2: Run it and make it pass**

Run: `pnpm --filter @factions/bot test commands-e2e` with Bash `timeout: 600000`.
Expected: PASS once seeding is right. If the seed fights the schema, fix the seed — do not weaken the assertions.

- [ ] **Step 3: Commit the end-to-end test**

```bash
git add apps/bot/test/commands-e2e.test.ts
git commit -m "test(bot): one slash command end to end, against a database"
```

- [ ] **Step 4: Close the parity list**

In `apps/bot/test/parity.test.ts`, move all eight entries into `COMMANDS`:

```ts
  addLock: "vault add", editLock: "vault edit", deleteLock: "vault delete",
  revealLock: "vault reveal", confirmLock: "vault confirm", rotateLocks: "vault rotate",
  dropPin: "map pin", deletePin: "map unpin",
```

and leave `PENDING` declared but empty, with its comment rewritten:

```ts
/**
 * Empty, and that is the point: every write `@factions/roster` exports has a
 * command. A new write lands here only if a future increment ships one
 * without a Discord command — and then this file says which plan owes it.
 */
const PENDING: Record<string, string> = {};
```

⚠️ Do not delete `PENDING`. The third test's `unaccounted` check reads it, and the empty object is what makes "parity is complete" a fact the suite re-checks on every run rather than a claim in a commit message.

Also add the four flat read commands and the vault/map subcommands to the file's header comment if it enumerates them.

- [ ] **Step 5: Delete the retirement and replace its fallback**

Delete `apps/bot/src/retired-commands.ts` and `apps/bot/test/retired-commands.test.ts`.

In `apps/bot/src/commands/index.ts`, drop the `RETIRED_COMMANDS`/`RETIRED_DESCRIPTION` import, delete the `⚠️ The retired stubs stay registered…` comment block, and reduce `buildCommands()` to:

```ts
export function buildCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return GROUPS.map((g) => g.command.toJSON());
}
```

In `apps/bot/src/discord.ts`, drop `import { retiredReply }` and replace both fallback branches with one (R9):

```ts
      // Nothing routed it: an unknown command name from a stale client, or a
      // button on a message the pre-plan-1 bot posted. One sentence and a
      // link, never discord.js's "unknown command" and never silence.
      if (interaction.isChatInputCommand() || interaction.isMessageComponent()) {
        await interaction.reply({ content: `${UNKNOWN} ${cfg.siteBaseUrl}`, flags: MessageFlags.Ephemeral });
      }
```

with `import { UNKNOWN } from "./commands/route.js";` — or via the existing `export { buildCommands } from "./commands/index.js"` neighbourhood, whichever keeps the import list tidy.

⚠️ Keep the outer try/catch exactly as it is. discord.js does not await this listener and an uncaught throw is an unhandled rejection that takes the bot down.

- [ ] **Step 6: Drop `retired-commands.ts` from the vocabulary list**

In `apps/bot/test/vocabulary.test.ts`, remove `"retired-commands.ts"` and the `// Increment 2c-b: the one reply every retired command gives.` comment above it from `PLAYER_FACING`. The file no longer exists and `readFileSync` will throw.

- [ ] **Step 7: Update CLAUDE.md**

Rewrite the command-surface paragraph (around line 236) so it describes what is true after this plan:

- the live command list is `/link /base /me /roster /clan /clans /lead /found /guest /vault /map /scoreboard /alphas /seasons /warlog /player /board /achievements`;
- `parity.test.ts`'s `PENDING` is empty — every roster write has a command, and the test fails if a new write lands without one;
- the retired stubs and `retired-commands.ts` are **gone**; an unrouted interaction gets `route.ts`'s `UNKNOWN` sentence plus the site link;
- the ephemeral invariant is unchanged and still enforced by `command-registration.test.ts`;
- name `docs/deploy/2026-09-13-discord-commands-3.md` as the runbook.

⚠️ The retired-stub invariant in CLAUDE.md is being **removed**, not amended. Say plainly in the commit message that this plan reverses it, and why: the condition the stubs' own comment named — "deleted only when parity is complete" — is now met.

- [ ] **Step 8: Run the whole bot suite and typecheck**

Run: `pnpm --filter @factions/bot typecheck && pnpm --filter @factions/bot test` with Bash `timeout: 600000`.
Expected: clean, with `retired-commands.test.ts` gone and `parity.test.ts` green on an empty `PENDING`.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "feat(bot): delete the retired stubs — parity is complete"
```

---

### Task 8: The runbook, the acceptance note, and the whole gate

**Files:**
- Create: `docs/deploy/2026-09-13-discord-commands-3.md`
- Create: `docs/acceptance/2026-09-13-discord-commands-3.md`

- [ ] **Step 1: Write the deploy runbook**

Model it on `docs/deploy/2026-09-13-discord-commands-2.md`, which is the shape this project's runbooks take. It must say, in this order:

1. **No migration.** Nothing in this deploy touches `factions_live`'s schema.
2. **⚠️ Tell players before you deploy this.** Registration is one PUT at boot and replaces the whole list. The retired stubs `/unlink`, `/whoami` and `/faction` **stop existing** the moment the bot restarts. A player who types `/whoami` today gets a pointer to the site; after this deploy they get Discord's "unknown command" from the client's own cache and, once it refreshes, nothing at all. Nine new commands appear in the same instant.
3. **The order**, unchanged from plan 2 and for the same reasons — stop the unit (⚠️ never `pkill -f "src/main.ts"`: ~15 dayzonelife.com services match that pattern), `git pull --ff-only`, install, start, then read `journalctl -u clan-wars-bot -n 40 --no-pager` for the ready line. ⚠️ `active (running)` is not evidence: the bot holds no eager database connection and every tick is individually try/caught, so one pointed at a dead database runs happily with everything broken.
4. **⚠️ `pnpm` is not on the non-interactive ssh PATH.** Plan 2's deploy hit `pnpm: command not found` with the bot already stopped. The unit file names the real path — use `/home/acab/.local/bin/pnpm install`, not bare `pnpm install`. (Plan 2's runbook says bare `pnpm install`; this line is the correction.)
5. **Web is unaffected.** `apps/bot` only. Do not run `deploy-web.sh`.
6. **Rollback:** stop, `git checkout <previous sha>`, install, start. The old `buildCommands()` PUT restores the previous list, retired stubs included. Nothing this deploy writes is unreadable by the old bot — no migration, no new column, no new row shape.

- [ ] **Step 2: Write the acceptance note**

`docs/acceptance/2026-09-13-discord-commands-3.md`, per the project's convention. The automated half is the gate (below). The manual half is a pass in the guild:

- `/vault add` opens a modal; the code field is in the modal and **not** in the command bar.
- `/vault reveal` shows the code **to you only**.
- `/vault list` shows the locks and **no code**.
- `/vault delete` and `/vault rotate` each show a Confirm button and write nothing until it is pressed.
- `/map pin x: z: icon:` drops a pin; `/map pins` lists it; `/map unpin` removes it, and its autocomplete shows **no coordinate**.
- `/map view` answers with the link.
- `/scoreboard`, `/alphas`, `/seasons`, `/warlog`, `/player`, `/board`, `/achievements` each render.
- `/whoami` is gone.

⚠️ Head the manual list with the same warning plan 2's runbook carries: **confirm every one of these replies is ephemeral — only you can see it.** A clan's roster, its own base and its vault are all raid targets, and a vault code in a public reply is a raid tonight.

- [ ] **Step 3: Run the full gate, uncached**

Run: `npx turbo run typecheck test --concurrency=1 --force` with Bash `timeout: 600000`.

⚠️ `--force` and `--concurrency=1` are both load-bearing. A FULL TURBO cache hit proves nothing about a tree the cache did not see, and concurrent tasks share the `factions_test_<package>` databases and drop each other's.
Expected: every task green.

- [ ] **Step 4: Commit**

```bash
git add docs/deploy/2026-09-13-discord-commands-3.md docs/acceptance/2026-09-13-discord-commands-3.md
git commit -m "docs: deploy runbook and acceptance for the plan 3 commands"
```
