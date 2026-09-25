import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { createClient, requireTestDatabaseUrl } from "../src/index";

const URL = requireTestDatabaseUrl();

describe("createClient readOnly", () => {
  const ro = createClient(URL, { readOnly: true });
  const rw = createClient(URL);
  afterAll(async () => { await ro.$client.end(); await rw.$client.end(); });

  it("⚠️ refuses every write, on every pooled connection", async () => {
    // Several at once so more than one pooled connection is exercised: the setting is
    // a connection startup parameter, not a SET on whichever connection ran first.
    const attempts = Array.from({ length: 4 }, () => ro.execute(sql`create temp table t_ro (a int)`));
    for (const a of attempts) await expect(a).rejects.toThrow(/read-only transaction/u);
  });

  it("still reads", async () => {
    const r = await ro.execute(sql`select 1 as one`);
    expect((r as unknown as { one: number }[])[0]!.one).toBe(1);
  });

  it("leaves the default client writable", async () => {
    await expect(rw.execute(sql`create temp table t_rw (a int)`)).resolves.toBeDefined();
  });
});
