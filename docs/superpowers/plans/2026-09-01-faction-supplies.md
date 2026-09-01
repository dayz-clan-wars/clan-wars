# Faction Supply Spawns Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Spawn a base-building supply kit at each holding faction's flagpole, flying that faction's flag, by maintaining a vanilla DayZ object-spawner file through the Nitrado API.

**Architecture:** The spawner file is a *projection* of the `factions` table, not a side effect of claiming. A step in the ingest worker's existing sweep regenerates the whole file from the current holding factions, hashes it, and uploads only when the hash differs from the last successful upload. Generation is a pure function over a committed template; the template's `TerritoryFlag` is the offset anchor and is never emitted.

**Tech Stack:** pnpm workspaces + turbo, tsx (no build step), vitest, Drizzle ORM on Postgres 16, Nitrado REST API.

**Spec:** `docs/superpowers/specs/2026-09-01-faction-supplies-design.md`

## Global Constraints

- ESM/NodeNext — every local import carries a `.js` extension.
- Migrations are GENERATED (`pnpm -F @factions/db generate`), never hand-written or hand-edited.
- `factions` (port 5434) is the TEST database. `factions_live` holds real data — never point a test at it, never migrate it from a task.
- Never pre-read then write: preconditions belong in the statement's `WHERE`, outcomes come from `.returning()`.
- Comments explaining a hazard are load-bearing in this codebase.
- Do NOT restart the ingest worker or the Discord bot. Task 7 owns that.
- ⚠️ **`factions.x`, `.y`, `.z` are Postgres `numeric` and Drizzle returns them as STRINGS.** `"5551.69" + 20.9` is `"5551.6920.9"`. Every coordinate read must go through `Number()`.
- ⚠️ **Nitrado can return HTTP 200 with a failure payload.** Any new Nitrado call must check `json.status === "success"`, not just `res.ok`.

---

### Task 1: The template and the pure generator

**Files:**
- Create: `apps/ingest-worker/assets/flag-supplies.template.json` (copy of `../livonia/custom/flag-supplies.json`, unmodified)
- Create: `apps/ingest-worker/src/supplies.ts`
- Create: `packages/domain/src/factions.ts`
- Modify: `packages/domain/src/index.ts`, `apps/bot/src/roster-store.ts:5`
- Test: `apps/ingest-worker/test/supplies.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:

```ts
export const HOLDING_STATUSES = ["reserved", "active", "dormant"] as const;   // packages/domain
export type SpawnObject = {
  name: string; pos: [number, number, number]; ypr: [number, number, number];
  scale: number; enableCEPersistency: number; customString: string;
};
export type SupplyFaction = { tag: string; texture: string; x: number; y: number; z: number };
export function loadTemplate(json: unknown): SpawnObject[];        // offsets, anchor removed
export function generateSupplies(offsets: SpawnObject[], factions: SupplyFaction[]): string;
```

`generateSupplies` returns the file's exact bytes (a JSON string), because the hash in Task 3 must cover precisely what is uploaded.

- [ ] **Step 1: Copy the template and move HOLDING to domain**

```bash
mkdir -p apps/ingest-worker/assets
cp ../livonia/custom/flag-supplies.json apps/ingest-worker/assets/flag-supplies.template.json
```

Create `packages/domain/src/factions.ts`:

```ts
/**
 * The statuses in which a faction HOLDS its pole, flag and tag.
 *
 * ⚠️ Shared deliberately. The roster store gates every membership write on
 * this set, and the supply projection spawns a kit for exactly these
 * factions. Two copies would drift, and the symptom would be a disbanded
 * faction's supplies respawning at every restart forever.
 */
export const HOLDING_STATUSES = ["reserved", "active", "dormant"] as const;
```

Export it from `packages/domain/src/index.ts` alongside the existing exports. In `apps/bot/src/roster-store.ts:5`, delete the local `const HOLDING = [...]` and import it instead, aliasing so the rest of that file is untouched:

```ts
import { HOLDING_STATUSES as HOLDING } from "@factions/domain";
```

- [ ] **Step 2: Write the failing tests**

Create `apps/ingest-worker/test/supplies.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { loadTemplate, generateSupplies } from "../src/supplies.js";

const RAW = JSON.parse(readFileSync(new URL("../assets/flag-supplies.template.json", import.meta.url), "utf8"));

const COK = { tag: "COK", texture: "Flag_Rooster", x: 5551.69, y: 311.63, z: 8790.97 };

describe("loadTemplate", () => {
  it("drops the anchor and keeps every other object", () => {
    // The real template: 73 objects, exactly one TerritoryFlag.
    expect(RAW.Objects).toHaveLength(73);
    expect(loadTemplate(RAW)).toHaveLength(72);
    expect(loadTemplate(RAW).some((o) => o.name === "TerritoryFlag")).toBe(false);
  });

  it("expresses positions as offsets from the anchor", () => {
    // Anchor is at 5572.65625 / 310.8094482421875 / 8811.84375. The
    // Flag_White sits at 5573.5546875 / 312.02886962890627 / 8811.8125.
    const flag = loadTemplate(RAW).find((o) => o.name === "Flag_White")!;
    expect(flag.pos[0]).toBeCloseTo(0.8984375, 6);
    expect(flag.pos[1]).toBeCloseTo(1.2194213867, 6);
    expect(flag.pos[2]).toBeCloseTo(-0.03125, 6);
  });

  it("throws when the anchor is missing", () => {
    // ⚠️ Without this, every faction's kit lands at absolute template
    // coordinates — one pile on the map, nowhere near any pole.
    expect(() => loadTemplate({ Objects: [{ name: "NailBox", pos: [1, 2, 3], ypr: [0, 0, 0], scale: 1, enableCEPersistency: 0, customString: "" }] }))
      .toThrow(/anchor/i);
  });

  it("throws when the template has two anchors", () => {
    const two = { Objects: [RAW.Objects.find((o: any) => o.name === "TerritoryFlag"), RAW.Objects.find((o: any) => o.name === "TerritoryFlag")] };
    expect(() => loadTemplate(two)).toThrow(/anchor/i);
  });
});

describe("generateSupplies", () => {
  const offsets = loadTemplate(RAW);

  it("places the kit at the faction's pole", () => {
    const out = JSON.parse(generateSupplies(offsets, [COK]));
    expect(out.Objects).toHaveLength(72);
    const flag = out.Objects.find((o: any) => o.name === "Flag_Rooster");
    expect(flag.pos[0]).toBeCloseTo(5551.69 + 0.8984375, 6);
    expect(flag.pos[2]).toBeCloseTo(8790.97 - 0.03125, 6);
  });

  it("substitutes the faction's texture for the white flag", () => {
    const out = JSON.parse(generateSupplies(offsets, [COK]));
    expect(out.Objects.some((o: any) => o.name === "Flag_White")).toBe(false);
    expect(out.Objects.filter((o: any) => o.name === "Flag_Rooster")).toHaveLength(1);
  });

  it("stamps every object with the owning faction's tag", () => {
    const out = JSON.parse(generateSupplies(offsets, [COK]));
    expect(out.Objects.every((o: any) => o.customString === "COK")).toBe(true);
  });

  it("keeps ypr, scale and persistency from the template", () => {
    // ⚠️ enableCEPersistency stays 0: the spawner rebuilds the kit at every
    // mission start, so nothing accumulates. Flipping it to 1 would make each
    // restart add a second kit on top of the first.
    const out = JSON.parse(generateSupplies(offsets, [COK]));
    expect(out.Objects.every((o: any) => o.enableCEPersistency === 0)).toBe(true);
    const src = RAW.Objects.find((o: any) => o.name === "Pickaxe");
    const got = out.Objects.find((o: any) => o.name === "Pickaxe");
    expect(got.ypr).toEqual(src.ypr);
    expect(got.scale).toBe(src.scale);
  });

  it("emits every faction's kit", () => {
    const other = { tag: "WLF", texture: "Flag_Wolf", x: 100, y: 200, z: 300 };
    const out = JSON.parse(generateSupplies(offsets, [COK, other]));
    expect(out.Objects).toHaveLength(144);
    expect(out.Objects.filter((o: any) => o.customString === "WLF")).toHaveLength(72);
  });

  it("produces a valid empty file for no factions", () => {
    // The last faction disbanding must yield {"Objects":[]}, not a crash and
    // not a stale file — otherwise their kit respawns forever.
    expect(JSON.parse(generateSupplies(offsets, []))).toEqual({ Objects: [] });
  });

  it("is byte-stable for the same input", () => {
    // The hash in the upload tick compares these bytes. Any nondeterminism
    // (key order, float formatting) would re-upload on every single tick.
    expect(generateSupplies(offsets, [COK])).toBe(generateSupplies(offsets, [COK]));
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm -F @factions/ingest-worker test supplies`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement**

Create `apps/ingest-worker/src/supplies.ts`:

```ts
import { NEUTRAL_FLAG } from "@factions/domain";

export type SpawnObject = {
  name: string;
  pos: [number, number, number];
  ypr: [number, number, number];
  scale: number;
  enableCEPersistency: number;
  customString: string;
};

export type SupplyFaction = { tag: string; texture: string; x: number; y: number; z: number };

/** The template object whose position every other object is measured from. */
const ANCHOR = "TerritoryFlag";

/**
 * Turn the captured template into offsets from its anchor.
 *
 * ⚠️ The anchor is REMOVED, not emitted. Each faction already built the pole
 * they claimed; spawning a TerritoryFlag would stack a second pole on top of
 * theirs. And a template with no anchor would yield absolute coordinates,
 * piling every faction's kit at one spot on the map — silent and map-wide,
 * so it throws instead.
 */
export function loadTemplate(json: unknown): SpawnObject[] {
  const objects = (json as { Objects?: SpawnObject[] })?.Objects;
  if (!Array.isArray(objects)) throw new Error("supplies template: no Objects array");
  const anchors = objects.filter((o) => o.name === ANCHOR);
  if (anchors.length !== 1) {
    throw new Error(`supplies template: expected exactly one ${ANCHOR} anchor, found ${anchors.length}`);
  }
  const [ax, ay, az] = anchors[0]!.pos;
  return objects
    .filter((o) => o.name !== ANCHOR)
    .map((o) => ({ ...o, pos: [o.pos[0] - ax, o.pos[1] - ay, o.pos[2] - az] as [number, number, number] }));
}

/**
 * The exact bytes of the spawner file for these factions.
 *
 * Returns a string rather than an object because the upload tick hashes what
 * it uploads; hashing a re-serialised object could differ from the bytes sent.
 */
export function generateSupplies(offsets: SpawnObject[], factions: SupplyFaction[]): string {
  const out: SpawnObject[] = [];
  for (const f of factions) {
    for (const o of offsets) {
      out.push({
        // The white flag in the template is the flag ITEM, not the pole.
        name: o.name === NEUTRAL_FLAG ? f.texture : o.name,
        pos: [o.pos[0] + f.x, o.pos[1] + f.y, o.pos[2] + f.z],
        ypr: o.ypr,
        scale: o.scale,
        enableCEPersistency: o.enableCEPersistency,
        // Ownership, so an operator can tell whose kit a stray barrel is.
        customString: f.tag,
      });
    }
  }
  return JSON.stringify({ Objects: out });
}
```

- [ ] **Step 5: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/ingest-worker test
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test
git add apps/ingest-worker packages/domain apps/bot/src/roster-store.ts
git commit -m "feat(worker): generate faction supply spawns from a template"
```

---

### Task 2: Nitrado upload, and the 200-with-error hazard

**Files:**
- Modify: `packages/nitrado/src/client.ts`
- Test: `packages/nitrado/test/client.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `NitradoClient.uploadFile(remoteDir: string, fileName: string, content: string): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Add to `packages/nitrado/test/client.test.ts`, following the fake-fetch style already in that file:

```ts
  it("uploads via the two-step token flow", async () => {
    const calls: { url: string; init: any }[] = [];
    const fake = async (url: string, init: any) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("file_server/upload")) {
        return new Response(JSON.stringify({ status: "success", data: { token: { url: "https://up.example/put", token: "T0K" } } }), { status: 200 });
      }
      return new Response("", { status: 200 });
    };
    const c = new NitradoClient("tok", 42, fake as any);
    await c.uploadFile("/games/x/ftproot/dayzxb/mission/custom", "faction-supplies.json", "{}");

    expect(calls[0]!.url).toContain("/services/42/gameservers/file_server/upload");
    expect(JSON.parse(calls[0]!.init.body)).toEqual({ path: "/games/x/ftproot/dayzxb/mission/custom", file: "faction-supplies.json" });
    // ⚠️ The second POST carries the token in a bare `token` HEADER — not a
    // bearer, not a query parameter — with an application/binary body.
    expect(calls[1]!.url).toBe("https://up.example/put");
    expect(calls[1]!.init.headers.token).toBe("T0K");
    expect(calls[1]!.init.headers["Content-Type"]).toBe("application/binary");
    expect(calls[1]!.init.body).toBe("{}");
  });

  it("treats HTTP 200 with a failure payload as a failure", async () => {
    // ⚠️ Nitrado answers some errors with 200 and status:"error". Trusting
    // res.ok alone would record a hash for a file that was never written, and
    // the supply projection would then never retry.
    const fake = async () =>
      new Response(JSON.stringify({ status: "error", message: "nope" }), { status: 200 });
    const c = new NitradoClient("tok", 42, fake as any);
    await expect(c.uploadFile("/dir", "f.json", "{}")).rejects.toThrow(/nope|error/i);
  });

  it("fails when the upload token is missing", async () => {
    const fake = async () => new Response(JSON.stringify({ status: "success", data: {} }), { status: 200 });
    const c = new NitradoClient("tok", 42, fake as any);
    await expect(c.uploadFile("/dir", "f.json", "{}")).rejects.toThrow(/token/i);
  });

  it("fails when the binary POST is rejected", async () => {
    const fake = async (url: string) =>
      String(url).includes("file_server/upload")
        ? new Response(JSON.stringify({ status: "success", data: { token: { url: "https://up.example/put", token: "T" } } }), { status: 200 })
        : new Response("denied", { status: 403 });
    const c = new NitradoClient("tok", 42, fake as any);
    await expect(c.uploadFile("/dir", "f.json", "{}")).rejects.toThrow(/403/);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm -F @factions/nitrado test`
Expected: FAIL — `uploadFile is not a function`.

- [ ] **Step 3: Implement**

In `packages/nitrado/src/client.ts`, extend the existing private `getJson` to reject a failure payload, then add the upload. `getJson` currently checks only `res.ok`; add after the `res.ok` check:

```ts
    const body = await res.json() as Record<string, any>;
    // ⚠️ Nitrado answers some errors with HTTP 200 and status:"error".
    // Checking res.ok alone reports those as success.
    if (body.status !== "success") {
      throw new Error(`Nitrado ${path} returned status=${body.status}: ${body.message ?? "no message"}`);
    }
    return body;
```

Then add the method:

```ts
  /**
   * Write a file to the game server, via Nitrado's two-step token flow.
   *
   * ⚠️ Step two is NOT a normal API call: the URL comes from step one, the
   * token goes in a bare `token` header (not Authorization), and the body is
   * sent as application/binary. Sending it as JSON with a bearer silently
   * fails.
   */
  async uploadFile(remoteDir: string, fileName: string, content: string): Promise<void> {
    const json = await this.postJson(`/services/${this.serviceId}/gameservers/file_server/upload`, {
      path: remoteDir,
      file: fileName,
    });
    const url = json.data?.token?.url;
    const token = json.data?.token?.token;
    if (!url) throw new Error(`Nitrado upload: missing token url for ${remoteDir}/${fileName}`);
    const res = await this.fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/binary", ...(token ? { token } : {}) },
      body: content,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) throw new Error(`Nitrado upload failed ${res.status} for ${remoteDir}/${fileName}`);
  }
```

Add a `postJson` sibling to `getJson` that sends `method: "POST"`, `Content-Type: application/json`, a JSON body, and applies the same `status === "success"` check.

- [ ] **Step 4: Run and commit**

```bash
pnpm -F @factions/nitrado test
git add packages/nitrado
git commit -m "feat(nitrado): upload files, and reject 200-with-error payloads"
```

---

### Task 3: The uploaded-hash table

**Files:**
- Modify: `packages/db/src/schema.ts`
- Test: `packages/db/test/supply-uploads.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `supplyUploads` table — `serverId` (PK, FK to `servers.id`), `contentHash` text NOT NULL, `uploadedAt` timestamptz NOT NULL

- [ ] **Step 1: Write the failing test**

Create `packages/db/test/supply-uploads.test.ts`:

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, supplyUploads, servers, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";

describe("supply_uploads", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(requireTestDatabaseUrl());
    await runMigrations(db);
    await db.execute(sql`truncate table supply_uploads, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({
      name: "T", map: "livonia", clockOffsetMs: 0, active: true,
    }).returning();
    serverId = s!.id;
  });

  it("holds one row per server", async () => {
    await db.insert(supplyUploads).values({ serverId, contentHash: "abc", uploadedAt: new Date() });
    await expect(
      db.insert(supplyUploads).values({ serverId, contentHash: "def", uploadedAt: new Date() }),
    ).rejects.toThrow();
  });

  it("upserts the hash for a server", async () => {
    await db.insert(supplyUploads).values({ serverId, contentHash: "abc", uploadedAt: new Date() });
    await db.insert(supplyUploads)
      .values({ serverId, contentHash: "def", uploadedAt: new Date() })
      .onConflictDoUpdate({ target: supplyUploads.serverId, set: { contentHash: "def" } });
    const [row] = await db.select().from(supplyUploads).where(eq(supplyUploads.serverId, serverId));
    expect(row!.contentHash).toBe("def");
  });
});
```

If the `servers` insert above does not match that table's actual required columns, copy the fixture shape from `packages/db/test/identity.test.ts` instead — do not invent columns.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/db test supply-uploads`
Expected: FAIL — `supplyUploads` is not exported.

- [ ] **Step 3: Add the table**

In `packages/db/src/schema.ts`, after `factions`:

```ts
/**
 * The hash of the supply spawner file last successfully uploaded per server.
 *
 * ⚠️ This is the whole memory of the supply projection. The tick regenerates
 * the file every pass and uploads only when the hash differs, so without this
 * row it would re-upload an identical file forever. The hash advances ONLY on
 * a successful upload, which is what makes a failed upload retry on the next
 * tick instead of being lost.
 */
export const supplyUploads = pgTable("supply_uploads", {
  serverId: integer("server_id").primaryKey().references(() => servers.id),
  contentHash: text("content_hash").notNull(),
  uploadedAt: timestamp("uploaded_at", { withTimezone: true }).notNull(),
});
```

- [ ] **Step 4: Generate the migration**

Run: `pnpm -F @factions/db generate`

Read the emitted SQL. It must CREATE TABLE `supply_uploads` and nothing else — no DROP of any kind. If it contains anything else, stop and report.

- [ ] **Step 5: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/db test
git add packages/db
git commit -m "feat(db): remember the last uploaded supply file per server"
```

---

### Task 4: The supply tick

**Files:**
- Create: `apps/ingest-worker/src/supply-tick.ts`
- Test: `apps/ingest-worker/test/supply-tick.test.ts`

**Interfaces:**
- Consumes: `loadTemplate`, `generateSupplies`, `SupplyFaction` (Task 1); `uploadFile` (Task 2); `supplyUploads` (Task 3); `HOLDING_STATUSES` (Task 1)
- Produces:

```ts
export type SupplyUploader = { uploadFile(remoteDir: string, fileName: string, content: string): Promise<void> };
export type SupplyTickResult = { factions: number; uploaded: boolean };
export async function supplyTick(db: Database, deps: {
  serverId: number; client: SupplyUploader; offsets: SpawnObject[];
  remoteDir: string; fileName: string; now: Date;
}): Promise<SupplyTickResult>;
```

- [ ] **Step 1: Write the failing tests**

Create `apps/ingest-worker/test/supply-tick.test.ts`. Seed `servers` and `factions` rows following the fixture shape in `apps/ingest-worker/test/tick.test.ts` and `apps/bot/test/roster-store.test.ts`; truncate `supply_uploads, factions, servers` in `beforeEach`.

```ts
  it("uploads the kit for a holding faction", async () => {
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    const uploads: { dir: string; name: string; body: string }[] = [];
    const client = { uploadFile: async (dir: string, name: string, body: string) => { uploads.push({ dir, name, body }); } };

    const r = await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(r).toEqual({ factions: 1, uploaded: true });
    const parsed = JSON.parse(uploads[0]!.body);
    expect(parsed.Objects).toHaveLength(72);
    expect(parsed.Objects.every((o: any) => o.customString === "COK")).toBe(true);
  });

  it("does not upload again when nothing changed", async () => {
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    let calls = 0;
    const client = { uploadFile: async () => { calls++; } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    const second = await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(calls).toBe(1);
    expect(second.uploaded).toBe(false);
  });

  it("uploads again when a faction's texture changes", async () => {
    const f = await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    let calls = 0;
    const client = { uploadFile: async () => { calls++; } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    await db.update(factions).set({ texture: "Flag_Wolf" }).where(eq(factions.id, f.id));
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(calls).toBe(2);
  });

  it("drops a faction that stopped holding", async () => {
    const f = await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    const bodies: string[] = [];
    const client = { uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    await db.update(factions).set({ status: "disbanded" }).where(eq(factions.id, f.id));
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    // The kit must stop respawning: the file is now empty, not stale.
    expect(JSON.parse(bodies[1]!)).toEqual({ Objects: [] });
  });

  it("does not advance the hash when the upload fails", async () => {
    // ⚠️ THE retry property. If the hash advanced on failure, a single
    // Nitrado outage would leave the server permanently missing supplies
    // with nothing to retry it. Delete the success-only hash write and this
    // test must go red.
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    let calls = 0;
    const failing = { uploadFile: async () => { calls++; throw new Error("nitrado down"); } };
    await expect(supplyTick(db, { serverId, client: failing, offsets, remoteDir: "/d", fileName: "f.json", now })).rejects.toThrow(/nitrado down/);
    expect(await db.select().from(supplyUploads)).toHaveLength(0);

    const ok = { uploadFile: async () => { calls++; } };
    const retry = await supplyTick(db, { serverId, client: ok, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(retry.uploaded).toBe(true);
    expect(calls).toBe(2);
  });

  it("reads numeric coordinates as numbers, not strings", async () => {
    // ⚠️ factions.x/y/z are Postgres numeric, which Drizzle returns as
    // STRINGS. "5551.69" + 0.898 is "5551.690.898". Without Number() every
    // coordinate in the file is corrupt.
    await seedFaction({ tag: "COK", texture: "Flag_Rooster", x: "5551.69", y: "311.63", z: "8790.97", status: "reserved" });
    const bodies: string[] = [];
    const client = { uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    for (const o of JSON.parse(bodies[0]!).Objects) {
      for (const p of o.pos) expect(typeof p).toBe("number");
      expect(Number.isFinite(o.pos[0])).toBe(true);
    }
  });

  it("ignores factions on another server", async () => {
    const other = await seedServer("other");
    await seedFaction({ tag: "OTH", texture: "Flag_Wolf", x: "1", y: "2", z: "3", status: "active", serverId: other });
    const bodies: string[] = [];
    const client = { uploadFile: async (_d: string, _n: string, b: string) => { bodies.push(b); } };
    await supplyTick(db, { serverId, client, offsets, remoteDir: "/d", fileName: "f.json", now });
    expect(JSON.parse(bodies[0]!)).toEqual({ Objects: [] });
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/ingest-worker test supply-tick`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/ingest-worker/src/supply-tick.ts`:

```ts
import { createHash } from "node:crypto";
import type { Database } from "@factions/db";
import { factions, supplyUploads } from "@factions/db";
import { HOLDING_STATUSES } from "@factions/domain";
import { and, eq, inArray, asc } from "drizzle-orm";
import { generateSupplies, type SpawnObject, type SupplyFaction } from "./supplies.js";

export type SupplyUploader = {
  uploadFile(remoteDir: string, fileName: string, content: string): Promise<void>;
};

export type SupplyTickResult = { factions: number; uploaded: boolean };

/**
 * Mirror this server's holding factions into the spawner file.
 *
 * ⚠️ A PROJECTION, not a side effect of claiming. The file is regenerated in
 * full every pass and uploaded only when it differs from the last successful
 * upload. That is what makes a failed upload self-healing (the hash does not
 * advance, so the next tick retries) and what makes disband and lapse need no
 * code of their own — those rows simply stop being holding.
 */
export async function supplyTick(db: Database, deps: {
  serverId: number;
  client: SupplyUploader;
  offsets: SpawnObject[];
  remoteDir: string;
  fileName: string;
  now: Date;
}): Promise<SupplyTickResult> {
  const rows = await db.select({
    tag: factions.tag, texture: factions.texture,
    x: factions.x, y: factions.y, z: factions.z,
  }).from(factions)
    .where(and(
      eq(factions.serverId, deps.serverId),
      inArray(factions.status, [...HOLDING_STATUSES]),
    ))
    // Stable order, or the bytes differ between ticks and we upload forever.
    .orderBy(asc(factions.tag));

  // ⚠️ numeric columns arrive as STRINGS from Drizzle. Without Number() the
  // additions in generateSupplies concatenate and every coordinate is junk.
  const list: SupplyFaction[] = rows.map((r) => ({
    tag: r.tag, texture: r.texture,
    x: Number(r.x), y: Number(r.y), z: Number(r.z),
  }));

  const content = generateSupplies(deps.offsets, list);
  const hash = createHash("sha256").update(content).digest("hex");

  const [existing] = await db.select().from(supplyUploads)
    .where(eq(supplyUploads.serverId, deps.serverId));
  if (existing?.contentHash === hash) return { factions: list.length, uploaded: false };

  // The hash is written ONLY after the upload resolves. A throw here leaves
  // the stored hash untouched, so the next tick tries again.
  await deps.client.uploadFile(deps.remoteDir, deps.fileName, content);

  await db.insert(supplyUploads)
    .values({ serverId: deps.serverId, contentHash: hash, uploadedAt: deps.now })
    .onConflictDoUpdate({
      target: supplyUploads.serverId,
      set: { contentHash: hash, uploadedAt: deps.now },
    });

  return { factions: list.length, uploaded: true };
}
```

- [ ] **Step 4: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/ingest-worker test
git add apps/ingest-worker
git commit -m "feat(worker): mirror holding factions into the supply spawner file"
```

---

### Task 5: Wire the tick into the sweep

**Files:**
- Modify: `apps/ingest-worker/src/sweep.ts`, `apps/ingest-worker/src/main.ts`, `apps/ingest-worker/src/config.ts`
- Test: `apps/ingest-worker/test/sweep.test.ts`, `apps/ingest-worker/test/config.test.ts`

**Interfaces:**
- Consumes: `supplyTick` (Task 4)
- Produces: `SweepDeps.supplies?: { client, offsets, remoteDir, fileName }`; `WorkerConfig.missionCustomDir: string`

- [ ] **Step 1: Write the failing tests**

Add to `apps/ingest-worker/test/sweep.test.ts`:

```ts
  it("runs the supply tick for each server", async () => {
    const seen: number[] = [];
    await ingestSweep(db, {
      ...baseDeps,
      supplies: { offsets: [], remoteDir: "/d", fileName: "f.json", clientFor: () => ({ uploadFile: async () => { seen.push(1); } }) },
    });
    expect(seen.length).toBeGreaterThan(0);
  });

  it("keeps ingesting when the supply tick throws", async () => {
    // ⚠️ A Nitrado file-server outage must not stop log ingestion. Supplies
    // are cosmetic; missing events are permanent.
    const errors: unknown[] = [];
    const r = await ingestSweep(db, {
      ...baseDeps,
      supplies: { offsets: [], remoteDir: "/d", fileName: "f.json", clientFor: () => ({ uploadFile: async () => { throw new Error("boom"); } }) },
      onSupplyError: (_id, err) => errors.push(err),
    });
    expect(r.servers).toBeGreaterThan(0);
    expect(errors).toHaveLength(1);
  });
```

Add to `apps/ingest-worker/test/config.test.ts`:

```ts
  it("requires MISSION_CUSTOM_DIR", () => {
    expect(() => loadConfig({ ...baseEnv, MISSION_CUSTOM_DIR: undefined })).toThrow(/MISSION_CUSTOM_DIR/);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/ingest-worker test`
Expected: FAIL — `supplies` is not a known dep; `MISSION_CUSTOM_DIR` is not read.

- [ ] **Step 3: Implement**

In `apps/ingest-worker/src/config.ts`, add `missionCustomDir: string` to `WorkerConfig` and read it with the existing `required(env, "MISSION_CUSTOM_DIR")`. It has no sensible default — a wrong path uploads the file where the server will never read it, and nothing would report that.

In `apps/ingest-worker/src/sweep.ts`, extend `SweepDeps`:

```ts
  /** Absent in tests that only exercise ingestion. */
  supplies?: {
    clientFor: (nitradoServiceId: number) => SupplyUploader;
    offsets: SpawnObject[];
    remoteDir: string;
    fileName: string;
  };
  onSupplyError?: (serverId: number, err: unknown) => void;
```

Inside the per-server loop, AFTER the existing `ingestTick` try/catch:

```ts
    // ⚠️ Its own try/catch, and it runs after ingestion. A Nitrado
    // file-server outage must not cost us log events: supplies reappear at
    // the next restart, missing events never do.
    if (deps.supplies) {
      try {
        await supplyTick(db, {
          serverId: s.id,
          client: deps.supplies.clientFor(s.nitradoServiceId!),
          offsets: deps.supplies.offsets,
          remoteDir: deps.supplies.remoteDir,
          fileName: deps.supplies.fileName,
          now: new Date(),
        });
      } catch (err) {
        deps.onSupplyError?.(s.id, err);
      }
    }
```

In `apps/ingest-worker/src/main.ts`, load the template once at startup and pass it in. Loading it per tick would re-read and re-parse the file 1,440 times a day for a file that cannot change without a redeploy:

```ts
import { readFileSync } from "node:fs";
import { loadTemplate } from "./supplies.js";

// Parsed ONCE at startup. A malformed template must stop the worker here,
// loudly, rather than throwing on every sweep forever.
const offsets = loadTemplate(JSON.parse(
  readFileSync(new URL("../assets/flag-supplies.template.json", import.meta.url), "utf8"),
));
```

and add to the `ingestSweep` call:

```ts
      supplies: {
        clientFor,
        offsets,
        remoteDir: cfg.missionCustomDir,
        fileName: "faction-supplies.json",
      },
      onSupplyError: (serverId, err) => console.error(`supply tick failed for server ${serverId}`, err),
```

`clientFor` already returns a `NitradoClient`, which now has `uploadFile`, so it satisfies `SupplyUploader` structurally.

- [ ] **Step 4: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/ingest-worker test
git add apps/ingest-worker
git commit -m "feat(worker): run the supply projection each sweep"
```

---

### Task 6: Tell the player when supplies arrive

**Files:**
- Modify: `apps/bot/src/faction-commands.ts`
- Test: `apps/bot/test/faction-commands.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: nothing

- [ ] **Step 1: Write the failing test**

Add to `apps/bot/test/faction-commands.test.ts`, in the block covering `handleClaimConfirm`:

```ts
  it("tells the claimant their supplies arrive after the next restart", async () => {
    // Without this they walk to their pole, find nothing, and report a bug.
    const r = await handleClaimConfirm(deps, ctx);
    expect(r.content).toMatch(/supplies/i);
    expect(r.content).toMatch(/restart/i);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test faction-commands`
Expected: FAIL — no mention of supplies.

- [ ] **Step 3: Implement**

In `handleClaimConfirm`'s success reply, append a sentence naming both facts — that a supply kit spawns at their pole, and that it appears after the next server restart. Keep the existing reply's wording and tone; add to it rather than rewriting it.

Do NOT promise a time. The worker uploads within one sweep, but the objects appear only when the server next restarts, which we do not control.

- [ ] **Step 4: Run and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test
git add apps/bot
git commit -m "feat(bot): say when a claimed faction's supplies will appear"
```

---

### Task 7: Live acceptance

**Files:**
- Create: `docs/acceptance/2026-09-01-faction-supplies.md`
- Modify: `docs/deploy/2026-09-01-targeted-linking.md` (add the supplies deploy steps) or create `docs/deploy/2026-09-01-faction-supplies.md`

- [ ] **Step 1: Full suite**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm -F @factions/bot test && TEST_DATABASE_URL=... pnpm -F @factions/db test && TEST_DATABASE_URL=... pnpm -F @factions/ingest-worker test && TEST_DATABASE_URL=... pnpm -F @factions/nitrado test`
Record the totals.

- [ ] **Step 2: Migrate `factions_live` and set the config**

⚠️ **STOP the worker, migrate, then START it** — the same downtime rule as `docs/deploy/2026-09-01-targeted-linking.md`. New code selecting `supply_uploads` before the migration throws; old code with the new schema is harmless but pointless.

Set `MISSION_CUSTOM_DIR` in `.env` to the server's mission `custom` directory. Determine it from a `file_server/list` call rather than guessing — record the exact value used.

- [ ] **Step 3: Confirm the generated file before it reaches the server**

Before starting the worker, generate the file locally for the live faction and check it by eye: 72 objects, `customString` "COK" throughout, one `Flag_Rooster`, no `Flag_White`, no `TerritoryFlag`, and coordinates within a few metres of `5551.69 / 311.63 / 8790.97`. Record the first object verbatim in the acceptance doc.

- [ ] **Step 4: Add the spawner file to `cfggameplay.json` (manual, human)**

Add `"./custom/faction-supplies.json"` to `WorldsData.objectSpawnersArr`, beside the existing `"./custom/teleports.json"`. This is a hand edit by the human operator; the bot never writes this file.

- [ ] **Step 5: Restart the server and observe**

After the next server restart, go to the pole and record: whether the kit is present, whether the flag is a rooster, whether anything floats or is sunk into the ground (§6 of the spec), and the approximate footprint. Record what was NOT exercised — for instance the disband path, if no faction disbanded.

- [ ] **Step 6: Commit**

```bash
git add docs/acceptance/2026-09-01-faction-supplies.md docs/deploy
git commit -m "docs(acceptance): faction supplies staged end to end"
```

---

## Self-Review

**Spec coverage:** §3 template and anchor → Task 1. §4.1 pure generation → Task 1. §4.2 `customString` → Task 1. §4.3 `HOLDING` shared → Task 1. §4.4 hash state → Task 3. §5 two-step upload and the 200-with-error hazard → Task 2. §2.1 projection and retry → Task 4. §6 sweep isolation → Task 5. §2.2 claim-time expectation → Task 6. §7 acceptance → Task 7. §2.3, §2.4 and the §6 terrain note are decisions with no code, asserted by Task 1's ypr/persistency test and recorded in Task 7's observations.

**Type consistency:** `SpawnObject`, `SupplyFaction`, `loadTemplate`, `generateSupplies` (Task 1) are consumed under those exact names in Tasks 4 and 5. `uploadFile(remoteDir, fileName, content)` (Task 2) matches `SupplyUploader` (Task 4) and the `clientFor` wiring (Task 5). `supplyUploads.serverId/contentHash/uploadedAt` (Task 3) match Task 4's insert.

**Known ordering constraint:** Task 5 imports `supplyTick` from Task 4 and `SpawnObject` from Task 1, and Task 4 imports `supplyUploads` from Task 3 — so Tasks 1→3→4→5 are strictly ordered. Task 2 is independent of 3 and 4 but must precede 5, whose `main.ts` wiring relies on `NitradoClient` satisfying `SupplyUploader`. Task 6 is independent of all of them.
