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

  if (state.locks.length === 0) {
    // ⚠️ `list()` returns early on zero lines, so without this an empty
    // vault would render a blank card — no "0 locks", no sentence at all.
    // A player should be told plainly that there is nothing here yet.
    b.field(embed, "Locks", "No locks yet — add one on the site.");
  } else {
    b.list(embed, `${state.locks.length} lock${state.locks.length === 1 ? "" : "s"}`,
      state.locks.map(lockLine), (n) => `+${n} more — see the site.`);
  }

  if (state.history && state.history.length > 0) {
    b.list(embed, "Recent changes",
      state.history.map((h) => `• ${when(h.at)} — ${h.lockName} ${h.action} by ${h.by}`),
      (n) => `+${n} more — see the site.`);
  }
  return embed;
}
