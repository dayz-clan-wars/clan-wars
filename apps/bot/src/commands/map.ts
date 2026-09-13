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
