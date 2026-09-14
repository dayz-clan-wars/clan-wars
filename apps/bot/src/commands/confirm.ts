import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from "discord.js";
import type { Reply } from "./types.js";

/**
 * Namespaced so the router claims only its own components (R5): `discord.ts`
 * still answers un-routed ones with `UNKNOWN` and a site link, for buttons on
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
