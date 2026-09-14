import { SlashCommandBuilder } from "discord.js";
import { BOARD_KINDS, type BoardKind } from "@factions/roster";
import { BOARD_LABELS, discordCopy, NO_PROFILE, REFUSAL } from "@factions/copy";
import { achievementsEmbed, boardEmbed, playerEmbed } from "./embeds/stats.js";
import { matchClans, parseScope } from "./parse.js";
import type { AutocompleteSource, CommandGroup, Handler } from "./types.js";

/** A missing gamertag is BAD INPUT, not a domain outcome; unreachable through a real client since the option is required. */
const NEED_A_GAMERTAG = "Give a gamertag.";
/** Likewise: a `kind:` outside `BOARD_KINDS` never reaches a real client, which only offers the choices below. */
const PICK_A_BOARD = "Pick a board from the list.";

/** R7: one `scope:` option, autocompleted from the seasons that exist. */
const scopes: AutocompleteSource = async (ctx) => [
  { name: "This season", value: "current" },
  { name: "All time", value: "all" },
  ...(await ctx.roster.seasons()).map((s) => ({ name: `Season ${s.number}`, value: String(s.number) })),
];

/** Every gamertag the server has SEEN, not only linked ones — `/player` and `/achievements` both look up strangers. */
const gamertags: AutocompleteSource = async (ctx, a) =>
  (await ctx.roster.suggestGamertags(a.value, "seen")).map((g) => ({ name: g, value: g }));

/** Clan tags off the public directory, for `/achievements clan:`. Plain labels — filtering is shared with `/clans`/`/warlog` via `matchClans`, but their "· recruiting" suffix is `/clans`'s own. */
const clanChoices: AutocompleteSource = async (ctx, a) => {
  const { clans } = await ctx.roster.directory();
  return matchClans(clans, a.value).map((c) => ({ name: `${c.name} [${c.tag}]`, value: c.tag }));
};

const player: Handler = async (ctx, input) => {
  const gamertag = input.string("gamertag");
  if (!gamertag) return { content: NEED_A_GAMERTAG, ephemeral: true };
  const scope = parseScope(input.string("scope"));
  const profile = await ctx.roster.playerProfile(gamertag, scope);
  return profile
    ? { embeds: [playerEmbed(profile, ctx.siteBaseUrl)], ephemeral: true }
    : { content: NO_PROFILE, ephemeral: true };
};

/** ⚠️ `mine` routes to a DIFFERENT roster export, not to a local filter: `clanBoardPage` is the one that checks membership, and its refusals are the shared `REFUSAL` strings. */
const board: Handler = async (ctx, input) => {
  const kind = input.string("kind");
  if (!kind || !(BOARD_KINDS as readonly string[]).includes(kind)) return { content: PICK_A_BOARD, ephemeral: true };
  const scope = parseScope(input.string("scope"));
  const page = Math.max(1, input.integer("page") ?? 1);
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
      ? { embeds: [achievementsEmbed(wall, `[${clan.toUpperCase()}]`, `${ctx.siteBaseUrl}/clans/${clan.toUpperCase()}`)], ephemeral: true }
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
    ? { embeds: [achievementsEmbed(wall, gamertag, `${ctx.siteBaseUrl}/players/${encodeURIComponent(gamertag)}`)], ephemeral: true }
    : { content: NO_PROFILE, ephemeral: true };
};

export const playerGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("player")
    .setDescription("A player's stat card")
    .addStringOption((o) => o.setName("gamertag").setDescription("Which player").setRequired(true).setAutocomplete(true))
    .addStringOption((o) => o.setName("scope").setDescription("Which season").setAutocomplete(true)),
  specs: [{ path: "player", handler: player, autocomplete: { gamertag: gamertags, scope: scopes } }],
};

export const boardGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("board")
    .setDescription("A full board, one page at a time")
    .addStringOption((o) => o.setName("kind").setDescription("Which board").setRequired(true)
      .addChoices(...BOARD_KINDS.map((k) => ({ name: BOARD_LABELS[k], value: k }))))
    .addStringOption((o) => o.setName("scope").setDescription("Which season").setAutocomplete(true))
    .addIntegerOption((o) => o.setName("page").setDescription("Page number").setMinValue(1))
    .addBooleanOption((o) => o.setName("mine").setDescription("Your clan's roster only")),
  specs: [{ path: "board", handler: board, autocomplete: { scope: scopes } }],
};

export const achievementsGroup: CommandGroup = {
  command: new SlashCommandBuilder()
    .setName("achievements")
    .setDescription("A wall of achievements")
    .addStringOption((o) => o.setName("gamertag").setDescription("A player's wall").setAutocomplete(true))
    .addStringOption((o) => o.setName("clan").setDescription("A clan's wall").setAutocomplete(true)),
  specs: [{ path: "achievements", handler: achievements, autocomplete: { gamertag: gamertags, clan: clanChoices } }],
};

