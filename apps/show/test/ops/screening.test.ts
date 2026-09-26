import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import type { Database } from "@factions/db";
import { openDb, makeFixture, MON } from "../fixture.js";
import { setVerdict, weekReport } from "../../src/ops/screening-cli.js";
import { PgScreeningStore } from "../../src/screening/store.js";
import { advance, createEpisode } from "../../src/stages/store.js";

describe("screening operator commands", () => {
  let db: Database;
  beforeAll(async () => { db = await openDb(); });
  beforeEach(async () => { await makeFixture(db); });

  it("writes an operator verdict that the automatic screens cannot overwrite", async () => {
    await setVerdict(db, "Nazgul", "allow");
    const store = new PgScreeningStore(db);
    await store.put("Nazgul", { verdict: "block", source: "llm", reason: "x" });
    expect((await store.get(["Nazgul"])).get("Nazgul")).toMatchObject({ verdict: "allow", source: "operator" });
  });

  it("an operator can change their own verdict", async () => {
    await setVerdict(db, "Nazgul", "allow");
    await setVerdict(db, "Nazgul", "block");
    expect((await new PgScreeningStore(db).get(["Nazgul"])).get("Nazgul")).toMatchObject({ verdict: "block", source: "operator" });
  });

  it("prints a week's redactions and script reasons raw, for the terminal only", async () => {
    await createEpisode(db, MON);
    await advance(db, MON, "held", { screeningReport: { redactions: [{ text: "Bad88", kinds: ["gamertag"], replacement: "REDACTED_PLAYER_1", reason: "blocklist: 88", source: "blocklist" }], blocked: ["Bad88"], allowed: [], scriptReasons: ['attempt 1: blocked text: "Bad88"'] } });
    const out = await weekReport(db, MON);
    expect(out).toContain("Bad88 -> REDACTED_PLAYER_1 (blocklist: blocklist: 88)");
    expect(out).toContain('attempt 1: blocked text: "Bad88"');
    expect(out).toContain("stage: held");
  });
});
