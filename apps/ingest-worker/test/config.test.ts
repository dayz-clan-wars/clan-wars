import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const OK = {
  DATABASE_URL: "postgres://x",
  NITRADO_TOKEN: "t",
};

describe("loadConfig", () => {
  it("reads a complete environment", () => {
    const cfg = loadConfig(OK);
    expect(cfg).toMatchObject({ databaseUrl: "postgres://x", nitradoToken: "t" });
  });

  it("defaults the interval to 60 seconds and the budget to 15 files", () => {
    const cfg = loadConfig(OK);
    expect(cfg.intervalSeconds).toBe(60);
    expect(cfg.backfillBudget).toBe(15);
  });

  for (const key of ["DATABASE_URL", "NITRADO_TOKEN"]) {
    it(`refuses to start without ${key}`, () => {
      expect(() => loadConfig({ ...OK, [key]: undefined })).toThrow(key);
    });
  }

  it("⚠️ no longer takes a mission directory from the environment", () => {
    // One process-wide path was correct for exactly one server: it embeds the
    // gameserver's username, so the second server's file went into the first
    // server's directory — succeeding silently. It is resolved per server from
    // Nitrado now, and a stale env value must not be able to come back and
    // override that.
    const cfg = loadConfig({ ...OK, MISSION_CUSTOM_DIR: "/somewhere/stale" }) as Record<string, unknown>;
    expect(cfg).not.toHaveProperty("missionCustomDir");
    expect(Object.values(cfg)).not.toContain("/somewhere/stale");
  });

  it("rejects an interval that Number() would silently reinterpret", () => {
    // "1e3" and " 10 " both coerce happily and would produce an interval
    // nobody configured. Same rationale as apps/bot/src/config.ts.
    for (const raw of ["1e3", " 10 ", "0x10", "soon", "0", "-5"]) {
      expect(() => loadConfig({ ...OK, INGEST_INTERVAL_SECONDS: raw }))
        .toThrow(/INGEST_INTERVAL_SECONDS/);
    }
  });

  it("allows a zero backfill budget but not a negative one", () => {
    // Zero is meaningful: process only the live file this tick.
    expect(loadConfig({ ...OK, ADM_BACKFILL_BUDGET: "0" }).backfillBudget).toBe(0);
    expect(() => loadConfig({ ...OK, ADM_BACKFILL_BUDGET: "-1" })).toThrow(/ADM_BACKFILL_BUDGET/);
  });
});
