import {
  Client, GatewayIntentBits, REST, Routes, MessageFlags,
  SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder,
  type RESTPostAPIApplicationCommandsJSONBody, type InteractionEditReplyOptions,
} from "discord.js";
import { createClient } from "@factions/db";
import { CLAIMABLE_FLAGS } from "@factions/domain";
import { handleLink, handleUnlink, handleWhoami, type CommandDeps, type Reply } from "./commands.js";
import { PgVerificationStore } from "./store.js";
import { verificationTick } from "./tick.js";
import type { BotConfig } from "./config.js";
import { createNotifyFailureLog, type NotifyFailureLog, type Sender } from "./notify.js";
import { handleFactionClaim, handleClaimConfirm, type FactionDeps, type FactionReply } from "./faction-commands.js";
import { PgFactionStore } from "./faction-store.js";
import { PgCeremonyStore } from "./ceremony-store.js";
import { ceremonyTick } from "./ceremony-tick.js";
import { notifyCeremonies } from "./ceremony-notify.js";

export function buildCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return [
    new SlashCommandBuilder().setName("link")
      .setDescription("Bind your Discord account to your in-game character"),
    new SlashCommandBuilder().setName("unlink")
      .setDescription("Remove the binding between your Discord account and your character"),
    new SlashCommandBuilder().setName("whoami")
      .setDescription("Show which character your Discord account is linked to"),
    new SlashCommandBuilder().setName("faction")
      .setDescription("Faction commands")
      .addSubcommand((s) => s.setName("claim")
        .setDescription("Found a faction from a ceremony you took part in")
        .addStringOption((o) => o.setName("name").setDescription("Faction name").setRequired(true).setMaxLength(64))
        .addStringOption((o) => o.setName("tag").setDescription("Short tag, 2-5 letters or digits").setRequired(true).setMaxLength(5))
        .addStringOption((o) => o.setName("flag").setDescription("One of the 33 claimable flags").setRequired(true).setAutocomplete(true))),
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

export const CLAIM_PREFIX = "claim-confirm:";

/** Discord caps a custom id at 100 characters, which is why only the id rides here. */
export const claimCustomId = (ceremonyId: number): string => `${CLAIM_PREFIX}${ceremonyId}`;

export function parseClaimCustomId(customId: string): number | null {
  if (!customId.startsWith(CLAIM_PREFIX)) return null;
  const n = Number(customId.slice(CLAIM_PREFIX.length));
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

export type ComponentLike = { customId: string; userId: string; values: string[] };

export async function routeComponent(deps: FactionDeps, i: ComponentLike): Promise<FactionReply | null> {
  const ceremonyId = parseClaimCustomId(i.customId);
  if (ceremonyId === null) return null;
  return handleClaimConfirm(deps, i.userId, ceremonyId, i.values);
}

/** The subset of a select-menu interaction this handler needs. Structural so tests need no client. */
export type SelectInteractionLike = ComponentLike & {
  deferReply: (opts: { flags: number }) => Promise<unknown>;
  editReply: (opts: { content: string }) => Promise<unknown>;
};

/**
 * Answer a roster-confirm select. Returns false if the interaction is not ours.
 *
 * ⚠️ Deferred for the same reason `/faction claim` is, and with more at stake.
 * The confirm runs two queries plus a multi-statement transaction against
 * Discord's 3-second initial-response window, and a timeout here lands in the
 * worst possible order: `reserve()` has already committed, the flag, tag and
 * pole are out of the 33-slot pool, and the player is told "The application did
 * not respond" — with nothing to tell them their faction in fact exists.
 *
 * The custom-id check comes FIRST: Discord delivers every component
 * interaction in the guild, and deferring one we will never answer leaves
 * someone else's menu stuck on "thinking".
 */
export async function respondToClaimConfirm(
  deps: FactionDeps,
  i: SelectInteractionLike,
): Promise<boolean> {
  if (parseClaimCustomId(i.customId) === null) return false;
  await i.deferReply({ flags: MessageFlags.Ephemeral });
  const reply = await routeComponent(deps, { customId: i.customId, userId: i.userId, values: i.values });
  if (!reply) return false;
  await i.editReply({ content: reply.content });
  return true;
}

/** Discord's select-option cap, not our rule — see the "refuse" branch of `planClaimReply`. */
export const MAX_PRUNE_OPTIONS = 25;

export type PruneOption = { label: string; value: string; default: true };
export type ClaimRenderPlan =
  | { kind: "text"; content: string }
  | { kind: "select"; content: string; customId: string; options: PruneOption[]; maxValues: number }
  | { kind: "refuse"; content: string };

/**
 * Decides WHAT to render for a `FactionReply`, as plain data — no discord.js
 * types touched here so this is directly testable.
 *
 * ⚠️ A ceremony can have more participants than a single Discord string-select
 * can hold (25). The select's values BECOME the founding roster — silently
 * slicing to 25 would drop the 26th+ participant from the roster with no
 * error, exactly the loss the ceremony-settling window exists to prevent
 * (settling rather than firing on the first qualifying raise is what lets a
 * late founding member still be counted). So an over-cap ceremony is refused
 * loudly instead: no select is ever rendered, so no confirm can happen and no
 * faction is ever created from it.
 */
export function planClaimReply(reply: FactionReply): ClaimRenderPlan {
  if (!reply.prompt) return { kind: "text", content: reply.content };

  const { ceremonyId, participants } = reply.prompt;
  if (participants.length > MAX_PRUNE_OPTIONS) {
    return {
      kind: "refuse",
      content: `This ceremony has ${participants.length} participants, which is more than the ` +
        `${MAX_PRUNE_OPTIONS} the roster-confirmation menu can hold. Ask an admin to found this ` +
        "faction manually.",
    };
  }

  const options: PruneOption[] = participants.map((p) => ({ label: p.gamertag, value: p.dayzId, default: true }));
  return {
    kind: "select",
    content: reply.content,
    customId: claimCustomId(ceremonyId),
    options,
    maxValues: options.length,
  };
}

/**
 * Filters `CLAIMABLE_FLAGS` for the flag autocomplete, case-insensitively,
 * capped at Discord's 25-choice limit. Pure so it is directly testable
 * without a live autocomplete interaction.
 */
export function flagSuggestions(query: string): string[] {
  const q = query.toLowerCase();
  return CLAIMABLE_FLAGS.filter((f) => f.toLowerCase().includes(q)).slice(0, 25);
}

export * from "./notify.js";

/**
 * Tell each newly verified player, exactly once.
 *
 * `markNotified` runs only after `send` resolves. A send that throws — closed
 * DMs, a deleted channel, a rate limit — leaves the row pending so the next
 * pass retries, rather than marking it done and dropping the message.
 */
export async function notifyCompleted(
  deps: CommandDeps,
  send: Sender,
  loggedFailures: NotifyFailureLog = createNotifyFailureLog(),
): Promise<number> {
  let sent = 0;
  for (const c of await deps.store.pendingNotifications()) {
    try {
      await send({
        discordId: c.discordId,
        channelId: c.channelId,
        content: "Verified — your Discord account is now linked to your character.",
      });
      await deps.store.markNotified(c.id, deps.now());
      // A challenge that got through stops being a candidate for suppression:
      // markNotified normally retires it, but a send that succeeds while
      // markNotified fails must be able to report a later failure.
      loggedFailures.delete(c.id);
      sent++;
    } catch (err) {
      if (!loggedFailures.has(c.id)) {
        console.error(`notify failed for challenge ${c.id}`, err);
        loggedFailures.add(c.id);
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
  const factionStore = new PgFactionStore(db);
  const factionDeps: FactionDeps = {
    store: factionStore, now: () => new Date(), reservationTtlMs: cfg.reservationTtlMs,
  };
  const ceremonyStore = new PgCeremonyStore(db);

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

  const renderFactionReply = async (
    interaction: { editReply: (opts: InteractionEditReplyOptions) => Promise<unknown> },
    reply: FactionReply,
  ): Promise<void> => {
    const plan = planClaimReply(reply);
    if (plan.kind !== "select") {
      await interaction.editReply({ content: plan.content });
      return;
    }
    const select = new StringSelectMenuBuilder()
      .setCustomId(plan.customId)
      .setMinValues(1)
      .setMaxValues(plan.maxValues)
      .addOptions(plan.options);
    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    await interaction.editReply({ content: plan.content, components: [row] });
  };

  client.on("interactionCreate", async (interaction) => {
    if (interaction.isAutocomplete()) {
      if (interaction.commandName === "faction" && interaction.options.getFocused(true).name === "flag") {
        const query = interaction.options.getFocused();
        try {
          await interaction.respond(flagSuggestions(query).map((f) => ({ name: f, value: f })));
        } catch (err) {
          // The autocomplete window is also short-lived; a dropped response
          // just means no suggestions this keystroke, not a broken command.
          console.error("flag autocomplete failed", err);
        }
      }
      return;
    }

    if (interaction.isChatInputCommand()) {
      try {
        if (interaction.commandName === "faction") {
          const sub = interaction.options.getSubcommand();
          if (sub === "claim") {
            // ⚠️ handleFactionClaim makes four or more database round trips;
            // Discord's initial-response window is 3 seconds. Without the
            // defer the first claim can fail with "The application did not
            // respond" AFTER the draft row was already written.
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            const reply = await handleFactionClaim(factionDeps, interaction.user.id, {
              name: interaction.options.getString("name", true),
              tag: interaction.options.getString("tag", true),
              texture: interaction.options.getString("flag", true),
            });
            await renderFactionReply(interaction, reply);
          }
          return;
        }

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
      return;
    }

    if (interaction.isStringSelectMenu()) {
      try {
        await respondToClaimConfirm(factionDeps, {
          customId: interaction.customId,
          userId: interaction.user.id,
          values: interaction.values,
          deferReply: (opts) => interaction.deferReply(opts),
          editReply: (opts) => interaction.editReply(opts),
        });
      } catch (err) {
        console.error(`component ${interaction.customId} failed`, err);
      }
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

  // One log per bot instance, for the life of that instance.
  const notifyFailures = createNotifyFailureLog();
  const ceremonyFailures = createNotifyFailureLog();

  let timer: NodeJS.Timeout | undefined;

  const runner = guardedRunner(async () => {
    try {
      const r = await verificationTick(db, store);
      if (r.verified > 0 || r.alreadyLinked > 0) {
        console.log(`verified ${r.verified}, refused ${r.alreadyLinked} (already linked)`);
      }
      await notifyCompleted(deps, send, notifyFailures);
    } catch (err) {
      // A thrown tick must not kill the interval and silently stop all verification.
      console.error("tick failed", err);
    }

    // Each of the two ceremony steps gets its own try/catch: a failing
    // detector must not stop ceremony DMs, and vice versa.
    try {
      const c = await ceremonyTick(db, ceremonyStore, { now: new Date() });
      if (c.detected > 0 || c.activated > 0 || c.lapsed > 0) {
        console.log(`ceremonies detected ${c.detected}, activated ${c.activated}, lapsed ${c.lapsed}`);
      }
    } catch (err) {
      console.error("ceremony tick failed", err);
    }
    try {
      await notifyCeremonies(db, send, () => new Date(), ceremonyFailures);
    } catch (err) {
      console.error("ceremony notify failed", err);
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
