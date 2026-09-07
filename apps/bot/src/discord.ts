import {
  Client, GatewayIntentBits, REST, Routes, MessageFlags, PermissionFlagsBits,
  SlashCommandBuilder,
  type RESTPostAPIApplicationCommandsJSONBody,
} from "discord.js";
import { createClient, servers } from "@factions/db";
import { eq } from "drizzle-orm";
import { emoteLabel } from "@factions/domain";
import type { CommandDeps } from "./commands.js";
import { PgVerificationStore } from "@factions/verification";
import { verificationTick } from "./tick.js";
import { runPlayerProjection } from "./player-tick.js";
import { runPoleProjection } from "./pole-tick.js";
import type { BotConfig } from "./config.js";
import { createNotifyFailureLog, type NotifyFailureLog, type Sender } from "./notify.js";
import { applyNickname, type NicknameOutcome, type GuildLike } from "./nickname.js";
import { PgCeremonyStore } from "./ceremony-store.js";
import { ceremonyTick } from "./ceremony-tick.js";
import { notifyCeremonies } from "./ceremony-notify.js";
import { dormancyTick } from "./dormancy-tick.js";
import { presenceTick, expirePendingMembers } from "./presence-tick.js";
import { positionsTick } from "./positions-tick.js";
import { zoneTick } from "./zone-tick.js";
import { reaperTick } from "./reaper-tick.js";
import { lapseSolos } from "@factions/declarations";
import { PgDormancyStore } from "./dormancy-store.js";
import { notifyDormancy } from "./dormancy-notify.js";
import { RETIRED_COMMANDS, RETIRED_DESCRIPTION, retiredReply } from "./retired-commands.js";
import { PgFeedStore, PgNoticeStore, PgWarLogStore, countUnposted, countUnpostedWarLog, noticeUserTx } from "@factions/roster/internal";
import { feedTick, type FeedPoster } from "./feed-tick.js";
import { flagImageResolver } from "./flag-image.js";
import { raidTick } from "./raid-tick.js";
import { raiseTick } from "./raise-tick.js";
import { weekTick } from "./week-tick.js";
import { noticeTick, type NoticeSender } from "./notice-tick.js";
import { warLogTick, type WarLogPoster } from "./war-log-tick.js";
import { createGuildGateway } from "./guild.js";
import { PgStructureStore } from "./structure-store.js";
import { structureTick } from "./structure-tick.js";
import { membershipTick } from "./membership-tick.js";
import { sessionsTick } from "./sessions-tick.js";
import { killsTick } from "./kills-tick.js";
import { leadershipTick } from "./leadership-tick.js";
import { handleGuildMemberRemove } from "./guild-removal.js";
import { handleGuestCommand } from "./guest-command.js";

export function buildCommands(): RESTPostAPIApplicationCommandsJSONBody[] {
  return [
    ...RETIRED_COMMANDS.map((name) =>
      new SlashCommandBuilder().setName(name).setDescription(RETIRED_DESCRIPTION).toJSON()),
    new SlashCommandBuilder()
      .setName("guest")
      .setDescription("Give someone a 24h voice guest pass")
      .addUserOption((o) => o.setName("user").setDescription("Who").setRequired(true))
      .toJSON(),
  ];
}

export * from "./notify.js";

/** Injected into `notifyCompleted` so tests need no discord.js client. */
export type NicknameApplier = (
  guildId: string, discordId: string, nickname: string | null,
) => Promise<NicknameOutcome>;

/**
 * `NicknameOutcome` plus one case that belongs only to the caller: no rename
 * was even attempted, either because no `NicknameApplier` was wired (a unit
 * test of the notifier itself, or a bot instance with no Discord client) or
 * because there was no link to read a gamertag from. Distinct from "failed"
 * — that means an attempt was made and Discord refused or errored — so the
 * DM doesn't tell a player something failed when nothing was tried.
 */
export type RenameOutcome = NicknameOutcome | "not-attempted";

/**
 * Player-facing sentence for how the rename went. The link itself is never in
 * question here — this only ever runs after `completeChallenge` has already
 * committed the binding — so every branch leads with that being settled.
 */
function nicknameOutcomeSuffix(outcome: RenameOutcome): string {
  switch (outcome) {
    case "not-attempted":
      return "";
    case "ok":
      return " Your nickname has been set to match.";
    case "is-owner":
      return " Your nickname could not be changed: Discord will not let a bot rename the server owner.";
    case "outranked":
      return " Your nickname could not be changed: the bot's role is below yours, so an admin needs to move it above.";
    case "no-permission":
      return " Your nickname could not be changed: the bot does not have the Manage Nicknames permission.";
    case "failed":
      return " Your nickname could not be changed right now.";
  }
}

/**
 * Tell each player their challenge's outcome, exactly once.
 *
 * Two outcomes reach here: a completion, and a challenge canceled because its
 * target spent the whole emote budget without finishing the sequence (spec
 * §5.3). Both ride the same `notified_at` discipline, so neither is ever sent
 * twice, and neither an ordinary expiry nor a `/link` switch-cancel reaches
 * here at all — they carry no cancel reason. See `pendingNotifications`.
 *
 * `markNotified` runs only after `send` resolves. A send that throws — closed
 * DMs, a deleted channel, a rate limit — leaves the row pending so the next
 * pass retries, rather than marking it done and dropping the message.
 *
 * ⚠️ The rename is attempted here, strictly AFTER the identity link (this
 * only ever runs for challenges `completeChallenge` has already committed).
 * It is wrapped in its OWN try/catch, separate from the `send`/`markNotified`
 * one below: `renameOnLink` calls into a real discord.js permission
 * predicate and guild fetch, which — unlike `applyNickname` itself — are not
 * guaranteed not to throw (a partially-cached `Guild`, for instance). If that
 * escaped into the outer catch, it would land exactly where a failed `send`
 * lands: no DM delivered, the row left pending, retried forever — silently
 * losing the notification over something that was only ever supposed to be
 * best-effort.
 *
 * `defaultGuildId` is used for the rename when the challenge carries no
 * guild — a site-issued one. Without either, no rename is attempted.
 */
export async function notifyCompleted(
  deps: CommandDeps,
  send: Sender,
  loggedFailures: NotifyFailureLog = createNotifyFailureLog(),
  renameOnLink?: NicknameApplier,
  defaultGuildId?: string,
): Promise<number> {
  let sent = 0;
  for (const c of await deps.store.pendingNotifications()) {
    try {
      if (c.outcome !== "completed") {
        // Nothing was bound, so there is no rename to attempt and no link to
        // read — only the character they were trying to verify, named so a
        // player with several does not have to guess which attempt died.
        await send({
          discordId: c.discordId,
          channelId: c.channelId,
          content: c.outcome === "already-linked" ? await alreadyLinkedMessage(deps, c) : await lockedOutMessage(deps, c),
        });
        await deps.store.markNotified(c.id, deps.now());
        loggedFailures.delete(c.id);
        sent++;
        continue;
      }
      let outcome: RenameOutcome = "not-attempted";
      const guildId = c.guildId ?? defaultGuildId;
      if (renameOnLink && guildId) {
        try {
          // The link is already committed by the time a challenge appears
          // here, so this lookup exists only to get the gamertag to rename
          // to — it is not a gate on anything.
          const link = await deps.store.findLinkByDiscord(c.discordId);
          if (link) outcome = await renameOnLink(guildId, c.discordId, link.gamertag);
        } catch (err) {
          console.warn(`nickname lookup/rename failed for ${c.discordId}`, err);
          outcome = "failed";
        }
      }
      await send({
        discordId: c.discordId,
        channelId: c.channelId,
        content: "Verified — your Discord account is now linked to your character." + nicknameOutcomeSuffix(outcome),
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
 * What a player is told when their challenge ran out of emote budget.
 *
 * Names the emote they never reached, which is the difference between an
 * apology and a diagnosis — see the comment on `stuckOn` below, and the
 * `ORDINALS` note on why no count appears.
 */
async function lockedOutMessage(
  deps: CommandDeps,
  c: { targetDayzId: string; sequence: string[]; progressIndex: number },
): Promise<string> {
  // Cosmetic only — a missing player row must not cost the player their
  // message, so fall back to the UID rather than letting this decide anything.
  const name = (await deps.store.playerByDayzId(c.targetDayzId))?.gamertag ?? c.targetDayzId;
  const opening =
    `Your link challenge for **${name}** was canceled: too many emotes were performed ` +
    "before the sequence was completed, so it can no longer be finished.";
  const retry = "Run `/link` again for a fresh sequence, and perform just those emotes, in order.";

  // The emote they stopped at. A player at index 0 never managed the FIRST
  // one, which is a different problem from fumbling the order — it usually
  // means they could not find it on the wheel at all, the way EmoteSOS could
  // not be found before it was demoted. Naming it is what makes this message
  // actionable, and a run of lockouts stuck on one token is how the next
  // unperformable emote in the safe pool becomes visible.
  const stuckOn = c.sequence[c.progressIndex];
  if (stuckOn === undefined) return `${opening} ${retry}`;
  const label = emoteLabel(stuckOn) ?? stuckOn;

  return (
    `${opening} You never performed **${label}** — the ${ordinal(c.progressIndex)} of the ` +
    `${c.sequence.length}. If you cannot find that one on the emote wheel, that is worth ` +
    `saying in the channel: it may be an emote no one can perform.\n\n${retry}`
  );
}

/** Inbox 7: the sequence was right, but the character already belongs to another account. */
async function alreadyLinkedMessage(deps: CommandDeps, c: { targetDayzId: string }): Promise<string> {
  const name = (await deps.store.playerByDayzId(c.targetDayzId))?.gamertag ?? c.targetDayzId;
  return (
    `Your link challenge for **${name}** was canceled: that character is already linked to another ` +
    "Discord account, so this one cannot claim it. If that character is yours — you changed Discord " +
    "accounts, say — ask an admin to move the link."
  );
}

/**
 * ⚠️ Deliberately no count of emotes performed anywhere in the lockout
 * message. The budget is the primary defence against the named target backing
 * into its own sequence by accident (see MAX_POOL_EMOTES_PER_ATTEMPT), and a
 * player who reads a number as a target to optimise against has misunderstood
 * what to do. The missing EMOTE is the actionable fact; the count is not.
 */
const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth"];
const ordinal = (i: number): string => ORDINALS[i] ?? `${i + 1}th`;

/** The subset of a discord.js `Client` a `NicknameApplier` needs. Structural so tests need no real client. */
export type NicknameClientLike = { guilds: { fetch(guildId: string): Promise<RealGuildLike> } };
/** discord.js's `Guild` has all of this; kept minimal here so the adapter stays honest about what it uses. */
export type RealGuildLike = {
  ownerId: string;
  members: {
    fetch(userId: string): Promise<{ manageable: boolean; setNickname(nick: string | null): Promise<unknown> }>;
    me: { permissions: { has(perm: bigint): boolean } } | null;
  };
};

/**
 * Adapts a real discord.js `Client` to the `NicknameApplier` shape
 * `notifyCompleted` and `handleUnlink`'s `clearNickname` both take. This is
 * the ONLY place real discord.js types meet `nickname.ts`'s structural
 * `GuildLike` — everything else stays client-free for testing.
 */
export function createNicknameApplier(client: NicknameClientLike): NicknameApplier {
  return async (guildId, discordId, nickname) => {
    let guild: RealGuildLike;
    try {
      guild = await client.guilds.fetch(guildId);
    } catch (err) {
      console.warn(`nickname change failed — could not fetch guild ${guildId}`, err);
      return "failed";
    }
    const guildLike: GuildLike = {
      ownerId: guild.ownerId,
      members: { fetch: (userId) => guild.members.fetch(userId) },
      members_me_permissions_has: () =>
        guild.members.me?.permissions.has(PermissionFlagsBits.ManageNicknames) ?? false,
    };
    return applyNickname(guildLike, discordId, nickname);
  };
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

/**
 * ⚠️ Throws on every unreachable path rather than returning quietly. The feed
 * tick marks a row posted only when this resolves, so a swallowed failure
 * would mark it posted and lose the announcement permanently.
 */
export function createFeedPoster(client: Client, channelId: string): FeedPoster {
  return async (embed) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable()) {
      throw new Error(`feed channel ${channelId} is missing or not sendable by this bot`);
    }
    await channel.send({ embeds: [embed] });
  };
}

/**
 * ⚠️ Same shape and reasoning as `createFeedPoster`: throws on every
 * unreachable path rather than returning quietly, because `warLogTick`
 * marks a row posted only when this resolves — a swallowed failure would
 * mark it posted and lose the announcement permanently.
 */
export function createChannelPoster(client: Client, channelId: string): WarLogPoster {
  return async (content) => {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isSendable()) {
      throw new Error(`channel ${channelId} is missing or not sendable by this bot`);
    }
    await channel.send({ content });
  };
}

/**
 * `channel` → `client.channels.fetch`; `dm` → `client.users.fetch(id).send`.
 * Neither falls back to the other — a clan_notices row already carries the
 * discord target its writer decided on, and a DM row with closed DMs is
 * exactly what the three-attempt/failed discipline in `noticeTick` and
 * `PgNoticeStore.markAttempt` exists for.
 */
export function createNoticeSender(client: Client): NoticeSender {
  return async (target, discordTargetId, content) => {
    if (target === "dm") {
      const user = await client.users.fetch(discordTargetId);
      await user.send(content);
      return;
    }
    const channel = await client.channels.fetch(discordTargetId);
    if (!channel?.isSendable()) {
      throw new Error(`notice channel ${discordTargetId} is missing or not sendable by this bot`);
    }
    await channel.send({ content });
  };
}

export async function start(cfg: BotConfig): Promise<void> {
  const db = createClient(cfg.databaseUrl);
  const store = new PgVerificationStore(db);
  const ceremonyStore = new PgCeremonyStore(db);
  const dormancyStore = new PgDormancyStore(db);
  const feedStore = new PgFeedStore(db);
  const noticeStore = new PgNoticeStore(db);
  const warLogStore = new PgWarLogStore(db);

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

  // GuildMembers is privileged: the runbook enables it on the developer
  // portal. Without it `guild.members.fetch()` hangs forever and every role
  // diff in structureTick sees an empty member cache.
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

  const feedPoster = cfg.feedChannelId ? createFeedPoster(client, cfg.feedChannelId) : null;
  const warLogPoster = cfg.warLogChannelId ? createChannelPoster(client, cfg.warLogChannelId) : null;
  const noticeSender = createNoticeSender(client);

  const renameOnLink = createNicknameApplier(client);
  const deps: CommandDeps = { store, now: () => new Date() };

  const guildGateway = createGuildGateway(client, {
    guildId: cfg.guildId,
    clanTextCategoryId: cfg.clanTextCategoryId,
    clanVoiceCategoryId: cfg.clanVoiceCategoryId,
  });
  const structureStore = new PgStructureStore(db);
  // Users the reconciler must not retry a nickname clear for this instance's
  // lifetime (owner, outranked, no permission) — shared between the
  // start-up pass and every tick pass so neither repeats the other's log.
  const nicknameNoRetry = new Set<string>();
  // ⚠️ False until one `fetchAllMembers()` resolves. `guild.members.fetch()`
  // rejects with GuildMembersTimeout after 120s on a large or slow guild, and
  // without a retry the member cache stays whatever gateway events happen to
  // deliver — so `isMember` is false for anyone who never speaks and they
  // never get their clan role for the process lifetime. (A cold cache only
  // ever under-acts: `desired` is filtered by `isMember` and every id in
  // `actual` comes from the member cache too, so no role is wrongly stripped.)
  let membersFetched = false;
  const tryFetchMembers = async (): Promise<void> => {
    try {
      const memberCount = await guildGateway.fetchAllMembers();
      membersFetched = true;
      console.log(`guild members fetched: ${memberCount}`);
    } catch (err) {
      console.error("guild members fetch failed (retrying next tick)", err);
    }
  };
  const runStructure = async (label: string): Promise<void> => {
    if (!membersFetched) await tryFetchMembers();
    const s = await structureTick(structureStore, guildGateway, {
      linkedRoleId: cfg.linkedRoleId,
      alphaRoleId: cfg.alphaRoleId,
      nicknameNoRetry,
      onError: (what, err) => console.error(`structure: ${what}`, err),
    });
    const parts: string[] = [];
    if (s.created) parts.push(`created ${s.created}`);
    if (s.tornDown) parts.push(`tornDown ${s.tornDown}`);
    if (s.renamed) parts.push(`renamed ${s.renamed}`);
    if (s.roleAdds) parts.push(`roleAdds ${s.roleAdds}`);
    if (s.roleRemoves) parts.push(`roleRemoves ${s.roleRemoves}`);
    if (s.linkedAdds) parts.push(`linkedAdds ${s.linkedAdds}`);
    if (s.linkedRemoves) parts.push(`linkedRemoves ${s.linkedRemoves}`);
    if (s.alphaAdds) parts.push(`alphaAdds ${s.alphaAdds}`);
    if (s.alphaRemoves) parts.push(`alphaRemoves ${s.alphaRemoves}`);
    if (s.nicknamesCleared) parts.push(`nicknamesCleared ${s.nicknamesCleared}`);
    if (s.noticesFailed) parts.push(`noticesFailed ${s.noticesFailed}`);
    // ⚠️ Included, or a pass that did nothing but fail prints nothing at all —
    // and this line is what an operator greps.
    if (s.errors) parts.push(`errors ${s.errors}`);
    if (parts.length > 0) console.log(`structure ${label}: ${parts.join(", ")}`);
  };

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isAutocomplete()) { await interaction.respond([]); return; }
      if (interaction.isChatInputCommand() && interaction.commandName === "guest") {
        const reply = await handleGuestCommand(db, {
          channelId: interaction.channelId,
          actorDiscordId: interaction.user.id,
          targetUserId: interaction.options.getUser("user", true).id,
          now: new Date(),
        });
        await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral });
        return;
      }
      if (interaction.isChatInputCommand()) {
        const sub = interaction.options.getSubcommand(false);
        const reply = retiredReply(cfg.siteBaseUrl, interaction.commandName, sub);
        await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral });
        return;
      }
      // Buttons and selects on old DMs (invite accept, claim confirm, rebind confirm): the same pointer.
      if (interaction.isMessageComponent()) {
        const reply = retiredReply(cfg.siteBaseUrl, "faction", interaction.customId.startsWith("invite-") ? "invites" : null);
        await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral });
      }
    } catch (err) {
      // ⚠️ discord.js does not await this listener; an uncaught throw is an unhandled rejection that takes the bot down. Log and drop the one interaction.
      console.error(`interaction failed`, err);
    }
  });

  // Spec §5.4: "being removed from the Discord removes you from everything."
  // Gateway event only (ruling 10: no reconciliation of removals that
  // happened while the bot was down) — the guild id is checked first, and a
  // mismatched guild writes nothing (see handleGuildMemberRemove).
  client.on("guildMemberRemove", (m) => {
    void handleGuildMemberRemove(db, { guildId: m.guild.id, expectedGuildId: cfg.guildId, userId: m.id, now: new Date() })
      .then((r) => {
        if (r !== "other-guild" && r.linked) {
          console.log(`guild removal: ${m.id} ${r.roster}${r.successorDiscordId ? ` → ${r.successorDiscordId}` : ""}`);
        }
      })
      .catch((err) => console.error("guild removal failed", err));
  });

  const send: Sender = async (n) => {
    // DM first; fall back to the channel /link was run in, because a player
    // with closed DMs would otherwise never learn they succeeded.
    try {
      const user = await client.users.fetch(n.discordId);
      await user.send(n.content);
    } catch {
      if (n.channelId === null) throw new Error(`no reachable surface for ${n.discordId} (DMs closed, site-issued challenge)`);
      const channel = await client.channels.fetch(n.channelId);
      if (channel?.isSendable()) await channel.send(`<@${n.discordId}> ${n.content}`);
      else throw new Error(`no reachable surface for ${n.discordId}`);
    }
  };

  // One log per bot instance, for the life of that instance.
  const notifyFailures = createNotifyFailureLog();
  const ceremonyFailures = createNotifyFailureLog();
  // One log per bot instance, for the life of that instance.
  const feedFailures = new Set<number>();
  // ⚠️ Same purpose as feedFailures, for the "queue blocked" line below: a
  // permanently blocked queue (deleted channel, revoked Embed Links) would
  // otherwise write an identical multi-line error every tick interval
  // forever. Tracks only the id currently reported blocked, not every id
  // ever seen, so a later different blocking row is still reported once.
  let lastReportedBlockedAt: number | null = null;
  // One log per bot instance, mirroring feedFailures/lastReportedBlockedAt above.
  const warLogFailures = new Set<number>();
  let lastReportedWarLogBlockedAt: number | null = null;

  // The reaper's map half runs every REAPER_INTERVAL_MS rather than every
  // tick — see the throttle beside expirePendingMembers below.
  const REAPER_INTERVAL_MS = 5 * 60_000;
  let lastReaperAt = 0;

  let timer: NodeJS.Timeout | undefined;

  const runner = guardedRunner(async () => {
    // ⚠️ FIRST, and in its own try/catch. `/link`'s autocomplete can only
    // offer characters this projection has recorded, so a player who has
    // just been seen in game is unlinkable until it runs. A failure here
    // must not stop verification — a stale menu is survivable, a halted
    // tick is not.
    // ⚠️ Its own try/catch, separate from the player projection below. The
    // two share nothing but this tick, and one projection's failure must not
    // silence the other: sharing a `try` meant a persistently failing pole
    // projection — a bad payload, a missing server row — threw before
    // `runPlayerProjection` was ever reached, so every player stayed
    // unlinkable and the only log line named the pole failure.
    try {
      const poleRun = await runPoleProjection(db);
      if (poleRun.upserted > 0) console.log(`pole projection: ${poleRun.upserted} poles`);
    } catch (err) {
      console.error("pole projection failed", err);
    }

    try {
      const p = await runPlayerProjection(db);
      if (p.upserted > 0) console.log(`players projected ${p.upserted} of ${p.scanned} events`);
    } catch (err) {
      console.error("player projection failed", err);
    }

    // ⚠️ Its own try/catch, separate from every other step: it must see the
    // roster as it stands before this tick's promotions land, so a promotion
    // recorded by presence this tick opens its span next tick; and it must run
    // before the kills consumer so membership is reconciled before kills read it.
    try {
      const m = await membershipTick(db, new Date());
      if (m.opened > 0 || m.closed > 0) console.log(`membership: ${m.opened} opened, ${m.closed} closed`);
    } catch (err) {
      console.error("membership tick failed", err);
    }

    // ⚠️ Its own try/catch, separate from every other step: a pending
    // member's promotion must not wait on verification, ceremony or
    // dormancy, and a throw here must not stop any of them.
    try {
      const pr = await presenceTick(db);
      if (pr.promoted.length > 0) console.log(`presence: ${pr.promoted.length} member(s) now full`);
    } catch (err) {
      console.error("presence tick failed", err);
    }

    // ⚠️ Its own try/catch, separate from every other step: spec §7's
    // leadership clock (succession claims and no-confidence votes past their
    // deadline) runs every tick (ruling 13) and a failure here must not stop
    // anything else.
    try {
      const lt = await leadershipTick(db, new Date());
      if (lt.succeeded > 0 || lt.voided > 0 || lt.passed > 0 || lt.failed > 0) {
        console.log(`leadership: ${lt.succeeded} succeeded, ${lt.voided} voided, ${lt.passed} passed, ${lt.failed} failed`);
      }
    } catch (err) {
      console.error("leadership tick failed", err);
    }

    // ⚠️ Its own try/catch, after presence (both read pos events; presence
    // must promote before the zone consumer decides who is a member) and
    // before structure. positions before zones: the map's "last fix" and the
    // intruder pin come from the same event, and the page should never show
    // an intruder whose own dot has not landed yet.
    try {
      const p = await positionsTick(db, { now: new Date() });
      if (p.written > 0) console.log(`positions: ${p.written} fix(es)`);
    } catch (err) {
      console.error("positions tick failed", err);
    }
    try {
      const z = await zoneTick(db, { now: new Date() });
      if (z.alerts > 0) console.log(`zone watch: ${z.sightings} sighting(s), ${z.alerts} alert(s)`);
    } catch (err) {
      console.error("zone tick failed", err);
    }

    // ⚠️ Its own try/catch: runs after zone (which needs membership
    // reconciled before it matches intruders against clans) and before
    // structure. sessionsTick reads connect/disconnect events and opens/closes
    // `player_sessions` rows; killsTick reads kill events and opens `kills`
    // rows with resolved faction membership via `membershipAt`.
    try {
      const s = await sessionsTick(db);
      // ⚠️ `restarted` too: a server restart that strands 40 open sessions closes
      // them all here and is otherwise invisible in production.
      if (s.opened > 0 || s.closed > 0 || s.restarted > 0) {
        console.log(`sessions: ${s.opened} opened, ${s.closed} closed, ${s.restarted} restarted`);
      }
    } catch (err) {
      console.error("sessions tick failed", err);
    }

    try {
      const k = await killsTick(db);
      if (k.written > 0) console.log(`kills: ${k.written} written`);
    } catch (err) {
      console.error("kills tick failed", err);
    }

    // ⚠️ Its own try/catch, after presence (and the map's positions/zone
    // ticks) and before the notice tick: a promotion this tick should hold
    // its clan role before a `became_full` line posts, and a channel created
    // this tick should already exist to receive the notices queued for it.
    // structureTick never throws, but the runner's discipline is one
    // try/catch per step regardless.
    try {
      await runStructure("tick");
    } catch (err) {
      console.error("structure tick failed", err);
    }

    // ⚠️ Its own try/catch, like every other step: a failure raiding or
    // raising a flag must not stop verification, ceremony or dormancy.
    try {
      const raided = await raidTick(db, {
        onNoSeason: (serverId) => console.error(`raid tick: no open season for server ${serverId}`),
      });
      if (raided.raids > 0 || raided.absorbed > 0) {
        console.log(`raids: ${raided.raids} new, ${raided.absorbed} absorbed, ${raided.skippedNoSeason} skipped (no season)`);
      }
    } catch (err) {
      console.error("raid tick failed", err);
    }

    // ⚠️ Its own try/catch, separate from raidTick above: the two consumers
    // share nothing but the events they scan, and one's failure must not
    // silence the other.
    try {
      const raised = await raiseTick(db, { siteBaseUrl: cfg.siteBaseUrl });
      if (raised.defenses > 0 || raised.revived > 0 || raised.noticed > 0) {
        console.log(`raises: ${raised.defenses} defended, ${raised.revived} revived, ${raised.noticed} noticed`);
      }
    } catch (err) {
      console.error("raise tick failed", err);
    }

    // ⚠️ Its own try/catch, after the raise tick and before the posters: the
    // week tick reads `raids` (raidTick's output) so it belongs after it,
    // and its `#war-log` row must exist before warLogTick below can post it.
    try {
      const wk = await weekTick(db, {
        now: new Date(),
        onError: (seasonId, weekStart, err) =>
          console.error(`week close failed for season ${seasonId} week ${weekStart.toISOString()}`, err),
      });
      if (wk.closed > 0) console.log(`weeks closed ${wk.closed}`);
    } catch (err) {
      console.error("week tick failed", err);
    }

    try {
      const r = await verificationTick(db, store);
      if (r.verified > 0 || r.alreadyLinked > 0) {
        console.log(`verified ${r.verified}, refused ${r.alreadyLinked} (already linked)`);
      }
      await notifyCompleted(deps, send, notifyFailures, renameOnLink, cfg.guildId);
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
      await notifyCeremonies(db, send, () => new Date(), cfg.siteBaseUrl, ceremonyFailures);
    } catch (err) {
      console.error("ceremony notify failed", err);
    }

    // ⚠️ Its own try/catch, like every other step in this job: a throw here
    // must not stop verification or ceremony DMs. Runs last because nothing
    // else depends on it — supplies are read from status by a different
    // process on its own schedule.
    try {
      const d = await dormancyTick(dormancyStore, {
        now: new Date(),
        windows: {
          dormantAfterMs: cfg.dormantAfterMs,
          disbandAfterDormantMs: cfg.disbandAfterDormantMs,
        },
        onError: (factionId, err) => console.error(`dormancy failed for faction ${factionId}`, err),
        // Solo declarations lapse on the same clock the factions do, so they
        // are swept by the same job — one sweep per active server.
        lapseSolos: async (now) => {
          const all: { dayzId: string; poleKey: string; discordId: string | null }[] = [];
          for (const s of await db.select({ id: servers.id }).from(servers).where(eq(servers.active, true))) {
            // ⚠️ Per server, like the tick's per-faction catch: one server's
            // deadlock must not cost every later server its sweep, which
            // would hold solo declarations open for another whole tick.
            try {
              // ⚠️ The DM is queued INSIDE `lapseSolos`'s own per-row
              // transaction (Global Constraint / §4.7: every Discord post goes
              // through a table written in the same transaction as the
              // transition it describes). `@factions/declarations` cannot
              // import `@factions/roster/internal` without a cycle, so it
              // takes the write as a callback and this is where it is
              // supplied. A throw here rolls that one release back — the safe
              // direction, since the next tick simply sweeps it again.
              const lapsed = await lapseSolos(db, s.id, now, async (tx, l) => {
                if (!l.discordId) return;
                await noticeUserTx(tx, {
                  serverId: s.id, factionId: null, discordId: l.discordId, kind: "solo_lapsed", occurredAt: now,
                  payload: { link: `${cfg.siteBaseUrl}/base` },
                });
              });
              all.push(...lapsed);
            } catch (err) {
              console.error(`solo lapse failed for server ${s.id}`, err);
            }
          }
          for (const l of all) console.log(`solo declaration lapsed: ${l.dayzId} at ${l.poleKey}`);
          return all;
        },
      });
      if (d.dormant > 0 || d.revived > 0 || d.disbanded > 0 || d.stamped > 0) {
        console.log(
          `dormancy: ${d.dormant} dormant, ${d.revived} revived, ` +
          `${d.disbanded} disbanded, ${d.stamped} stamped, of ${d.examined} examined`,
        );
      }
      // ⚠️ Its own line, at error level, and deliberately not folded into the
      // counts above. A paused clock means a server with dormant factions on
      // it produced no events this tick — an ingest problem wearing dormancy's
      // clothes. Folding it in with the routine transitions is how it stayed
      // invisible: an operator cannot distinguish "nothing was due" from
      // "disbands are being withheld because the worker is down" unless
      // something says so out loud.
      if (d.paused > 0) {
        console.error(
          `dormancy: disband countdown paused for ${d.paused} faction(s) — their server has ` +
          `produced no events in ${cfg.dormantAfterMs}ms, so ingest is presumably down. ` +
          "Supplies stay cut while dormant, but nothing will be disbanded until events resume.",
        );
      }
      await notifyDormancy(d.notices, send, (n, err) =>
        console.error(`dormancy DM failed for faction ${n.factionId}`, err));
    } catch (err) {
      console.error("dormancy tick failed", err);
    }

    // ⚠️ Its own try/catch, beside dormancy's: a pending member who never
    // showed up at the base is the reaper's other half, and a throw here
    // must not cost the faction sweep above its transitions.
    try {
      const expired = await expirePendingMembers(db, new Date());
      if (expired.length > 0) console.log(`pending expiry: ${expired.length} member(s) dropped`);
    } catch (err) {
      console.error("pending expiry failed", err);
    }

    // The reaper's map half (spec §7: 5 min). Throttled here rather than on
    // its own timer so there is still exactly one interval in this process.
    if (Date.now() - lastReaperAt >= REAPER_INTERVAL_MS) {
      try {
        const r = await reaperTick(db, new Date());
        lastReaperAt = Date.now();
        if (r.pins + r.positions + r.sightings > 0) console.log(`reaper: ${r.pins} pin(s), ${r.positions} position(s), ${r.sightings} sighting(s)`);
      } catch (err) {
        console.error("reaper tick failed", err);
      }
    }

    // ⚠️ Its own try/catch, like every other step. Runs after dormancy so a
    // transition and its announcement land in the same tick rather than the
    // next one.
    if (feedPoster) {
      try {
        const f = await feedTick(feedStore, feedPoster, {
          now: new Date(),
          flagImage: flagImageResolver(cfg.flagImageBaseUrl),
          onError: (id, err) => {
            // ⚠️ Once per row per bot instance. A deleted channel or a
            // revoked permission is permanent, and an identical error every
            // 10 seconds forever is how a real problem becomes invisible.
            if (feedFailures.has(id)) return;
            feedFailures.add(id);
            console.error(`feed post failed for faction_events row ${id}`, err);
          },
        });
        if (f.posted > 0) console.log(`feed posted ${f.posted}`);
        if (f.blockedAt !== null && f.blockedAt !== lastReportedBlockedAt) {
          // ⚠️ Error level, and its own line. A blocked queue means NOTHING
          // after this row will post, ever, until it is resolved — a much
          // louder condition than one failed message. Gated on
          // lastReportedBlockedAt for the same reason feedFailures gates the
          // per-row log above: a revoked permission or deleted channel is
          // permanent, and without the guard this line repeats unchanged
          // every tick interval forever, which is exactly the invisible-by-
          // repetition failure the once-per-row log exists to prevent.
          console.error(
            `feed queue blocked at faction_events row ${f.blockedAt}; nothing behind it will post ` +
            `until this row succeeds. Check the bot's View Channel / Send Messages / Embed Links ` +
            `permission on ${cfg.feedChannelId}.`,
          );
          lastReportedBlockedAt = f.blockedAt;
        }
      } catch (err) {
        console.error("feed tick failed", err);
      }
    }

    // ⚠️ Its own try/catch, beside the feed's, and gated the same way: only
    // when a channel is configured. Off by default for the same reason the
    // feed is — every existing deployment and test fixture would otherwise
    // need a war-log channel id for a feature it does not use.
    if (warLogPoster) {
      try {
        const w = await warLogTick(warLogStore, warLogPoster, {
          now: new Date(),
          siteBaseUrl: cfg.siteBaseUrl,
          onError: (id, err) => {
            if (warLogFailures.has(id)) return;
            warLogFailures.add(id);
            console.error(`war log post failed for war_log_events row ${id}`, err);
          },
        });
        if (w.posted > 0) console.log(`war log posted ${w.posted}`);
        if (w.blockedAt !== null && w.blockedAt !== lastReportedWarLogBlockedAt) {
          console.error(
            `war log queue blocked at war_log_events row ${w.blockedAt}; nothing behind it will post ` +
            `until this row succeeds. Check the bot's View Channel / Send Messages permission on ${cfg.warLogChannelId}.`,
          );
          lastReportedWarLogBlockedAt = w.blockedAt;
        }
      } catch (err) {
        console.error("war log tick failed", err);
      }
    }

    // ⚠️ Its own try/catch, always run — unlike the feed and war log, a
    // clan_notices row can be a DM, which needs no channel at all, so this
    // step is never gated on a config flag.
    try {
      const n = await noticeTick(noticeStore, noticeSender, {
        now: new Date(),
        onError: (id, attempts, err) => {
          // Logged once per attempt, capped at NOTICE_MAX_ATTEMPTS: a row
          // failing for the third time is worth a distinct line from the
          // first two, since it stops being retried after this.
          console.error(`notice post failed for clan_notices row ${id} (attempt ${attempts})`, err);
        },
      });
      if (n.posted > 0 || n.failed > 0) {
        console.log(`notices posted ${n.posted}, ${n.failed} permanently failed`);
      }
    } catch (err) {
      console.error("notice tick failed", err);
    }
  });

  client.once("clientReady", async () => {
    console.log(`bot ready as ${client.user?.tag}`);

    // ⚠️ A feature that is off because of a missing env var looks exactly
    // like one that is broken. Without this, "why is the feed not posting"
    // is only answerable from a psql session.
    if (!cfg.feedChannelId) {
      void countUnposted(db)
        .then((n) => console.warn(
          `faction feed is OFF (BOT_FEED_CHANNEL_ID unset); ${n} event(s) queued. ` +
          "They will post in order when a channel is configured.",
        ))
        .catch((err: unknown) => console.error("could not count the feed queue", err));
    }

    if (!cfg.warLogChannelId) {
      void countUnpostedWarLog(db)
        .then((n) => console.warn(
          `war log is OFF (WAR_LOG_CHANNEL_ID unset); ${n} event(s) queued. ` +
          "They will post in order when a channel is configured.",
        ))
        .catch((err: unknown) => console.error("could not count the war log queue", err));
    }

    // §9.1 "reconciled on start": populate the member cache and run one
    // structure pass before the interval starts. `runStructure` fetches the
    // members itself when it has not yet succeeded, so a failed fetch logs and
    // continues rather than blocking the bot forever, and every later pass
    // retries it until one succeeds.
    try {
      await runStructure("on start");
    } catch (err) {
      console.error("structure on-start pass failed", err);
    }

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
