import { SlashCommandBuilder, PermissionFlagsBits } from "discord.js";
import { awardsCatalogue } from "@factions/domain/awards";
import { grantAwardDb, revokeAwardDb, listAwardsDb, type AwardListRow } from "@factions/roster/internal";
import type { AutocompleteSource, CommandGroup, Ctx, CommandInput, Reply } from "./types.js";

const reply = (content: string): Reply => ({ content, ephemeral: true });
const ADMIN_ONLY = reply("Only an admin can hand out or take back awards.");

/**
 * ⚠️ Parsed at module scope, as the worker does: a malformed catalogue stops
 * the bot at startup rather than failing the first `/award grant` of an event.
 */
const AWARDS = awardsCatalogue();

const STATE: Record<AwardListRow["state"], string> = {
  unplaced: "not placed yet", waiting: "placed, spawns next restart", live: "live",
  lapsed: "lapsed", expired: "expired", revoked: "revoked",
};

/** "#12 Plate Carrier — <@1> — live until <t:…:f>". The `<@…>` renders only in the reply, not in autocomplete. */
function summarize(r: AwardListRow, mention: boolean): string {
  const who = mention ? `<@${r.discordId}>` : r.discordId;
  const until = r.state === "live" && r.expiresAt
    ? ` until <t:${Math.floor(r.expiresAt.getTime() / 1000)}:f>`
    : r.state === "unplaced" ? ` (place by <t:${Math.floor(r.placeBy.getTime() / 1000)}:f>)` : "";
  return `#${r.id} ${r.label}: ${who}, ${STATE[r.state]}${mention ? until : ""}`;
}

/**
 * Hand an event winner an award.
 *
 * ⚠️ `isAdmin` is checked here as well as by `setDefaultMemberPermissions`,
 * for `/airdrop place`'s reason: a channel permission overwrite can put the
 * command back in front of a member, and granting loot is not something a
 * member gets to do by finding a gap in a UI.
 */
async function grant(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return ADMIN_ONLY;
  const winner = input.user("user");
  if (!winner) return reply("Pick the winner.");
  const out = await grantAwardDb(ctx.db, {
    awardKey: input.string("award") ?? "", winnerDiscordId: winner, grantedByDiscordId: input.actorDiscordId,
    reason: input.string("reason") ?? "", siteBaseUrl: ctx.siteBaseUrl, now: ctx.now,
  });
  if (!out.ok) {
    return reply({
      "unknown-award": `${input.string("award") ?? "That"} is not an award. Pick one from the list.`,
      "no-reason": "Say what they won it for. It goes in their DM.",
      "no-server": "There is no active server to spawn it on.",
    }[out.reason]);
  }
  console.log(`award: ${input.actorDiscordId} granted #${out.grantId} ${input.string("award")} to ${winner}`);
  return reply([
    `Granted **${AWARDS[input.string("award")!]!.label}** to <@${winner}> as #${out.grantId}.`,
    `They have until <t:${Math.floor(out.placeBy.getTime() / 1000)}:f> to place it. A DM with the link is on its way.`,
  ].join("\n"));
}

async function revoke(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return ADMIN_ONLY;
  const id = Number(input.string("grant"));
  if (!Number.isInteger(id) || id <= 0) return reply("Pick a grant from the list.");
  const out = await revokeAwardDb(ctx.db, { grantId: id, now: ctx.now });
  if (!out.ok) return reply(out.reason === "not-found" ? `There is no award #${id}.` : `Award #${id} has already ended.`);
  console.log(`award: ${input.actorDiscordId} revoked #${id}`);
  return reply(`Award #${id} revoked. It stops spawning at the next restart. The winner is not told, so tell them.`);
}

async function list(ctx: Ctx, input: CommandInput): Promise<Reply> {
  if (!input.isAdmin) return ADMIN_ONLY;
  const rows = await listAwardsDb(ctx.db, { discordId: input.user("user"), now: ctx.now });
  if (rows.length === 0) return reply("There are no open awards.");
  return reply(rows.map((r) => summarize(r, true)).join("\n"));
}

/** Discord gives autocomplete 3 seconds and 25 choices; `listAwardsDb` is one indexed read capped at 25. */
const openGrants: AutocompleteSource = async (ctx, a) => {
  const rows = await listAwardsDb(ctx.db, { discordId: null, now: ctx.now });
  const q = a.value.toLowerCase();
  return rows
    .filter((r) => !q || summarize(r, false).toLowerCase().includes(q))
    .map((r) => ({ name: summarize(r, false).slice(0, 100), value: String(r.id) }));
};

export const awardGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("award")
    .setDescription("Hand out and manage event awards")
    // ⚠️ Discord's own gate, so members never see it. The handlers check again.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand((c) => c
      .setName("grant").setDescription("Give an event winner an award")
      .addUserOption((o) => o.setName("user").setDescription("The winner").setRequired(true))
      .addStringOption((o) => o
        .setName("award").setDescription("Which award").setRequired(true)
        .addChoices(...Object.values(AWARDS).map((d) => ({ name: d.label, value: d.key }))))
      .addStringOption((o) => o
        .setName("reason").setDescription("What they won it for; shown in their DM").setRequired(true).setMaxLength(200)))
    .addSubcommand((c) => c
      .setName("revoke").setDescription("Take an award back")
      .addStringOption((o) => o.setName("grant").setDescription("Which grant").setRequired(true).setAutocomplete(true)))
    .addSubcommand((c) => c
      .setName("list").setDescription("Show open awards")
      .addUserOption((o) => o.setName("user").setDescription("Only this winner's").setRequired(false))),
  specs: [
    { path: "award grant", handler: grant },
    { path: "award revoke", handler: revoke, autocomplete: { grant: openGrants } },
    { path: "award list", handler: list },
  ],
};
