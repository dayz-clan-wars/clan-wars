import { ChannelType, DiscordAPIError, OverwriteType, PermissionFlagsBits, type Client } from "discord.js";
import { applyNickname, type GuildLike } from "./nickname.js";
import type { NicknameOutcome } from "./nickname.js";

export type { NicknameOutcome } from "./nickname.js";

export type ClanNames = { name: string; tag: string };

export function roleNameFor(n: ClanNames): string {
  return n.name.slice(0, 100);
}

export function textChannelNameFor(n: ClanNames): string {
  return `clan-${n.tag.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "")}`.slice(0, 100);
}

export function voiceChannelNameFor(n: ClanNames): string {
  return n.tag.toUpperCase().slice(0, 100);
}

/** Everything the reconciler does to Discord. Reads come from the gateway cache (free); writes are REST calls. */
export interface GuildGateway {
  /** Populate the member cache. Returns the member count. Called once at start. */
  fetchAllMembers(): Promise<number>;
  createRole(name: string): Promise<string>;
  /** Text channel under CLAN_TEXT_CATEGORY_ID, visible only to `roleId`. */
  createTextChannel(name: string, roleId: string): Promise<string>;
  /** Voice channel under CLAN_VOICE_CATEGORY_ID, View + Connect only for `roleId`. */
  createVoiceChannel(name: string, roleId: string): Promise<string>;
  /** Resolve without throwing when the object is already gone (Discord 10011 Unknown Role / 10003 Unknown Channel). */
  deleteRole(roleId: string): Promise<void>;
  deleteChannel(channelId: string): Promise<void>;
  /** Cache lookups; null when the id is not in the cache (deleted by hand, or never existed). */
  roleName(roleId: string): string | null;
  channelName(channelId: string): string | null;
  /** Cache: id of a role with exactly this name, or null. Used to adopt an object a lost column write orphaned. */
  findRoleByName(name: string): string | null;
  /** Cache: id of a channel with exactly this name under the matching clan category, or null. */
  findChannelByName(name: string, kind: "text" | "voice"): string | null;
  renameRole(roleId: string, name: string): Promise<void>;
  renameChannel(channelId: string, name: string): Promise<void>;
  /** Cache: user ids holding the role. Empty set for an unknown role. */
  roleMembers(roleId: string): Set<string>;
  /** Cache: is this user in the guild right now. */
  isMember(userId: string): boolean;
  addRole(userId: string, roleId: string): Promise<void>;
  removeRole(userId: string, roleId: string): Promise<void>;
  /** `applyNickname` semantics: never throws, reports the outcome. */
  setNickname(userId: string, nickname: string | null): Promise<NicknameOutcome>;
  /** Cache: user-type overwrite ids on this voice channel, EXCLUDING the bot's own (it is not a guest pass). Empty for an unknown channel. */
  memberOverwrites(channelId: string): Set<string>;
  /** `permissionOverwrites.edit(userId, { ViewChannel: true, Connect: true })`. */
  grantVoiceAccess(channelId: string, userId: string): Promise<void>;
  /** `permissionOverwrites.delete(userId)`, tolerating an already-missing overwrite or channel. */
  revokeVoiceAccess(channelId: string, userId: string): Promise<void>;
  /** Cache: this member's current nickname, or `undefined` when the member is not cached. */
  memberNickname(userId: string): string | null | undefined;
}

export type GuildGatewayConfig = { guildId: string; clanTextCategoryId: string; clanVoiceCategoryId: string };

/** discord.js's `Guild`/role/channel shapes, kept minimal to what this adapter uses. */
type RealGuild = {
  id: string;
  ownerId: string;
  roles: {
    cache: Map<string, { id: string; name: string; members: Map<string, unknown>; setName(name: string): Promise<unknown> }>;
    create(opts: { name: string }): Promise<{ id: string }>;
    fetch(id: string): Promise<{ delete(): Promise<unknown> } | null>;
  };
  channels: {
    cache: Map<string, {
      id: string; name: string; parentId: string | null; setName(name: string): Promise<unknown>;
      permissionOverwrites: {
        cache: Map<string, { id: string; type: number }>;
        edit(userId: string, opts: Record<string, boolean>): Promise<unknown>;
        delete(userId: string): Promise<unknown>;
      };
    }>;
    create(opts: Record<string, unknown>): Promise<{ id: string }>;
    fetch(id: string): Promise<{ delete(): Promise<unknown> } | null>;
  };
  members: {
    cache: Map<string, { nickname: string | null }>;
    fetch(userId?: string): Promise<unknown>;
    me: { permissions: { has(perm: bigint): boolean } } | null;
  };
};

/** True for a Discord "unknown object" error: the thing is already gone. */
function isAlreadyGone(err: unknown): boolean {
  return err instanceof DiscordAPIError && (err.code === 10003 || err.code === 10011);
}

/**
 * Adapts a real discord.js `Client` to `GuildGateway`. This is the ONLY place
 * real discord.js types meet the reconciler's structural interface —
 * everything downstream stays client-free for testing.
 *
 * The guild is fetched once (on first use) and cached in this closure, both
 * as a promise (for callers that must await it) and, once resolved, as a
 * plain value so the cache-only reads (`roleName`, `roleMembers`, `isMember`,
 * `channelName`) can stay synchronous per the `GuildGateway` interface.
 */
export function createGuildGateway(client: Client, cfg: GuildGatewayConfig): GuildGateway {
  let guildPromise: Promise<RealGuild> | undefined;
  let resolvedGuild: RealGuild | undefined;

  // ⚠️ Memoize only a RESOLVED fetch. A rejected promise left in `guildPromise`
  // would be handed to every later caller, so one transient `guilds.fetch`
  // failure would wedge every structural write for the process lifetime.
  const getGuild = async (): Promise<RealGuild> => {
    guildPromise ??= (client.guilds.fetch(cfg.guildId) as unknown as Promise<RealGuild>).then(
      (g) => {
        resolvedGuild = g;
        return g;
      },
      (err: unknown) => {
        guildPromise = undefined; // clear the memo so the next call retries
        console.error("guild fetch failed (retrying on next use)", err);
        throw err;
      },
    );
    return guildPromise;
  };

  /**
   * The bot's own user id, for the channel overwrites below. Null only before
   * login; the gateway is constructed at start-up but every method runs after
   * `clientReady`, so this is a programming error rather than a runtime case.
   */
  const botUserId = (): string => {
    const id = client.user?.id;
    if (id === undefined) {
      throw new Error("GuildGateway: client.user is null — the gateway is only usable after login");
    }
    return id;
  };

  const cachedGuild = (): RealGuild => {
    if (resolvedGuild === undefined) {
      throw new Error("GuildGateway: guild not fetched yet — call fetchAllMembers() first");
    }
    return resolvedGuild;
  };

  return {
    async fetchAllMembers() {
      const guild = await getGuild();
      const members = (await guild.members.fetch()) as Map<string, unknown>;
      return members.size;
    },

    async createRole(name) {
      const guild = await getGuild();
      const role = await guild.roles.create({ name });
      return role.id;
    },

    async createTextChannel(name, roleId) {
      const guild = await getGuild();
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: cfg.clanTextCategoryId,
        // ⚠️ The bot needs its OWN entry. `GuildChannelManager.create` sends
        // permission_overwrites explicitly, which REPLACES the set synced from
        // the category, and the @everyone deny applies to the bot too (it is
        // not an Administrator). Without this, every clan channel notice
        // 50001s and the increment's headline feature never delivers.
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: roleId, allow: [PermissionFlagsBits.ViewChannel] },
          { id: botUserId(), allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] },
        ],
      });
      return channel.id;
    },

    async createVoiceChannel(name, roleId) {
      const guild = await getGuild();
      const channel = await guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: cfg.clanVoiceCategoryId,
        // Same reason as the text channel: the bot must keep View (and Connect,
        // so a later increment can move or clean up the channel) on its own.
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
          { id: botUserId(), allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
        ],
      });
      return channel.id;
    },

    async deleteRole(roleId) {
      const guild = await getGuild();
      try {
        const role = await guild.roles.fetch(roleId);
        if (role === null) return;
        await role.delete();
      } catch (err) {
        if (isAlreadyGone(err)) return;
        throw err;
      }
    },

    async deleteChannel(channelId) {
      const guild = await getGuild();
      try {
        const channel = await guild.channels.fetch(channelId);
        if (channel === null) return;
        await channel.delete();
      } catch (err) {
        if (isAlreadyGone(err)) return;
        throw err;
      }
    },

    roleName(roleId) {
      return cachedGuild().roles.cache.get(roleId)?.name ?? null;
    },

    channelName(channelId) {
      return cachedGuild().channels.cache.get(channelId)?.name ?? null;
    },

    findRoleByName(name) {
      for (const role of cachedGuild().roles.cache.values()) {
        if (role.name === name) return role.id;
      }
      return null;
    },

    // The category parent is part of the match: a clan's text and voice names
    // never collide, but an unrelated channel elsewhere in the guild with the
    // same name must not be adopted as a clan's.
    findChannelByName(name, kind) {
      const parentId = kind === "text" ? cfg.clanTextCategoryId : cfg.clanVoiceCategoryId;
      for (const channel of cachedGuild().channels.cache.values()) {
        if (channel.name === name && channel.parentId === parentId) return channel.id;
      }
      return null;
    },

    async renameRole(roleId, name) {
      const guild = await getGuild();
      const role = guild.roles.cache.get(roleId);
      if (role === undefined) return;
      await role.setName(name);
    },

    async renameChannel(channelId, name) {
      const guild = await getGuild();
      const channel = guild.channels.cache.get(channelId);
      if (channel === undefined) return;
      await channel.setName(name);
    },

    roleMembers(roleId) {
      return new Set(cachedGuild().roles.cache.get(roleId)?.members.keys() ?? []);
    },

    isMember(userId) {
      return cachedGuild().members.cache.has(userId);
    },

    async addRole(userId, roleId) {
      const guild = await getGuild();
      const member = (await guild.members.fetch(userId)) as { roles: { add(roleId: string): Promise<unknown> } };
      await member.roles.add(roleId);
    },

    async removeRole(userId, roleId) {
      const guild = await getGuild();
      const member = (await guild.members.fetch(userId)) as { roles: { remove(roleId: string): Promise<unknown> } };
      await member.roles.remove(roleId);
    },

    async setNickname(userId, nickname) {
      const guild = await getGuild();
      const guildLike: GuildLike = {
        ownerId: guild.ownerId,
        members: {
          fetch: (id) => guild.members.fetch(id) as Promise<{ manageable: boolean; setNickname(n: string | null): Promise<unknown> }>,
        },
        members_me_permissions_has: () => guild.members.me?.permissions.has(PermissionFlagsBits.ManageNicknames) ?? false,
      };
      return applyNickname(guildLike, userId, nickname);
    },

    memberOverwrites(channelId) {
      const channel = cachedGuild().channels.cache.get(channelId);
      if (channel === undefined) return new Set<string>();
      const result = new Set<string>();
      for (const ov of channel.permissionOverwrites.cache.values()) {
        // ⚠️ The bot's own overwrite is excluded, never diffed. `createVoiceChannel`
        // deliberately grants the bot View+Connect on every clan voice channel
        // (the @everyone deny applies to it too — it is not an Administrator),
        // and that overwrite is NOT a guest pass. Without this exclusion, step
        // 7's stray-revoke loop reads it as an id with no open pass behind it
        // and revokes the bot's own access on the very first tick.
        if (ov.type === OverwriteType.Member && ov.id !== botUserId()) result.add(ov.id);
      }
      return result;
    },

    async grantVoiceAccess(channelId, userId) {
      const guild = await getGuild();
      const channel = guild.channels.cache.get(channelId);
      if (channel === undefined) return;
      await channel.permissionOverwrites.edit(userId, { ViewChannel: true, Connect: true });
    },

    async revokeVoiceAccess(channelId, userId) {
      const guild = await getGuild();
      const channel = guild.channels.cache.get(channelId);
      if (channel === undefined) return;
      try {
        await channel.permissionOverwrites.delete(userId);
      } catch (err) {
        if (isAlreadyGone(err)) return;
        throw err;
      }
    },

    memberNickname(userId) {
      const member = cachedGuild().members.cache.get(userId);
      return member === undefined ? undefined : member.nickname;
    },
  };
}
