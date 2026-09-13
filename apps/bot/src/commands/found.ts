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
  // The flag and crew selects refine the card the player is looking at. The
  // "Name it" button is not here: it opens a modal, and a modal opener must
  // not be acknowledged at all.
  updatesInPlace: ["found-flag", "found-crew"],
};
