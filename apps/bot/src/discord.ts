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

// Retrying forever is correct — the binding is real, and the message should
// land the moment it can — but logging every tick forever for a player who
// will never be reachable is not. Log each challenge's failure once per
// process rather than on every retry.
const loggedNotifyFailures = new Set<number>();

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
      if (!loggedNotifyFailures.has(c.id)) {
        console.error(`notify failed for challenge ${c.id}`, err);
        loggedNotifyFailures.add(c.id);
      }
    }
  }
  return sent;
}

/**
 * Wraps an async job so a firing is SKIPPED while the previous one is still
 * running, and exposes the in-flight promise so shutdown can await it.
 *
 * ⚠️ Not a nicety. verificationTick reads a consumer cursor at the start and
 * writes it at the end; two overlapping runs both read the same value, and
 * whichever finishes LAST wins the write — so a slow run can move the cursor
 * backwards and cause already-processed events to be replayed.
 *
 * This guards a SINGLE process only. Running two bot instances against one
 * database would need a Postgres advisory lock keyed on the consumer name
 * instead — see the README.
 */
export function guardedRunner(job: () => Promise<void>): {
  fire: () => void;
  inFlight: () => Promise<void> | null;
  skipped: () => number;
} {
  let running: Promise<void> | null = null;
  let skipped = 0;
  return {
    fire: () => {
      if (running) { skipped++; return; }
      // The rejection is swallowed here, not left for callers to handle: the
      // returned promise exists so shutdown can await "is a run still in
      // flight", and forcing every caller to attach a .catch just to avoid an
      // unhandled rejection would be an easy way to reintroduce this bug.
      running = job()
        .catch((err: unknown) => {
          // Logged, not merely swallowed. Callers today wrap their own body in
          // try/catch so this is a dead-letter backstop — but a future caller
          // that forgets would otherwise fail completely silently, with
          // verification quietly doing nothing and no line anywhere saying so.
          console.error("guarded job failed", err);
        })
        .finally(() => { running = null; });
    },
    inFlight: () => running,
    skipped: () => skipped,
  };
}

export async function start(cfg: BotConfig): Promise<void> {
  const db = createClient(cfg.databaseUrl);
  const store = new PgVerificationStore(db);
  const deps: CommandDeps = {
    store, rng: Math.random, now: () => new Date(), challengeTtlMs: cfg.challengeTtlMs,
  };

  try {
    await new REST().setToken(cfg.token).put(
      Routes.applicationGuildCommands(cfg.applicationId, cfg.guildId),
      { body: buildCommands() },
    );
  } catch (err) {
    console.error(
      "Failed to register slash commands. Check that DISCORD_TOKEN is valid, " +
      "DISCORD_APPLICATION_ID and DISCORD_GUILD_ID are correct, and the bot " +
      "was invited with both the `bot` and `applications.commands` scopes.",
      err,
    );
    process.exit(1);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      const reply = await routeInteraction(deps, {
        commandName: interaction.commandName,
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
      });
      if (!reply) return;
      await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral });
    } catch (err) {
      // ⚠️ discord.js does not await this listener, so an uncaught throw here
      // becomes an unhandled rejection and Node terminates the process. An
      // expired interaction token — which is only a 3-second window — would
      // take the bot down for every player. Log and drop the one interaction.
      console.error(`interaction ${interaction.commandName} failed`, err);
    }
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

  let timer: NodeJS.Timeout | undefined;

  const runner = guardedRunner(async () => {
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
  });

  client.once("clientReady", () => {
    console.log(`bot ready as ${client.user?.tag}`);
    timer = setInterval(() => runner.fire(), cfg.tickIntervalMs);
  });

  const SHUTDOWN_GRACE_MS = 15_000;
  let shuttingDown = false;

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return; // a second Ctrl-C must not re-enter
    shuttingDown = true;
    console.log(`${signal} received, shutting down`);
    if (timer) clearInterval(timer);

    // clearInterval only prevents the NEXT firing. Await the run already in
    // flight so it is not torn down mid-transaction, but bound the wait so a
    // wedged tick cannot block the container stop forever.
    const running = runner.inFlight();
    if (running) {
      let grace: NodeJS.Timeout | undefined;
      await Promise.race([
        running,
        new Promise<void>((resolve) => {
          grace = setTimeout(resolve, SHUTDOWN_GRACE_MS);
          grace.unref(); // must not itself hold the event loop open
        }),
      ]);
      if (grace) clearTimeout(grace);
    }

    await client.destroy();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  await client.login(cfg.token);
}
