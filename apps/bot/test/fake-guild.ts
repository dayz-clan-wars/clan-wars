import type { GuildGateway, NicknameOutcome } from "../src/guild.js";

/** In-memory `GuildGateway` shared by structure-tick.test.ts. */
export class FakeGuild implements GuildGateway {
  roles = new Map<string, { name: string; members: Set<string> }>();
  channels = new Map<string, { name: string; kind: "text" | "voice"; roleId: string }>();
  members = new Map<string, { nickname: string | null }>();
  overwrites = new Map<string, Set<string>>();
  nicknameOutcome: NicknameOutcome = "ok";
  calls: string[] = [];
  failNext = new Set<string>(); // method names that throw once
  private n = 0;
  private fail(m: string) {
    if (this.failNext.delete(m)) throw new Error(`${m} failed`);
  }
  async fetchAllMembers() {
    return this.members.size;
  }
  async createRole(name: string) {
    this.fail("createRole");
    const id = `role-${++this.n}`;
    this.roles.set(id, { name, members: new Set() });
    this.calls.push(`createRole ${name}`);
    return id;
  }
  async createTextChannel(name: string, roleId: string) {
    this.fail("createTextChannel");
    const id = `text-${++this.n}`;
    this.channels.set(id, { name, kind: "text", roleId });
    this.calls.push(`createTextChannel ${name}`);
    return id;
  }
  async createVoiceChannel(name: string, roleId: string) {
    this.fail("createVoiceChannel");
    const id = `voice-${++this.n}`;
    this.channels.set(id, { name, kind: "voice", roleId });
    this.calls.push(`createVoiceChannel ${name}`);
    return id;
  }
  async deleteRole(id: string) {
    this.fail("deleteRole");
    this.roles.delete(id);
    this.calls.push(`deleteRole ${id}`);
  }
  async deleteChannel(id: string) {
    this.fail("deleteChannel");
    this.channels.delete(id);
    this.calls.push(`deleteChannel ${id}`);
  }
  roleName(id: string) {
    return this.roles.get(id)?.name ?? null;
  }
  channelName(id: string) {
    return this.channels.get(id)?.name ?? null;
  }
  findRoleByName(name: string) {
    for (const [id, r] of this.roles) if (r.name === name) return id;
    return null;
  }
  findChannelByName(name: string, kind: "text" | "voice") {
    for (const [id, c] of this.channels) if (c.name === name && c.kind === kind) return id;
    return null;
  }
  async renameRole(id: string, name: string) {
    this.roles.get(id)!.name = name;
    this.calls.push(`renameRole ${id} ${name}`);
  }
  async renameChannel(id: string, name: string) {
    this.channels.get(id)!.name = name;
    this.calls.push(`renameChannel ${id} ${name}`);
  }
  roleMembers(id: string) {
    return new Set(this.roles.get(id)?.members ?? []);
  }
  isMember(userId: string) {
    return this.members.has(userId);
  }
  async addRole(userId: string, roleId: string) {
    this.fail("addRole");
    this.roles.get(roleId)?.members.add(userId);
    this.calls.push(`addRole ${userId} ${roleId}`);
  }
  async removeRole(userId: string, roleId: string) {
    this.fail("removeRole");
    this.roles.get(roleId)?.members.delete(userId);
    this.calls.push(`removeRole ${userId} ${roleId}`);
  }
  async setNickname(userId: string, nickname: string | null) {
    this.calls.push(`setNickname ${userId} ${nickname}`);
    if (this.nicknameOutcome === "ok") {
      const m = this.members.get(userId);
      if (m) m.nickname = nickname;
    }
    return this.nicknameOutcome;
  }
  memberOverwrites(channelId: string) {
    return new Set(this.overwrites.get(channelId) ?? []);
  }
  async grantVoiceAccess(channelId: string, userId: string) {
    this.fail("grantVoiceAccess");
    const set = this.overwrites.get(channelId) ?? new Set<string>();
    set.add(userId);
    this.overwrites.set(channelId, set);
    this.calls.push(`grantVoiceAccess ${channelId} ${userId}`);
  }
  async revokeVoiceAccess(channelId: string, userId: string) {
    this.fail("revokeVoiceAccess");
    this.overwrites.get(channelId)?.delete(userId);
    this.calls.push(`revokeVoiceAccess ${channelId} ${userId}`);
  }
  memberNickname(userId: string) {
    return this.members.get(userId)?.nickname;
  }
}
