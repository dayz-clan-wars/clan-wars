import { describe, it, expect } from "vitest";
import { VAULT_INTRO } from "@factions/copy";
import { locks, vaultGroup } from "../src/commands/vault.js";
import { confirmId, modalId } from "../src/commands/confirm.js";
import { ctxWith, input, specOf, componentOf } from "./command-fakes.js";
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

  /**
   * ⚠️ The one thing this card may never contain. `VaultLockView` carries no
   * code field at all — this guards against a future edit that joins in
   * some OTHER lock field the embed does not read today (here, `createdBy`)
   * and happens to leak a code-shaped string onto the card. A weaker check
   * (e.g. matching the literal word "code") would pass even if the digits
   * themselves reached the card under a different label, so this asserts
   * the distinctive string itself is entirely absent from the serialised
   * embed.
   */
  it("never prints a code", async () => {
    const ctx = ctxWith({ vaultFor: async () => state({ locks: [lock({ createdBy: "9137" })] }) });
    const reply = await specOf(vaultGroup, "vault list").handler(ctx, input());
    expect(JSON.stringify(reply.embeds![0]!.toJSON())).not.toContain("9137");
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
    expect(JSON.stringify(reply.embeds![0]!.toJSON().fields ?? [])).toMatch(/no locks/iu);
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

describe("/vault add", () => {
  it("opens a modal and never puts the code on the command line", async () => {
    const reply = await specOf(vaultGroup, "vault add").handler(ctxWith({}), input({ minrole: "officer" }));
    const j = reply.modal!.toJSON();
    expect(j.custom_id).toBe(modalId("vault-add", "111", "officer"));
    const rows = j.components as unknown as { components: { custom_id?: string }[] }[];
    const ids = rows.flatMap((r) => r.components.map((c) => c.custom_id));
    expect(ids).toEqual(["name", "note", "code"]);
    // ⚠️ The option list must not carry a `code` — a slash option is visible
    // while typed and persists in Discord's client-side command history.
    const sub = vaultGroup.command.toJSON().options!.find((o) => o.name === "add")!;
    const opts = (sub as { options?: { name: string }[] }).options ?? [];
    expect(opts.map((o) => o.name)).toEqual(["minrole"]);
  });

  it("refuses a minrole that is not a role, in the shared words", async () => {
    const reply = await specOf(vaultGroup, "vault add").handler(ctxWith({}), input({ minrole: "emperor" }));
    expect(reply.modal).toBeUndefined();
    expect(reply.content).toMatch(/missing or too long/u);
  });

  it("adds the lock the modal described, and answers with the table's words", async () => {
    let got: unknown;
    const ctx = ctxWith({ addLock: async (_id: string, a: unknown) => { got = a; return { outcome: "ok", lockId: 7 }; } });
    const reply = await vaultGroup.modals!["vault-add"]!(ctx, {
      actorDiscordId: "111", arg: "officer",
      field: (n) => ({ name: "Front gate", note: "the big one", code: "1234" })[n] ?? "",
    });
    expect(got).toEqual({ name: "Front gate", note: "the big one", minRole: "officer", code: "1234" });
    expect(reply.content).toBe("Lock added.");
  });

  it("leaves the code undefined when the field was left blank, so one is generated", async () => {
    let got: { code?: string } | undefined;
    const ctx = ctxWith({ addLock: async (_id: string, a: { code?: string }) => { got = a; return { outcome: "ok", lockId: 7 }; } });
    await vaultGroup.modals!["vault-add"]!(ctx, {
      actorDiscordId: "111", arg: "member",
      field: (n) => ({ name: "Shed", note: "", code: "  " })[n] ?? "",
    });
    expect(got!.code).toBeUndefined();
  });

  it("passes a refusal straight through from the roster", async () => {
    const ctx = ctxWith({ addLock: async () => ({ outcome: "not-permitted", lockId: null }) });
    const reply = await vaultGroup.modals!["vault-add"]!(ctx, {
      actorDiscordId: "111", arg: "member", field: (n) => (n === "name" ? "Shed" : ""),
    });
    expect(reply.content).toMatch(/Only an officer or the leader/u);
  });
});

describe("/vault edit", () => {
  it("prefills the modal with the lock as it stands", async () => {
    const ctx = ctxWith({ vaultFor: async () => state({ locks: [lock({ id: 4, name: "Back shed", note: "spare fuel" })] }) });
    const reply = await specOf(vaultGroup, "vault edit").handler(ctx, input({ lock: "4", minrole: "leader" }));
    const j = reply.modal!.toJSON();
    expect(j.custom_id).toBe(modalId("vault-edit", "111", "4.leader"));
    const rows = j.components as unknown as { components: { value?: string }[] }[];
    const values = rows.flatMap((r) => r.components.map((c) => c.value));
    expect(values).toEqual(["Back shed", "spare fuel"]);
  });

  it("says the lock is gone rather than opening a modal for nothing", async () => {
    const ctx = ctxWith({ vaultFor: async () => state({ locks: [] }) });
    const reply = await specOf(vaultGroup, "vault edit").handler(ctx, input({ lock: "4", minrole: "leader" }));
    expect(reply.modal).toBeUndefined();
    expect(reply.content).toBe("That lock no longer exists.");
  });

  it("edits the lock the arg named, with the role the arg carried", async () => {
    let got: unknown;
    const ctx = ctxWith({ editLock: async (_id: string, a: unknown) => { got = a; return "ok"; } });
    const reply = await vaultGroup.modals!["vault-edit"]!(ctx, {
      actorDiscordId: "111", arg: "4.leader",
      field: (n) => ({ name: "Back shed", note: "" })[n] ?? "",
    });
    expect(got).toEqual({ lockId: 4, name: "Back shed", note: null, minRole: "leader" });
    expect(reply.content).toBe("Saved.");
  });

  it("refuses a malformed arg instead of writing with a guess", async () => {
    const ctx = ctxWith({ editLock: async () => { throw new Error("must not be called"); } });
    const reply = await vaultGroup.modals!["vault-edit"]!(ctx, {
      actorDiscordId: "111", arg: "4.emperor", field: () => "x",
    });
    expect(reply.content).toMatch(/missing or too long/u);
  });
});

describe("/vault reveal", () => {
  it("hands back the code, and nothing else does", async () => {
    const ctx = ctxWith({
      vaultFor: async () => state({ locks: [lock({ id: 4, name: "Front gate" })] }),
      revealLock: async () => ({ outcome: "ok", code: "9182" }),
    });
    const reply = await specOf(vaultGroup, "vault reveal").handler(ctx, input({ lock: "4" }));
    expect(reply.content).toContain("9182");
    expect(reply.embeds).toBeUndefined();
    expect(reply.components).toBeUndefined();
    expect(reply.ephemeral).toBe(true);
  });

  it("says why, without a code, when the rank is too low", async () => {
    const ctx = ctxWith({
      vaultFor: async () => state({ locks: [lock({ id: 4 })] }),
      revealLock: async () => ({ outcome: "not-visible", code: null }),
    });
    const reply = await specOf(vaultGroup, "vault reveal").handler(ctx, input({ lock: "4" }));
    expect(reply.content).toBe("That lock is above your rank.");
  });

  it("passes a refusal through", async () => {
    const ctx = ctxWith({ vaultFor: async () => state(), revealLock: async () => ({ outcome: "not-in-clan", code: null }) });
    const reply = await specOf(vaultGroup, "vault reveal").handler(ctx, input({ lock: "4" }));
    expect(reply.content).toBe("You are not in a clan.");
  });
});

describe("/vault confirm", () => {
  it("confirms the lock the option named", async () => {
    let got: number | undefined;
    const ctx = ctxWith({ confirmLock: async (_id: string, lockId: number) => { got = lockId; return "ok"; } });
    const reply = await specOf(vaultGroup, "vault confirm").handler(ctx, input({ lock: "4" }));
    expect(got).toBe(4);
    expect(reply.content).toMatch(/no longer flags this lock/u);
  });

  it("asks for a lock rather than guessing", async () => {
    const ctx = ctxWith({ confirmLock: async () => { throw new Error("must not be called"); } });
    const reply = await specOf(vaultGroup, "vault confirm").handler(ctx, input());
    expect(reply.content).toMatch(/Pick a lock/u);
  });
});

describe("/vault delete", () => {
  it("writes nothing and offers a Confirm button", async () => {
    const ctx = ctxWith({ deleteLock: async () => { throw new Error("must not be called before the press"); } });
    const reply = await specOf(vaultGroup, "vault delete").handler(ctx, input({ lock: "4" }));
    expect(reply.content).toMatch(/Press Confirm/u);
    expect((reply.components![0]!.toJSON().components[0]! as { custom_id: string }).custom_id).toBe(confirmId("vault-del", "111", "4"));
  });

  it("deletes on the press, and the press is the write", async () => {
    let got: number | undefined;
    const ctx = ctxWith({ deleteLock: async (_id: string, lockId: number) => { got = lockId; return "ok"; } });
    const reply = await componentOf(vaultGroup, "vault-del")(ctx, { actorDiscordId: "111", arg: "4", values: [] });
    expect(got).toBe(4);
    expect(reply.content).toBe("Deleted.");
  });
});

describe("/vault rotate", () => {
  it("offers Confirm for one lock and for every lock", async () => {
    const ctx = ctxWith({});
    const one = await specOf(vaultGroup, "vault rotate").handler(ctx, input({ lock: "4" }));
    expect((one.components![0]!.toJSON().components[0]! as { custom_id: string }).custom_id).toBe(confirmId("vault-rot", "111", "4"));
    const all = await specOf(vaultGroup, "vault rotate").handler(ctx, input({ lock: "all" }));
    expect((all.components![0]!.toJSON().components[0]! as { custom_id: string }).custom_id).toBe(confirmId("vault-rot", "111", "all"));
  });

  it("rotates every lock when the arg says all, and says how many", async () => {
    let got: unknown;
    const ctx = ctxWith({ rotateLocks: async (_id: string, l: unknown) => { got = l; return { outcome: "ok", rotated: 3 }; } });
    const reply = await componentOf(vaultGroup, "vault-rot")(ctx, { actorDiscordId: "111", arg: "all", values: [] });
    expect(got).toBe("all");
    expect(reply.content).toContain("3");
  });

  /** ⚠️ R3: there is no chosen-code path on either surface. A rotate never carries a code in or out. */
  it("never accepts or returns a code", async () => {
    const sub = vaultGroup.command.toJSON().options!.find((o) => o.name === "rotate")!;
    const opts = (sub as { options?: { name: string }[] }).options ?? [];
    expect(opts.map((o) => o.name)).toEqual(["lock"]);
    const ctx = ctxWith({ rotateLocks: async () => ({ outcome: "ok", rotated: 1 }) });
    const reply = await componentOf(vaultGroup, "vault-rot")(ctx, { actorDiscordId: "111", arg: "4", values: [] });
    expect(reply.content).not.toMatch(/\d{4}/u);
  });
});
