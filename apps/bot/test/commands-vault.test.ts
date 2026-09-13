import { describe, it, expect } from "vitest";
import { VAULT_INTRO } from "@factions/copy";
import { locks, vaultGroup } from "../src/commands/vault.js";
import { ctxWith, input, specOf } from "./command-fakes.js";
import type { VaultLockView, VaultState } from "@factions/roster";

const lock = (over: Partial<VaultLockView> = {}): VaultLockView => ({
  id: 1, name: "Front gate", note: "the big one", minRole: "member",
  createdAt: new Date("2026-09-01T00:00:00Z"), createdBy: "Ada",
  rotatedAt: null, rotatedBy: null, confirmedAt: null, changedInGame: false, exposed: false,
  ...over,
});
const state = (over: Partial<VaultState> = {}): VaultState => ({ locks: [lock()], history: null, ...over });

describe("/vault list", () => {
  it("refuses a player with no link, in the shared words", async () => {
    const ctx = ctxWith({ vaultFor: async () => "not-linked" });
    const reply = await specOf(vaultGroup, "vault list").handler(ctx, input());
    expect(reply.content).toMatch(/Link your character first/u);
    expect(reply.embeds).toBeUndefined();
    expect(reply.ephemeral).toBe(true);
  });

  it("renders the locks the rank may see, and the standing warning", async () => {
    const ctx = ctxWith({ vaultFor: async () => state() });
    const reply = await specOf(vaultGroup, "vault list").handler(ctx, input());
    const j = reply.embeds![0]!.toJSON();
    expect(j.description).toBe(VAULT_INTRO);
    expect(JSON.stringify(j.fields)).toContain("Front gate");
  });

  /** ⚠️ The one thing this card may never contain. `VaultLockView` carries no code — keep it that way. */
  it("never prints a code", async () => {
    const ctx = ctxWith({ vaultFor: async () => state({ locks: [lock({ name: "1234" })] }) });
    const reply = await specOf(vaultGroup, "vault list").handler(ctx, input());
    expect(JSON.stringify(reply.embeds![0]!.toJSON())).not.toMatch(/\bcode\b\s*[:=]/iu);
  });

  it("shows history to a leader and nothing to anyone else", async () => {
    const withHistory = state({ history: [{ at: new Date("2026-09-02T00:00:00Z"), action: "rotated", lockName: "Front gate", by: "Ada" }] });
    const leader = await specOf(vaultGroup, "vault list").handler(ctxWith({ vaultFor: async () => withHistory }), input());
    expect(JSON.stringify(leader.embeds![0]!.toJSON().fields)).toContain("rotated");
    const member = await specOf(vaultGroup, "vault list").handler(ctxWith({ vaultFor: async () => state() }), input());
    expect(JSON.stringify(member.embeds![0]!.toJSON().fields ?? [])).not.toContain("rotated");
  });

  it("says so plainly when the vault is empty", async () => {
    const ctx = ctxWith({ vaultFor: async () => state({ locks: [] }) });
    const reply = await specOf(vaultGroup, "vault list").handler(ctx, input());
    expect(reply.embeds![0]!.toJSON().fields ?? []).toEqual([]);
  });
});

describe("/vault lock autocomplete", () => {
  it("offers only the locks the roster returned, filtered by what was typed", async () => {
    const ctx = ctxWith({ vaultFor: async () => state({ locks: [lock({ id: 1, name: "Front gate" }), lock({ id: 2, name: "Back shed" })] }) });
    expect(await locks(ctx, { actorDiscordId: "111", value: "back" })).toEqual([{ name: "Back shed", value: "2" }]);
  });

  it("offers nothing rather than throwing when the actor cannot see a vault", async () => {
    const ctx = ctxWith({ vaultFor: async () => "not-in-clan" });
    expect(await locks(ctx, { actorDiscordId: "111", value: "" })).toEqual([]);
  });
});
