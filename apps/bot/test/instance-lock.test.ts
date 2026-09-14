import { describe, it, expect, afterEach } from "vitest";
import { requireTestDatabaseUrl } from "@factions/db";
import { acquireInstanceLock, type InstanceLock } from "../src/instance-lock.js";

/**
 * Spec: exactly one bot process may run against a database (PLAN-3-INBOX
 * item 22). This is the test that makes that an enforced fact rather than an
 * operator convention — and it has to run against real Postgres, because the
 * whole mechanism IS a Postgres advisory lock. A fake would test nothing.
 */
describe("the instance lock", () => {
  const URL = requireTestDatabaseUrl();
  const held: InstanceLock[] = [];

  const take = async () => {
    const lock = await acquireInstanceLock(URL);
    if (lock) held.push(lock);
    return lock;
  };

  afterEach(async () => {
    while (held.length > 0) await held.pop()!.release();
  });

  it("is granted to the first caller", async () => {
    expect(await take()).not.toBeNull();
  });

  it("refuses the second caller rather than waiting for the first", async () => {
    expect(await take()).not.toBeNull();
    // ⚠️ `pg_try_advisory_lock`, not `pg_advisory_lock`: the blocking form
    // would leave a second instance hanging at startup forever, looking
    // exactly like a hung boot. Refusing immediately is what lets the guard
    // print a sentence and exit.
    expect(await take()).toBeNull();
  });

  it("hands the lock to the next caller once it is released", async () => {
    const first = await take();
    expect(first).not.toBeNull();
    await held.pop()!.release();
    expect(await take()).not.toBeNull();
  });

  /**
   * ⚠️ The property that makes an advisory lock the right tool over a row
   * lease: it is session-scoped, so a bot that is SIGKILLed, OOM-killed or
   * loses power releases it when its connection dies — no TTL, no clock
   * skew, no stale holder blocking recovery until a lease expires.
   * `release()` closes the connection, which is the same path.
   */
  it("releases when the connection goes away, not on a timer", async () => {
    const first = await take();
    expect(first).not.toBeNull();
    await held.pop()!.release();
    // No wait, no TTL: the very next attempt succeeds.
    expect(await take()).not.toBeNull();
  });

  it("is safe to release twice", async () => {
    const lock = await take();
    held.pop();
    await lock!.release();
    await expect(lock!.release()).resolves.not.toThrow();
  });
});
