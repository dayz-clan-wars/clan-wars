import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { airdropEvents, kothEvents, servers } from "@factions/db";
import {
  KOTH_LOCATIONS, KOTH_REMINDER_LEAD_MS, RESTART_PERIOD_MS, isRestartSlot, kothLocation, kothStandings, nextRestartAt,
  restartSlot,
} from "@factions/domain";
import { awardsCatalogue } from "@factions/domain/awards";
import { and, eq, inArray } from "drizzle-orm";
import { kothPrize, reminderMinutes, scheduledText } from "../koth-text.js";
import { kothKills, kothOpenedAt } from "../koth-score.js";
import { escapeMarkdown } from "../site-links.js";
import type { AutocompleteSource, CommandGroup, Ctx, CommandInput, Reply } from "./types.js";

const reply = (content: string): Reply => ({ content, ephemeral: true });

/**
 * The `prize` option's value for "no prize". ⚠️ The option is REQUIRED, so a
 * prize-less event is always a choice somebody made, never a field left blank.
 */
const NO_PRIZE = "none";
const prizeName = (key: string | null) => kothPrize(key)?.label ?? "no prize";

/** Postgres' `unique_violation`. postgres.js hangs it on the error object as `code`. */
const UNIQUE_VIOLATION = "23505";

/**
 * ⚠️ The open-check above the insert is a plain SELECT, not a lock — two
 * concurrent `/koth schedule` calls can both pass it and both reach the
 * INSERT. `koth_events_one_open` (or, for two calls racing the same slot,
 * `koth_events_slot_uq`) is what actually prevents the second row; this is
 * what turns that DB-level refusal back into the same friendly reply instead
 * of the router's generic failure text. Anything else rethrows.
 */
function uniqueViolation(err: unknown): string | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { code?: unknown; constraint_name?: unknown };
  if (e.code !== UNIQUE_VIOLATION) return null;
  return typeof e.constraint_name === "string" ? e.constraint_name : "";
}

async function activeServer(ctx: Ctx) {
  return (await ctx.db.select({ id: servers.id }).from(servers).where(eq(servers.active, true)).limit(1))[0] ?? null;
}

/**
 * ⚠️ Row first, post second, and FAILED if the post throws — `/airdrop place`'s
 * shape, for its reason: an event nobody was told about is one nobody comes to,
 * and `kothWanted` refuses to open a row with no `announced_at`.
 */
async function schedule(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return reply("Only an admin can schedule King of the Hill.");
  if (!ctx.koth) return reply("KOTH_TICK is off, so nothing would ever run this event. Turn it on first.");
  const loc = kothLocation((input.string("location") ?? "").toLowerCase());
  if (!loc) return reply(`That is not one of the ${KOTH_LOCATIONS.length} KotH towns.`);
  const asked = input.string("prize") ?? "";
  if (asked !== NO_PRIZE && !awardsCatalogue()[asked]) return reply("Pick a prize from the list, or No prize.");
  const awardKey = asked === NO_PRIZE ? null : asked;
  const slot = new Date(input.string("at") ?? "");
  if (Number.isNaN(slot.getTime()) || !isRestartSlot(slot)) return reply("Pick a restart slot from the list.");
  if (slot.getTime() - ctx.now.getTime() < KOTH_REMINDER_LEAD_MS) {
    return reply(`That slot is under ${reminderMinutes} minutes away. Pick a later one, so players get the reminder.`);
  }

  const server = await activeServer(ctx);
  if (!server) return reply("No active server.");
  const open = await ctx.db.select({ id: kothEvents.id }).from(kothEvents)
    .where(and(eq(kothEvents.serverId, server.id), inArray(kothEvents.state, ["scheduled", "live"])));
  if (open.length > 0) return reply("A King of the Hill event is already scheduled or live. Only one at a time.");
  // ⚠️ Spec §2.12: one session cannot hold both. The airdrop side refuses too.
  const drop = await ctx.db.select({ slotAt: airdropEvents.slotAt }).from(airdropEvents).where(and(
    eq(airdropEvents.serverId, server.id), eq(airdropEvents.slotAt, slot), inArray(airdropEvents.state, ["announced", "live"]),
  ));
  if (drop.length > 0) return reply("An airdrop is already set for that session. Pick another slot.");

  let row: { id: number } | undefined;
  try {
    [row] = await ctx.db.insert(kothEvents).values({
      serverId: server.id, slotAt: slot, location: loc.slug, centreX: String(loc.centreX), centreZ: String(loc.centreZ),
      state: "scheduled", origin: "admin", scheduledByDiscordId: input.actorDiscordId, awardKey,
    }).returning({ id: kothEvents.id });
  } catch (err) {
    const constraint = uniqueViolation(err);
    if (constraint === null) throw err;
    if (constraint === "koth_events_slot_uq") return reply("Another King of the Hill event just took that slot. Pick another.");
    return reply("A King of the Hill event is already scheduled or live. Only one at a time.");
  }
  try {
    await ctx.koth(scheduledText(loc.name, slot, kothPrize(awardKey)));
  } catch (err) {
    await ctx.db.update(kothEvents).set({ state: "failed", detail: { failure: "never announced" } }).where(eq(kothEvents.id, row!.id));
    console.error("koth: scheduled announcement failed to post — nothing scheduled", err);
    return reply("I could not post the announcement, so I have not scheduled it. Check SERVER_EVENTS_CHANNEL_ID.");
  }
  await ctx.db.update(kothEvents).set({ announcedAt: ctx.now }).where(eq(kothEvents.id, row!.id));
  return reply(`Scheduled: **${loc.name}**, for ${prizeName(awardKey)}, opening at the ${slot.toISOString()} restart and ending at the next one.`);
}

async function cancel(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return reply("Only an admin can cancel King of the Hill.");
  const server = await activeServer(ctx);
  if (!server) return reply("No active server.");
  const [row] = await ctx.db.select().from(kothEvents)
    .where(and(eq(kothEvents.serverId, server.id), inArray(kothEvents.state, ["scheduled", "live"])));
  if (!row) return reply("Nothing is scheduled.");
  // ⚠️ A live session is already on the server; the next restart ends it anyway.
  if (row.state === "live") return reply("It is already live. It ends at the next restart.");
  // ⚠️ The opening slot is now: the restart tick may be writing the town's files
  // and the presets this very pass. Cancelling under it would leave a row
  // `cancelled` over a server that boots into KotH anyway, with a cancellation
  // posted for a session that is running. The next restart ends it regardless.
  if (row.slotAt.getTime() === restartSlot(ctx.now).start.getTime()) {
    return reply("It is opening this slot, so it is too late to cancel. It ends at the next restart.");
  }
  await ctx.db.update(kothEvents).set({ state: "cancelled" }).where(and(eq(kothEvents.id, row.id), eq(kothEvents.state, "scheduled")));
  return reply(`Cancelled ${kothLocation(row.location)?.name ?? row.location}. The channel will be told.`);
}

async function status(ctx: Ctx, _input: CommandInput): Promise<Reply> {
  const server = await activeServer(ctx);
  if (!server) return reply("No active server.");
  const [row] = await ctx.db.select().from(kothEvents)
    .where(and(eq(kothEvents.serverId, server.id), inArray(kothEvents.state, ["scheduled", "live"])));
  if (!row) return reply("No King of the Hill event is scheduled.");
  const head = `${kothLocation(row.location)?.name ?? row.location}: ${row.state}, slot ${row.slotAt.toISOString()}, prize: ${prizeName(row.awardKey)}.`;
  if (row.state !== "live") return reply(head);
  // Spec §7: the standings so far, by the same reads the final score uses. Not
  // settled — log lag means the last minutes may still be arriving.
  const { kills } = await kothKills(ctx.db, row, { from: await kothOpenedAt(ctx.db, row), to: ctx.now });
  const top = kothStandings(kills).slice(0, 5);
  if (top.length === 0) return reply(`${head}\nNo kills on the hill yet.`);
  // ⚠️ Gamertags are player-controlled; the house escaper keeps them from restyling the reply.
  return reply([head, "Standings so far:", ...top.map((t, i) => `${i + 1}. ${escapeMarkdown(t.gamertag)} — ${t.kills}`)].join("\n"));
}

const towns: AutocompleteSource = async (_ctx, a) => KOTH_LOCATIONS
  .filter((l) => l.name.toLowerCase().startsWith(a.value.toLowerCase()) || l.slug.startsWith(a.value.toLowerCase()))
  .slice(0, 25).map((l) => ({ name: l.name, value: l.slug }));

/** The next 7 days of slots, capped at Discord's 25 choices, skipping any under the reminder lead. */
const slots: AutocompleteSource = async (ctx, a) => {
  const out: { name: string; value: string }[] = [];
  for (let t = nextRestartAt(ctx.now).getTime(); out.length < 25 && t < ctx.now.getTime() + 7 * 86_400_000; t += RESTART_PERIOD_MS) {
    if (t - ctx.now.getTime() < KOTH_REMINDER_LEAD_MS) continue;
    const iso = new Date(t).toISOString();
    const name = `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
    if (name.includes(a.value)) out.push({ name, value: iso });
  }
  return out;
};

export const kothGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("koth").setDescription("King of the Hill")
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((c) => c.setName("schedule").setDescription("Schedule a one-session King of the Hill")
      .addStringOption((o) => o.setName("location").setDescription("The town").setRequired(true).setAutocomplete(true))
      .addStringOption((o) => o.setName("at").setDescription("The restart that opens it").setRequired(true).setAutocomplete(true))
      // Choices from the award catalogue, so a new award shows up here without a code change.
      .addStringOption((o) => o.setName("prize").setDescription("What the top killer wins").setRequired(true)
        .addChoices(...Object.entries(awardsCatalogue()).map(([key, a]) => ({ name: a.label, value: key })), { name: "No prize", value: NO_PRIZE })))
    .addSubcommand((c) => c.setName("cancel").setDescription("Cancel the scheduled event"))
    .addSubcommand((c) => c.setName("status").setDescription("Show the scheduled or live event")),
  specs: [
    { path: "koth schedule", handler: schedule, autocomplete: { location: towns, at: slots } },
    { path: "koth cancel", handler: cancel },
    { path: "koth status", handler: status },
  ],
};
