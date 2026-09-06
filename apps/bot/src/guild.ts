import { ChannelType, DiscordAPIError, PermissionFlagsBits, type Client } from "discord.js";
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
    cache: Map<string, { id: string; name: string; setName(name: string): Promise<unknown> }>;
    create(opts: Record<string, unknown>): Promise<{ id: string }>;
    fetch(id: string): Promise<{ delete(): Promise<unknown> } | null>;
  };
  members: {
    cache: Map<string, unknown>;
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

  const getGuild = async (): Promise<RealGuild> => {
    guildPromise ??= (client.guilds.fetch(cfg.guildId) as unknown as Promise<RealGuild>).then((g) => {
      resolvedGuild = g;
      return g;
    });
    return guildPromise;
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
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: roleId, allow: [PermissionFlagsBits.ViewChannel] },
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
        permissionOverwrites: [
          { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
          { id: roleId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] },
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
  };
}
