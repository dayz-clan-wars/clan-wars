import { SlashCommandBuilder } from "discord.js";
import { discordLeadershipCopy } from "@factions/copy";
import { confirmReply } from "./confirm.js";
import type { CommandGroup, ComponentHandler, Handler } from "./types.js";

/** R2. `claimSuccession` is not called until the button is pressed. */
const claim: Handler = async (_ctx, input) =>
  confirmReply("claim", input.actorDiscordId, discordLeadershipCopy("claim-succession", "unconfirmed"));

const confirmClaim: ComponentHandler = async (ctx, a) =>
  ({ content: discordLeadershipCopy("claim-succession", await ctx.roster.claimSuccession(a.actorDiscordId)), ephemeral: true });

/** R2. The nominee travels in the confirm button's custom id, not a write here. */
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

/** R3: cast straight through, as the site does — no checkbox to gate this behind. */
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
