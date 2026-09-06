import { describe, it, expect, vi } from "vitest";
import { ChannelType, PermissionFlagsBits } from "discord.js";
import { roleNameFor, textChannelNameFor, voiceChannelNameFor, createGuildGateway } from "../src/guild.js";

describe("clan object names (spec §9.1)", () => {
  it("role is the name, text is clan-{tag} lowercased, voice is the TAG", () => {
    const n = { name: "Night Bears", tag: "Bear" };
    expect(roleNameFor(n)).toBe("Night Bears");
    expect(textChannelNameFor(n)).toBe("clan-bear");
    expect(voiceChannelNameFor(n)).toBe("BEAR");
  });
  it("text channel names survive characters Discord rejects", () => {
    expect(textChannelNameFor({ name: "x", tag: "A B/C" })).toBe("clan-a-b-c");
  });
  it("clamps a role name to 100 characters", () => {
    expect(roleNameFor({ name: "n".repeat(120), tag: "T" })).toHaveLength(100);
  });
});

function fakeClient() {
  const rolesCache = new Map<string, { id: string; name: string; members: Map<string, unknown> }>();
  const channelsCache = new Map<string, { id: string; name: string }>();
  const members = new Map<string, { id: string; manageable: boolean; roles: { add: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> }; setNickname: ReturnType<typeof vi.fn> }>();
  const guild = {
    id: "g", ownerId: "owner",
    roles: { cache: rolesCache, create: vi.fn(async ({ name }: { name: string }) => { const r = { id: `r-${name}`, name, members: new Map() }; rolesCache.set(r.id, r); return r; }), fetch: vi.fn(async (id: string) => rolesCache.get(id) ?? null) },
    channels: { cache: channelsCache, create: vi.fn(async (o: { name: string; type?: ChannelType; parent?: string; permissionOverwrites: unknown[] }) => { const c = { id: `c-${o.name}`, name: o.name, delete: vi.fn() }; channelsCache.set(c.id, c); return c; }), fetch: vi.fn(async (id: string) => channelsCache.get(id) ?? null) },
    members: { cache: members, fetch: vi.fn(async (id?: string) => (id ? members.get(id) : members)), me: { permissions: { has: () => true } } },
  };
  const client = { guilds: { fetch: vi.fn(async () => guild) } };
  return { client, guild, rolesCache, channelsCache, members };
}
const CFG = { guildId: "g", clanTextCategoryId: "cat-t", clanVoiceCategoryId: "cat-v" };

describe("createGuildGateway", () => {
  it("creates a text channel in the text category, hidden from @everyone and visible to the role", async () => {
    const f = fakeClient();
    const g = createGuildGateway(f.client as never, CFG);
    const id = await g.createTextChannel("clan-bear", "r-Bears");
    expect(id).toBe("c-clan-bear");
    const call = f.guild.channels.create.mock.calls[0]![0];
    expect(call).toMatchObject({ name: "clan-bear", type: ChannelType.GuildText, parent: "cat-t" });
    expect(call.permissionOverwrites).toEqual([
      { id: "g", deny: [PermissionFlagsBits.ViewChannel] },
      { id: "r-Bears", allow: [PermissionFlagsBits.ViewChannel] },
    ]);
  });
  it("creates a voice channel in the voice category with View + Connect for the role", async () => {
    const f = fakeClient();
    const g = createGuildGateway(f.client as never, CFG);
    await g.createVoiceChannel("BEAR", "r-Bears");
    const call = f.guild.channels.create.mock.calls[0]![0];
    expect(call).toMatchObject({ name: "BEAR", type: ChannelType.GuildVoice, parent: "cat-v" });
    expect(call.permissionOverwrites[1]).toEqual({ id: "r-Bears", allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect] });
  });
  it("⚠️ deleteRole and deleteChannel tolerate an object that is already gone", async () => {
    const f = fakeClient();
    const g = createGuildGateway(f.client as never, CFG);
    await expect(g.deleteRole("never-existed")).resolves.toBeUndefined();
    await expect(g.deleteChannel("never-existed")).resolves.toBeUndefined();
  });
  it("roleMembers and isMember read the cache and never call REST", async () => {
    const f = fakeClient();
    f.rolesCache.set("r1", { id: "r1", name: "Bears", members: new Map([["u1", {}], ["u2", {}]]) });
    f.members.set("u1", { id: "u1", manageable: true, roles: { add: vi.fn(), remove: vi.fn() }, setNickname: vi.fn() });
    const g = createGuildGateway(f.client as never, CFG);
    await g.fetchAllMembers();
    expect([...g.roleMembers("r1")].sort()).toEqual(["u1", "u2"]);
    expect(g.roleMembers("nope").size).toBe(0);
    expect(g.isMember("u1")).toBe(true);
    expect(g.isMember("u9")).toBe(false);
    expect(g.roleName("r1")).toBe("Bears");
    expect(g.roleName("nope")).toBeNull();
  });
  it("setNickname reports applyNickname's outcome instead of throwing", async () => {
    const f = fakeClient();
    f.members.set("u1", { id: "u1", manageable: false, roles: { add: vi.fn(), remove: vi.fn() }, setNickname: vi.fn() });
    const g = createGuildGateway(f.client as never, CFG);
    await g.fetchAllMembers();
    expect(await g.setNickname("u1", null)).toBe("outranked");
    expect(await g.setNickname("owner", null)).toBe("is-owner");
  });
});
