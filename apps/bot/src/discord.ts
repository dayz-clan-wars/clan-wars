import {
  Client, GatewayIntentBits, REST, Routes, MessageFlags,
  SlashCommandBuilder, type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import { createClient } from "@factions/db";
import { handleLink, handleUnlink, handleWhoami, type CommandDeps, type Reply } from "./commands.js";
import { PgVerificationStore } from "./store.js";
import { verificationTick } from "./tick.js";
import type { BotConfig } from "./config.js";

export function buildCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder().setName("link")
      .setDescription("Bind your Discord account to your in-game character"),
    new SlashCommandBuilder().setName("unlink")
      .setDescription("Remove the binding between your Discord account and your character"),
    new SlashCommandBuilder().setName("whoami")
      .setDescription("Show which character your Discord account is linked to"),
  ].map((c) => c.toJSON());
}

/** The subset of a discord.js interaction the router needs. Kept structural so tests need no client. */
export type InteractionLike = {
  commandName: string;
  userId: string;
  guildId: string | null;
  channelId: string;
};

export async function routeInteraction(deps: CommandDeps, i: InteractionLike): Promise<Reply | null> {
  const known = i.commandName === "link" || i.commandName === "unlink" || i.commandName === "whoami";
  if (!known) return null;

  // Identity is guild-scoped in practice (spec §16) and a DM has no guild to
  // record on the challenge, so refuse rather than write a null guild id.
  if (i.guildId === null) {
    return { content: "Run this in the server, not in a DM.", ephemeral: true };
  }

  const ctx = { discordId: i.userId, guildId: i.guildId, channelId: i.channelId };
  if (i.commandName === "link") return handleLink(deps, ctx);
  if (i.commandName === "unlink") return handleUnlink(deps, i.userId);
  return handleWhoami(deps, i.userId);
}

export type Notification = { discordId: string; channelId: string; content: string };
export type Sender = (n: Notification) => Promise<void>;

/**
 * Tell each newly verified player, exactly once.
 *
 * `markNotified` runs only after `send` resolves. A send that throws — closed
 * DMs, a deleted channel, a rate limit — leaves the row pending so the next
 * pass retries, rather than marking it done and dropping the message.
 */
export async function notifyCompleted(deps: CommandDeps, send: Sender): Promise<number> {
  let sent = 0;
  for (const c of await deps.store.pendingNotifications()) {
    try {
      await send({
        discordId: c.discordId,
        channelId: c.channelId,
        content: "Verified — your Discord account is now linked to your character.",
      });
      await deps.store.markNotified(c.id, deps.now());
      sent++;
    } catch (err) {
      console.error(`notify failed for challenge ${c.id}`, err);
    }
  }
  return sent;
}

export async function start(cfg: BotConfig): Promise<void> {
  const db = createClient(cfg.databaseUrl);
  const store = new PgVerificationStore(db);
  const deps: CommandDeps = {
    store, rng: Math.random, now: () => new Date(), challengeTtlMs: cfg.challengeTtlMs,
  };

  await new REST().setToken(cfg.token).put(
    Routes.applicationGuildCommands(cfg.applicationId, cfg.guildId),
    { body: buildCommands() },
  );

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const reply = await routeInteraction(deps, {
      commandName: interaction.commandName,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
    });
    if (!reply) return;
    await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral });
  });

  const send: Sender = async (n) => {
    // DM first; fall back to the channel /link was run in, because a player
    // with closed DMs would otherwise never learn they succeeded.
    try {
      const user = await client.users.fetch(n.discordId);
      await user.send(n.content);
    } catch {
      const channel = await client.channels.fetch(n.channelId);
      if (channel?.isSendable()) await channel.send(`<@${n.discordId}> ${n.content}`);
      else throw new Error(`no reachable surface for ${n.discordId}`);
    }
  };

  let interval: NodeJS.Timeout | undefined;

  client.once("clientReady", () => {
    console.log(`bot ready as ${client.user?.tag}`);
    interval = setInterval(() => {
      void (async () => {
        try {
          const r = await verificationTick(db, store);
          if (r.verified > 0 || r.alreadyLinked > 0) {
            console.log(`verified ${r.verified}, refused ${r.alreadyLinked} (already linked)`);
          }
          await notifyCompleted(deps, send);
        } catch (err) {
          // A thrown tick must not kill the interval and silently stop all verification.
          console.error("tick failed", err);
        }
      })();
    }, cfg.tickIntervalMs);
  });

  // A container stop (SIGTERM) or Ctrl-C (SIGINT) must not leave an in-flight
  // tick mid-transaction: clear the interval and drop the gateway connection
  // before the process exits.
  const shutdown = () => {
    if (interval) clearInterval(interval);
    client.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  await client.login(cfg.token);
}
