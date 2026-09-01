# Live Ingest via Nitrado Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ADM events reach the database continuously, pulled from the Nitrado API on a timer, instead of only when someone runs a one-shot script by hand.

**Architecture:** A new `@factions/nitrado` package lists and downloads ADM files. The ingest worker becomes long-running: a loop drives a sweep over active servers, each server's tick backfills old files under a budget and then advances the live file, and file processing resumes from the per-file line cursor that already exists in the schema but is never read.

**Tech Stack:** TypeScript, pnpm workspaces, Drizzle ORM on Postgres 16, tsx, vitest, Docker Compose.

**Spec:** `docs/superpowers/specs/2026-08-31-live-ingest-design.md`

## Global Constraints

- **Postgres on host port 5434.** Ports 5432 and 5433 belong to other projects on this machine — never stop, remove, or repoint their containers. DB suites need `TEST_DATABASE_URL=postgres://factions:factions@localhost:5434/factions`.
- **Start the database first:** `docker compose up -d postgres`. Docker Desktop must be running.
- **Full suite:** `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm run ci`. Baseline at plan start: **18 turbo tasks, 378 tests, 0 skipped**. If turbo reports everything cached, force a real run (`npx turbo run typecheck test --concurrency=1 --force`) — a cached pass proves nothing. Check the count, not just the exit code.
- **`INGEST_INTERVAL_SECONDS` default 60. `ADM_BACKFILL_BUDGET` default 15.**
- **Never write a clock offset of 0 by default.** `servers.clock_offset_ms` is `NOT NULL` with no default, deliberately: a wrong offset is invisible to every count-based check in this system.
- **Migrations are generated, never hand-written:** `cd packages/db && pnpm generate`, then read the emitted SQL before committing.
- **Config is hand-rolled, logging is `console.*`.** Do not add zod or pino; `apps/bot/src/config.ts` is this repo's config idiom.
- **Commit after every task.** Co-author trailer as in recent history.

---

### The one rule that fails silently

`TimelineCursor` is stateful. It is seeded with a file's `bootAt` and advanced line by line, rolling the date forward when it sees the clock jump backwards by more than 12 hours — that is how a file spanning midnight gets correct timestamps.

**Resume WRITES at the stored cursor. Advance the TimelineCursor from line 0 regardless.**

Construct a fresh cursor at the resume point and every rollover crossed before it is lost, so every timestamp from there on is hours wrong — with every row still landing and every count-based check still green. Parsing is in-memory string work and cheap; database writes are what the cursor gates.

### A guard one-life needs and this repo does not

One-life pops a trailing empty line before counting, because a file ending in a newline yields a phantom final element. **Do not port that.** `readAdmFile` here already filters every blank line (`.filter((l) => l.trim().length > 0)`), so no empty element exists to pop, and `lineIndex` is an ordinal over non-blank lines. That indexing is already persisted in `raw_lines` and counted by `adm_files.lines_ingested`; changing it would invalidate every row written since Plan 1.

---

### Task 1: `@factions/nitrado`

**Files:**
- Create: `packages/nitrado/package.json`, `packages/nitrado/tsconfig.json`, `packages/nitrado/vitest.config.ts`, `packages/nitrado/src/index.ts`, `packages/nitrado/src/client.ts`
- Test: `packages/nitrado/test/client.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type AdmFileRef = { path: string; name: string; localTimestampMs: number | null; modifiedAtMs: number };
  export class NitradoClient {
    constructor(token: string, serviceId: number, fetchFn?: typeof fetch)
    listAdmFiles(): Promise<AdmFileRef[]>
    downloadFile(filePath: string): Promise<string>
  }
  ```

Ported from one-life's client, taking only what ingest needs. Its ban-list and restart methods serve one-life's enforcer and rebooter; nothing here has either.

- [ ] **Step 1: Create the package manifest**

```json
// packages/nitrado/package.json
{
  "name": "@factions/nitrado",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0"
  }
}
```

```json
// packages/nitrado/tsconfig.json
{ "extends": "../../tsconfig.base.json", "include": ["src", "test"] }
```

```ts
// packages/nitrado/vitest.config.ts
import { defineConfig } from "vitest/config";
export default defineConfig({});
```

```ts
// packages/nitrado/src/index.ts
export * from "./client.js";
```

Then run `pnpm install` from the repo root so the workspace link exists. `pnpm-workspace.yaml` already globs `packages/*`; do not edit it.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/nitrado/test/client.test.ts
import { describe, it, expect, vi } from "vitest";
import { NitradoClient } from "../src/client.js";

const GS = { data: { gameserver: { game_specific: { path: "/games/ni1234/noftp/dayzxb/" } } } };

/** Serves canned JSON by URL substring, so a test states only what it cares about. */
function fakeFetch(routes: Record<string, unknown>, text?: string) {
  return vi.fn(async (url: string) => {
    if (text !== undefined && url.startsWith("https://dl.nitrado")) {
      return { ok: true, text: async () => text } as unknown as Response;
    }
    for (const [frag, body] of Object.entries(routes)) {
      if (url.includes(frag)) return { ok: true, json: async () => body } as unknown as Response;
    }
    return { ok: false, status: 404 } as unknown as Response;
  });
}

const listing = (entries: unknown[]) => ({ data: { entries } });

describe("NitradoClient.listAdmFiles", () => {
  it("returns ADM files oldest-first by their filename timestamp", async () => {
    // Nitrado's listing order is not guaranteed. Ordering is load-bearing:
    // the tick backfills oldest-first, and a file's timestamps depend on
    // every file before it.
    const fetchFn = fakeFetch({
      "/gameservers/settings": {},
      "/file_server/list": listing([
        { name: "DayZServer_X1_x64_2026-07-23_01-00-00.ADM", path: "/b.ADM", modified_at: 200 },
        { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM", modified_at: 100 },
      ]),
      "/gameservers": GS,
    });
    const files = await new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).listAdmFiles();
    expect(files.map((f) => f.path)).toEqual(["/a.ADM", "/b.ADM"]);
  });

  it("ignores entries that are not ADM files", async () => {
    const fetchFn = fakeFetch({
      "/file_server/list": listing([
        { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM", modified_at: 100 },
        { name: "server.cfg", path: "/server.cfg", modified_at: 100 },
      ]),
      "/gameservers": GS,
    });
    const files = await new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).listAdmFiles();
    expect(files).toHaveLength(1);
  });

  it("reports a missing modified_at as 0 rather than dropping the file", async () => {
    // ⚠️ The 0 matters downstream: the clock-offset derivation must EXCLUDE
    // these, because a 0 would win its minimum and shift every timestamp by
    // decades. The client's job is to report the absence faithfully.
    const fetchFn = fakeFetch({
      "/file_server/list": listing([
        { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM" },
      ]),
      "/gameservers": GS,
    });
    const [f] = await new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).listAdmFiles();
    expect(f?.modifiedAtMs).toBe(0);
  });

  it("reports an unparseable filename as a null local timestamp", async () => {
    const fetchFn = fakeFetch({
      "/file_server/list": listing([{ name: "weird.ADM", path: "/w.ADM", modified_at: 100 }]),
      "/gameservers": GS,
    });
    const [f] = await new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).listAdmFiles();
    expect(f?.localTimestampMs).toBeNull();
  });

  it("throws when the gameserver path cannot be resolved", async () => {
    const fetchFn = fakeFetch({ "/gameservers": { data: {} } });
    await expect(new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).listAdmFiles())
      .rejects.toThrow(/could not resolve gameserver path/);
  });

  it("throws on a non-ok response", async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 401 } as unknown as Response));
    await expect(new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).listAdmFiles())
      .rejects.toThrow(/401/);
  });
});

describe("NitradoClient.downloadFile", () => {
  it("follows the token url the API returns", async () => {
    // The download endpoint returns a URL, not the bytes. A client that
    // returned the JSON body would silently ingest an API envelope as if it
    // were log lines.
    const fetchFn = fakeFetch(
      { "/file_server/download": { data: { token: { url: "https://dl.nitrado.net/x" } } } },
      "AdminLog started on 2026-07-22 at 07:01:37",
    );
    const text = await new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).downloadFile("/a.ADM");
    expect(text).toContain("AdminLog started on");
  });

  it("throws when no download url is returned", async () => {
    const fetchFn = fakeFetch({ "/file_server/download": { data: {} } });
    await expect(new NitradoClient("t", 1, fetchFn as unknown as typeof fetch).downloadFile("/a.ADM"))
      .rejects.toThrow(/no download url/);
  });
});
```

- [ ] **Step 3: Run them to make sure they fail**

Run: `pnpm --filter @factions/nitrado test`
Expected: FAIL — cannot resolve `../src/client.js`.

- [ ] **Step 4: Write the implementation**

```ts
// packages/nitrado/src/client.ts

/** One ADM file as Nitrado describes it. */
export type AdmFileRef = {
  path: string;
  name: string;
  /** Parsed from the filename, which carries SERVER-LOCAL time. Null when unparseable. */
  localTimestampMs: number | null;
  /** Nitrado's own mtime, in UTC ms. 0 when the API omitted it — see the derivation guard. */
  modifiedAtMs: number;
};

const API_BASE = "https://api.nitrado.net";
const FILENAME_RE = /DayZServer_X1_x64_(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})\.ADM$/u;

/**
 * Reads ADM files from a Nitrado game server.
 *
 * `fetchFn` is injected rather than calling global fetch, so tests exercise
 * every branch — including the two-step download — with no network.
 */
export class NitradoClient {
  constructor(
    private readonly token: string,
    private readonly serviceId: number,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  private async getJson(path: string): Promise<Record<string, any>> {
    const res = await this.fetchFn(`${API_BASE}${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`Nitrado ${res.status} for ${path}`);
    return res.json() as Promise<Record<string, any>>;
  }

  /** Filename time is SERVER-LOCAL; treated as UTC here purely as a comparable number. */
  private parseFilenameTs(name: string): number | null {
    const m = FILENAME_RE.exec(name);
    if (!m) return null;
    return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  }

  async listAdmFiles(): Promise<AdmFileRef[]> {
    const gs = await this.getJson(`/services/${this.serviceId}/gameservers`);
    const base = gs?.data?.gameserver?.game_specific?.path;
    if (!base) throw new Error("Nitrado: could not resolve gameserver path");

    const listing = await this.getJson(
      `/services/${this.serviceId}/gameservers/file_server/list?dir=${encodeURIComponent(base + "config")}`,
    );
    const entries: any[] = listing?.data?.entries ?? [];
    const files: AdmFileRef[] = entries
      .filter((e) => typeof e.name === "string" && e.name.endsWith(".ADM") && e.path)
      .map((e) => ({
        path: e.path as string,
        name: e.name as string,
        localTimestampMs: this.parseFilenameTs(e.name),
        // ⚠️ Faithfully report a missing mtime as 0. The derivation EXCLUDES
        // zeros; silently substituting "now" here would corrupt the offset.
        modifiedAtMs: (e.modified_at ?? 0) * 1000,
      }));

    // Oldest-first. Ordering is load-bearing: the tick backfills in this order
    // and a file's timestamps depend on every file before it.
    files.sort((a, b) => (a.localTimestampMs ?? 0) - (b.localTimestampMs ?? 0));
    return files;
  }

  /** Two steps: the API returns a signed URL, then the bytes come from there. */
  async downloadFile(filePath: string): Promise<string> {
    const dl = await this.getJson(
      `/services/${this.serviceId}/gameservers/file_server/download?file=${encodeURIComponent(filePath)}`,
    );
    const url = dl?.data?.token?.url;
    if (!url) throw new Error("Nitrado: no download url returned");
    const res = await this.fetchFn(url);
    if (!res.ok) throw new Error(`Nitrado download ${res.status}`);
    return res.text();
  }
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `pnpm --filter @factions/nitrado test && pnpm --filter @factions/nitrado typecheck`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/nitrado pnpm-lock.yaml
git commit -m "feat(nitrado): list and download ADM files from the Nitrado API"
```

---

### Task 2: Schema — service id, active flag, file path

**Files:**
- Modify: `packages/db/src/schema.ts` (the `servers` and `admFiles` tables)
- Create: `packages/db/migrations/0010_*.sql` (generated)
- Test: `packages/db/test/live-ingest-schema.test.ts`

**Interfaces:**
- Produces: `servers.nitradoServiceId`, `servers.active`, `admFiles.path`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/db/test/live-ingest-schema.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, type Database } from "../src/index.js";
import { sql, eq } from "drizzle-orm";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-08-31T12:00:00Z");

describe("live ingest schema", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table adm_files, servers restart identity cascade`);
  });

  const server = (o: Record<string, unknown> = {}) => db.insert(servers).values({
    name: "S", map: "sakhal", clockOffsetMs: 25_200_000, nitradoServiceId: 1234, ...o,
  }).returning();

  it("stores a Nitrado service id", async () => {
    const [s] = await server();
    expect(s?.nitradoServiceId).toBe(1234);
  });

  it("defaults a server to active", async () => {
    // The sweep runs over active servers. A newly registered server should
    // start ingesting without a second call to turn it on.
    const [s] = await server();
    expect(s?.active).toBe(true);
  });

  it("lets a server be deactivated", async () => {
    const [s] = await server();
    await db.update(servers).set({ active: false }).where(eq(servers.id, s!.id));
    const [after] = await db.select().from(servers).where(eq(servers.id, s!.id));
    expect(after?.active).toBe(false);
  });

  it("stores the Nitrado download path alongside the filename", async () => {
    // filename stays the identity — its unique index is (server_id, filename) —
    // and path is only how the bytes are fetched.
    const [s] = await server();
    const [f] = await db.insert(admFiles).values({
      serverId: s!.id, filename: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM",
      path: "/games/ni1234/noftp/dayzxb/config/DayZServer_X1_x64_2026-07-22_01-00-00.ADM",
      bootAt: now,
    }).returning();
    expect(f?.path).toContain("/config/");
    expect(f?.linesIngested).toBe(0);
    expect(f?.complete).toBe(false);
  });

  it("still refuses two files with one filename on one server", async () => {
    const [s] = await server();
    const row = { serverId: s!.id, filename: "a.ADM", path: "/a.ADM", bootAt: now };
    await db.insert(admFiles).values(row);
    await expect(db.insert(admFiles).values(row)).rejects.toThrow(/adm_files_server_filename_uniq/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `docker compose up -d postgres && export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/db test live-ingest-schema`
Expected: FAIL — `nitradoServiceId` is not a known column.

- [ ] **Step 3: Add the columns**

In `packages/db/src/schema.ts`, add to `servers` (after `clockOffsetMs`):

```ts
  /** Nitrado service this server's ADM files are fetched from. */
  nitradoServiceId: integer("nitrado_service_id").notNull(),
  /**
   * Whether the ingest sweep should pull this server.
   *
   * The database is the source of truth for which servers are swept, so a
   * server is retired by clearing this rather than by deleting rows or
   * editing worker config. Defaults true: registering a server should start
   * ingesting it, not require a second step.
   */
  active: boolean("active").notNull().default(true),
```

And add to `admFiles` (after `filename`):

```ts
  /**
   * Nitrado's download path for this file.
   *
   * `filename` remains the identity — the unique index is
   * (server_id, filename) and every row written since Plan 1 uses it. `path`
   * is only how the bytes are fetched.
   */
  path: text("path"),
```

> Note: `path` is nullable. Rows written by the historical replay have no Nitrado path, and backfilling one for them would be inventing data.

- [ ] **Step 4: Generate and apply the migration**

```bash
cd packages/db && pnpm generate
```

Read the emitted `migrations/0010_*.sql`. It must be `ALTER TABLE ... ADD COLUMN` only. `nitrado_service_id` is `NOT NULL` on a table that may already hold rows — if the emitted SQL would fail on existing data, add the column with a `DEFAULT` in the generated SQL is NOT the fix; instead check whether `servers` is empty in your test database, and if the production/backfill database has rows, note it in your report as a migration-ordering concern rather than guessing.

- [ ] **Step 5: Run the test**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/db test`
Expected: PASS, 5 new tests.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema.ts packages/db/migrations packages/db/test/live-ingest-schema.test.ts
git commit -m "feat(db): Nitrado service id, active flag, and ADM file path"
```

---

### Task 3: Parse ADM content from a string

**Files:**
- Create: `apps/ingest-worker/src/parse-adm-content.ts`
- Modify: `apps/ingest-worker/src/read-adm-file.ts`
- Test: `apps/ingest-worker/test/parse-adm-content.test.ts`

**Interfaces:**
- Produces: `parseAdmContent(text: string): { bootAt: Date; lines: string[] }` — throws when no boot header is present.
- `readAdmFile(path)` keeps its exact current signature and delegates.

Nitrado hands us a string, not a path. This splits the disk concern from the parsing concern so both callers share one implementation.

- [ ] **Step 1: Write the failing test**

```ts
// apps/ingest-worker/test/parse-adm-content.test.ts
import { describe, it, expect } from "vitest";
import { parseAdmContent } from "../src/parse-adm-content.js";

const HEADER = "AdminLog started on 2026-07-22 at 07:01:37";

describe("parseAdmContent", () => {
  it("reads the boot instant from the header", () => {
    const { bootAt } = parseAdmContent(`${HEADER}\n07:52:16 | something`);
    expect(bootAt.toISOString()).toBe("2026-07-22T07:01:37.000Z");
  });

  it("drops blank lines so lineIndex is an ordinal over real lines", () => {
    // ⚠️ This indexing is already persisted: raw_lines rows and
    // adm_files.lines_ingested from Plan 1 onward all count non-blank lines.
    // Changing it would invalidate every row written so far.
    const { lines } = parseAdmContent(`${HEADER}\n\n07:52:16 | a\n   \n07:52:17 | b\n`);
    expect(lines).toEqual([HEADER, "07:52:16 | a", "07:52:17 | b"]);
  });

  it("handles CRLF line endings", () => {
    const { lines } = parseAdmContent(`${HEADER}\r\n07:52:16 | a\r\n`);
    expect(lines).toEqual([HEADER, "07:52:16 | a"]);
  });

  it("needs no trailing-empty-line guard, because blanks are already gone", () => {
    // one-life pops one phantom trailing element before counting. Here the
    // filter removes every blank, so a file ending in a newline yields the
    // same count as one that does not — and the persisted cursor stays
    // aligned as the live file grows.
    const withNewline = parseAdmContent(`${HEADER}\n07:52:16 | a\n`);
    const without = parseAdmContent(`${HEADER}\n07:52:16 | a`);
    expect(withNewline.lines.length).toBe(without.lines.length);
  });

  it("rejects content with no boot header", () => {
    // Without it no line can be given an absolute timestamp, so the file is
    // unusable rather than partially usable.
    expect(() => parseAdmContent("07:52:16 | orphan line")).toThrow(/AdminLog started on/);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @factions/ingest-worker test parse-adm-content`
Expected: FAIL — cannot resolve `../src/parse-adm-content.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/ingest-worker/src/parse-adm-content.ts
import { parseBootHeader } from "@factions/adm-parser";

/**
 * Split one ADM file's text into its boot instant and its non-blank lines.
 *
 * ⚠️ Blank lines are dropped, so `lines[i]` is the i-th NON-BLANK line. That
 * ordinal is what `raw_lines.line_index` and `adm_files.lines_ingested` have
 * meant since Plan 1; do not switch to raw file offsets.
 *
 * The boot header names the file's start instant. Without it no line can be
 * given an absolute timestamp, so the file is rejected rather than partially
 * ingested.
 */
export function parseAdmContent(text: string): { bootAt: Date; lines: string[] } {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  for (const line of lines) {
    const boot = parseBootHeader(line);
    if (boot) return { bootAt: boot, lines };
  }
  throw new Error('No "AdminLog started on" header found');
}
```

- [ ] **Step 4: Delegate from `readAdmFile`**

Replace the body of `apps/ingest-worker/src/read-adm-file.ts`:

```ts
import { readFile } from "node:fs/promises";
import { parseAdmContent } from "./parse-adm-content.js";

/**
 * Reads one .ADM file from disk. Parsing lives in `parseAdmContent` so the
 * Nitrado path, which already holds the text, shares one implementation.
 */
export async function readAdmFile(path: string): Promise<{ bootAt: Date; lines: string[] }> {
  try {
    return parseAdmContent(await readFile(path, "utf8"));
  } catch (err) {
    // Keep the filename in the message; a bare "no header" is useless when
    // replaying a directory of 1,026 files.
    throw new Error(`${(err as Error).message} in ${path}`);
  }
}
```

- [ ] **Step 5: Run the tests and typecheck**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/ingest-worker test && pnpm --filter @factions/ingest-worker typecheck`
Expected: PASS. The existing `replay-export` and `ingest` suites must still pass unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/ingest-worker/src/parse-adm-content.ts apps/ingest-worker/src/read-adm-file.ts apps/ingest-worker/test/parse-adm-content.test.ts
git commit -m "refactor(ingest): split ADM parsing from disk reading"
```

---

### Task 4: Resumable `ingestFile`

**Files:**
- Modify: `apps/ingest-worker/src/ingest.ts`
- Test: `apps/ingest-worker/test/ingest.test.ts` (extend)

**Interfaces:**
- Consumes: `parseAdmContent` (Task 3).
- Produces: `IngestOptions` gains `path?: string | null` and `markComplete: boolean`; `IngestResult` gains `linesIngested: number` (the new cursor).

This is the task the whole plan exists for. Everything else is transport.

- [ ] **Step 1: Write the failing tests**

Append to `apps/ingest-worker/test/ingest.test.ts`. It already defines `LINES`, `ID`, `db`, and `serverId` in a `beforeEach`; reuse them.

```ts
  describe("resuming", () => {
    const ingest = (lines: string[], markComplete = false) => ingestFile(db, {
      serverId, filename: "resume.ADM", bootAt: new Date("2026-07-22T07:01:37Z"),
      lines, clockOffsetMs: 0, markComplete,
    });

    it("returns the line count as the new cursor", async () => {
      const r = await ingest(LINES);
      expect(r.linesIngested).toBe(LINES.length);
    });

    it("writes nothing twice when the same lines are ingested again", async () => {
      // The defect this task fixes: the old implementation re-inserted every
      // line of every file on every run and leaned on ON CONFLICT to discard
      // them. At a 60-second cadence that is the whole file, every minute.
      await ingest(LINES);
      const before = (await db.select().from(rawLines)).length;
      const second = await ingest(LINES);
      expect(second.linesCaptured).toBe(0);
      expect((await db.select().from(rawLines)).length).toBe(before);
    });

    it("ingests only the lines a growing file has gained", async () => {
      await ingest(LINES);
      const grown = [...LINES, `15:00:00 | Player "YrJustBad" (id=${ID}) has been disconnected`];
      const r = await ingest(grown);
      expect(r.linesCaptured).toBe(1);
      expect(r.linesIngested).toBe(grown.length);
    });

    it("does not reprocess a file that shrank or rotated", async () => {
      // The cursor is past the end. Reprocessing would rewrite line 0 of a
      // different file's content under the same adm_files row.
      await ingest(LINES);
      const r = await ingest(LINES.slice(0, 2));
      expect(r.linesCaptured).toBe(0);
    });

    it("keeps timestamps correct across midnight when resuming mid-file", async () => {
      // ⚠️ THE test. TimelineCursor is stateful: it rolls the date forward on
      // a backwards clock jump. Resuming with a FRESH cursor at the resume
      // point loses that rollover, and every later timestamp is a day early —
      // silently, with every row still landing and every count still green.
      const beforeMidnight = [
        "AdminLog started on 2026-07-22 at 22:00:00",
        `22:30:00 | Player "A" (id=${ID}) is connected`,
      ];
      const afterMidnight = [
        ...beforeMidnight,
        `00:30:00 | Player "A" (id=${ID}) is connected`,
      ];
      await ingestFile(db, {
        serverId, filename: "midnight.ADM", bootAt: new Date("2026-07-22T22:00:00Z"),
        lines: beforeMidnight, clockOffsetMs: 0, markComplete: false,
      });
      await ingestFile(db, {
        serverId, filename: "midnight.ADM", bootAt: new Date("2026-07-22T22:00:00Z"),
        lines: afterMidnight, clockOffsetMs: 0, markComplete: false,
      });
      const rows = await db.select().from(events).orderBy(events.id);
      const last = rows[rows.length - 1]!;
      // The 00:30 line belongs to the 23rd, not the 22nd.
      expect(last.occurredAt.toISOString()).toBe("2026-07-23T00:30:00.000Z");
    });

    it("marks a file complete only when told to", async () => {
      // The live file is still being written; marking it complete would make
      // the next tick skip the lines it is about to gain.
      await ingest(LINES, false);
      const [live] = await db.select().from(admFiles);
      expect(live?.complete).toBe(false);
      await ingest(LINES, true);
      const [done] = await db.select().from(admFiles);
      expect(done?.complete).toBe(true);
    });
  });
```

Add `admFiles` to the imports at the top of that test file.

- [ ] **Step 2: Run them to make sure they fail**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/ingest-worker test ingest`
Expected: FAIL — `markComplete` is not in `IngestOptions`, and `linesIngested` is not on the result.

- [ ] **Step 3: Write the implementation**

In `apps/ingest-worker/src/ingest.ts`, extend the options and result:

```ts
export type IngestOptions = {
  serverId: number;
  filename: string;
  /** Nitrado download path, when the bytes came from Nitrado. */
  path?: string | null;
  bootAt: Date;
  lines: string[];
  clockOffsetMs: number;
  /**
   * Whether this file is finished. FALSE for the newest file, which the
   * server is still writing — marking it complete would make the next tick
   * skip the lines it is about to gain.
   */
  markComplete: boolean;
};
```

Add `linesIngested: number` to `IngestResult` with a comment naming it the resume cursor.

Then replace the body's file-row handling and loop:

```ts
export async function ingestFile(db: Database, opts: IngestOptions): Promise<IngestResult> {
  const [file] = await db.insert(admFiles)
    .values({ serverId: opts.serverId, filename: opts.filename, path: opts.path ?? null, bootAt: opts.bootAt })
    .onConflictDoNothing({ target: [admFiles.serverId, admFiles.filename] })
    .returning();

  const existing = file ?? (await db.select().from(admFiles).where(
    and(eq(admFiles.serverId, opts.serverId), eq(admFiles.filename, opts.filename)),
  ))[0]!;
  const admFileId = existing.id;

  const total = opts.lines.length;
  // Clamp: the file shrank or rotated. Never reprocess under this row's id.
  const from = Math.min(Math.max(existing.linesIngested, 0), total);

  const cursor = new TimelineCursor(opts.bootAt, opts.clockOffsetMs);
  let eventsAppended = 0;
  let linesCaptured = 0;
  let unparsedFlagLines = 0;

  for (let lineIndex = 0; lineIndex < total; lineIndex++) {
    const raw = opts.lines[lineIndex]!;

    // ⚠️ The cursor advances over EVERY line, including ones already written.
    // It is stateful — it rolls the date forward on a backwards clock jump —
    // so starting it at `from` would lose every midnight crossed before the
    // resume point and put every later timestamp a day early, silently.
    const occurredAt = cursor.advance(raw);

    // Writes, and only writes, resume at the cursor.
    if (lineIndex < from) continue;

    const [stored] = await db.insert(rawLines)
      .values({ admFileId, lineIndex, content: raw })
      .onConflictDoNothing({ target: [rawLines.admFileId, rawLines.lineIndex] })
      .returning();
    if (stored) linesCaptured++;

    if (!occurredAt) {
      if (FLAG_SHAPED_RE.test(raw)) unparsedFlagLines++;
      continue;
    }

    // ... the existing parseLine / eventTypeFor / appendEvent block, unchanged ...
  }

  await db.update(admFiles)
    .set({ linesIngested: total, complete: opts.markComplete, path: opts.path ?? existing.path })
    .where(eq(admFiles.id, admFileId));

  return { linesCaptured, eventsAppended, unparsedFlagLines, linesIngested: total };
}
```

Keep the existing event-appending block exactly as it is; only the surrounding loop, the resume guard, and the final update change.

- [ ] **Step 4: Update the two existing callers**

`apps/ingest-worker/src/main.ts` and `apps/ingest-worker/src/replay-export.ts` both call `ingestFile`. Add `markComplete: true` to each — both process whole files from disk that are not being appended to. Do not change anything else in them yet; `main.ts` is replaced in Task 7.

- [ ] **Step 5: Run the tests and typecheck**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/ingest-worker test && pnpm --filter @factions/ingest-worker typecheck`
Expected: PASS, 6 new tests, and every pre-existing ingest and replay test still green.

- [ ] **Step 6: Commit**

```bash
git add apps/ingest-worker/src/ingest.ts apps/ingest-worker/src/main.ts apps/ingest-worker/src/replay-export.ts apps/ingest-worker/test/ingest.test.ts
git commit -m "feat(ingest): resume from the per-file line cursor"
```

---

### Task 5: Clock offset derivation

**Files:**
- Create: `apps/ingest-worker/src/derive-clock-offset.ts`
- Test: `apps/ingest-worker/test/derive-clock-offset.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type OffsetCandidate = { localTimestampMs: number; modifiedAtMs: number };
  export function deriveClockOffsetMs(candidates: OffsetCandidate[]): number | null;
  ```
  Returns `null` when no candidate qualifies — the caller then keeps the stored offset.

- [ ] **Step 1: Write the failing test**

```ts
// apps/ingest-worker/test/derive-clock-offset.test.ts
import { describe, it, expect } from "vitest";
import { deriveClockOffsetMs } from "../src/derive-clock-offset.js";

const HOUR = 3_600_000;

describe("deriveClockOffsetMs", () => {
  it("takes the minimum candidate", () => {
    // Each file's mtime is at or AFTER its creation, so every candidate
    // over-estimates the offset by however long the file was written to.
    // The smallest is the tightest bound.
    expect(deriveClockOffsetMs([
      { localTimestampMs: 0, modifiedAtMs: 7 * HOUR },
      { localTimestampMs: 0, modifiedAtMs: 9 * HOUR },
    ])).toBe(7 * HOUR);
  });

  it("returns null for no candidates rather than zero", () => {
    // ⚠️ Zero is the silent failure this whole column guards against: every
    // row lands, every count-based check stays green, and only the instants
    // are hours wrong. The caller must fall back to the stored value.
    expect(deriveClockOffsetMs([])).toBeNull();
  });

  it("handles a single candidate", () => {
    expect(deriveClockOffsetMs([{ localTimestampMs: 1000, modifiedAtMs: 1000 + 4 * HOUR }])).toBe(4 * HOUR);
  });

  it("produces the measured Livonia offset from realistic inputs", () => {
    // The production table measured Livonia at UTC+7 against 69,326 rows.
    const local = Date.UTC(2026, 6, 22, 1, 0, 0);
    expect(deriveClockOffsetMs([{ localTimestampMs: local, modifiedAtMs: local + 7 * HOUR }])).toBe(7 * HOUR);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `pnpm --filter @factions/ingest-worker test derive-clock-offset`
Expected: FAIL — cannot resolve `../src/derive-clock-offset.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/ingest-worker/src/derive-clock-offset.ts

/** One file's filename time (server-local) against Nitrado's mtime (UTC). */
export type OffsetCandidate = { localTimestampMs: number; modifiedAtMs: number };

/**
 * Derive `clockOffsetMs` such that `UTC = server-local + offset`.
 *
 * Each file's mtime is at or after its creation instant, so every candidate
 * over-estimates by however long that file was still being written. The
 * MINIMUM is therefore the tightest available bound.
 *
 * ⚠️ Returns null, never 0, when nothing qualifies. A zero offset is invisible
 * to every count-based check in this system — every row lands, every
 * acceptance count matches, and only the absolute instants are hours wrong.
 * The caller must fall back to the stored offset instead.
 */
export function deriveClockOffsetMs(candidates: OffsetCandidate[]): number | null {
  if (candidates.length === 0) return null;
  let min = Infinity;
  for (const c of candidates) {
    const offset = c.modifiedAtMs - c.localTimestampMs;
    if (offset < min) min = offset;
  }
  return Number.isFinite(min) ? min : null;
}
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @factions/ingest-worker test derive-clock-offset`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add apps/ingest-worker/src/derive-clock-offset.ts apps/ingest-worker/test/derive-clock-offset.test.ts
git commit -m "feat(ingest): derive a server clock offset from Nitrado metadata"
```

---

### Task 6: The per-server tick

**Files:**
- Create: `apps/ingest-worker/src/tick.ts`
- Test: `apps/ingest-worker/test/tick.test.ts`

**Interfaces:**
- Consumes: `AdmFileRef` (Task 1), `parseAdmContent` (Task 3), `ingestFile` (Task 4), `deriveClockOffsetMs` (Task 5).
- Produces:
  ```ts
  export type NitradoLike = { listAdmFiles(): Promise<AdmFileRef[]>; downloadFile(path: string): Promise<string> };
  export type TickDeps = { serverId: number; client: NitradoLike; backfillBudget: number };
  export type TickResult = { filesProcessed: number; linesCaptured: number; eventsAppended: number; offsetMs: number };
  export function ingestTick(db: Database, deps: TickDeps): Promise<TickResult>;
  ```

`NitradoLike` is structural so tests need no HTTP.

- [ ] **Step 1: Write the failing test**

```ts
// apps/ingest-worker/test/tick.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, admFiles, events, type Database } from "@factions/db";
import { sql, eq } from "drizzle-orm";
import { ingestTick, type NitradoLike } from "../src/tick.js";

const URL = requireTestDatabaseUrl();
const ID = "D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1";
const HOUR = 3_600_000;

const body = (header: string, ...rest: string[]) => [`AdminLog started on ${header}`, ...rest].join("\n");
const FILE_A = body("2026-07-22 at 01:00:00", `01:30:00 | Player "A" (id=${ID}) is connected`);
const FILE_B = body("2026-07-23 at 01:00:00", `01:30:00 | Player "B" (id=${ID}) is connected`);

/** A fake Nitrado, so the tick is testable without HTTP. */
function fake(files: { name: string; path: string; localMs: number; modMs: number; text: string }[]): NitradoLike & { downloads: string[] } {
  const downloads: string[] = [];
  return {
    downloads,
    listAdmFiles: async () => files.map((f) => ({
      path: f.path, name: f.name, localTimestampMs: f.localMs, modifiedAtMs: f.modMs,
    })),
    downloadFile: async (path: string) => {
      downloads.push(path);
      const f = files.find((x) => x.path === path);
      if (!f) throw new Error(`no such file ${path}`);
      return f.text;
    },
  };
}

const day = (d: number) => Date.UTC(2026, 6, d, 1, 0, 0);

describe("ingestTick", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table events, raw_lines, adm_files, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({
      name: "S", map: "livonia", clockOffsetMs: 7 * HOUR, nitradoServiceId: 1234,
    }).returning();
    serverId = s!.id;
  });

  const twoFiles = () => fake([
    { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM", localMs: day(22), modMs: day(22) + 7 * HOUR, text: FILE_A },
    { name: "DayZServer_X1_x64_2026-07-23_01-00-00.ADM", path: "/b.ADM", localMs: day(23), modMs: day(23) + 7 * HOUR, text: FILE_B },
  ]);

  it("ingests every file and records the derived offset", async () => {
    const r = await ingestTick(db, { serverId, client: twoFiles(), backfillBudget: 15 });
    expect(r.filesProcessed).toBe(2);
    expect(r.offsetMs).toBe(7 * HOUR);
    const [s] = await db.select().from(servers).where(eq(servers.id, serverId));
    expect(s?.clockOffsetMs).toBe(7 * HOUR);
  });

  it("marks older files complete but never the newest", async () => {
    // The newest file is still being written. Marking it complete would make
    // the next tick skip every line it is about to gain.
    await ingestTick(db, { serverId, client: twoFiles(), backfillBudget: 15 });
    const rows = await db.select().from(admFiles).orderBy(admFiles.id);
    expect(rows.map((f) => f.complete)).toEqual([true, false]);
  });

  it("skips a completed older file on the next tick", async () => {
    const client = twoFiles();
    await ingestTick(db, { serverId, client, backfillBudget: 15 });
    client.downloads.length = 0;
    await ingestTick(db, { serverId, client, backfillBudget: 15 });
    // Only the live file is re-downloaded.
    expect(client.downloads).toEqual(["/b.ADM"]);
  });

  it("stops backfilling at the budget", async () => {
    const client = twoFiles();
    const r = await ingestTick(db, { serverId, client, backfillBudget: 0 });
    // No budget for the older file, so nothing is downloaded at all.
    expect(r.filesProcessed).toBe(0);
    expect(client.downloads).toEqual([]);
  });

  it("does not advance to the live file while an older file is pending", async () => {
    // ⚠️ Ordering is load-bearing: the live file's timestamps depend on every
    // file before it. Reaching it early would ingest it against an
    // incomplete history.
    const client = twoFiles();
    await ingestTick(db, { serverId, client, backfillBudget: 0 });
    expect(client.downloads).not.toContain("/b.ADM");
  });

  it("keeps the stored offset when no file carries usable metadata", async () => {
    // ⚠️ A zero here would silently shift every timestamp by hours while
    // every count-based check stayed green.
    const client = fake([
      { name: "weird.ADM", path: "/w.ADM", localMs: NaN, modMs: 0, text: FILE_A },
    ]);
    const r = await ingestTick(db, { serverId, client, backfillBudget: 15 });
    expect(r.offsetMs).toBe(7 * HOUR);
  });

  it("excludes a file whose mtime is missing from the derivation", async () => {
    const client = fake([
      { name: "DayZServer_X1_x64_2026-07-22_01-00-00.ADM", path: "/a.ADM", localMs: day(22), modMs: 0, text: FILE_A },
      { name: "DayZServer_X1_x64_2026-07-23_01-00-00.ADM", path: "/b.ADM", localMs: day(23), modMs: day(23) + 7 * HOUR, text: FILE_B },
    ]);
    const r = await ingestTick(db, { serverId, client, backfillBudget: 15 });
    expect(r.offsetMs).toBe(7 * HOUR);
  });

  it("continues past a file that fails to download", async () => {
    const client = twoFiles();
    const original = client.downloadFile.bind(client);
    client.downloadFile = async (p: string) => { if (p === "/a.ADM") throw new Error("boom"); return original(p); };
    const r = await ingestTick(db, { serverId, client, backfillBudget: 15 });
    // The failed older file leaves the tick incomplete, so the live file waits.
    expect(r.filesProcessed).toBe(0);
  });

  it("does nothing when the server has no files", async () => {
    const r = await ingestTick(db, { serverId, client: fake([]), backfillBudget: 15 });
    expect(r).toMatchObject({ filesProcessed: 0, eventsAppended: 0 });
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/ingest-worker test tick`
Expected: FAIL — cannot resolve `../src/tick.js`.

- [ ] **Step 3: Write the implementation**

```ts
// apps/ingest-worker/src/tick.ts
import type { Database } from "@factions/db";
import { admFiles, servers } from "@factions/db";
import type { AdmFileRef } from "@factions/nitrado";
import { and, eq } from "drizzle-orm";
import { parseAdmContent } from "./parse-adm-content.js";
import { ingestFile } from "./ingest.js";
import { deriveClockOffsetMs } from "./derive-clock-offset.js";

/** Structural, so the tick is testable without HTTP. */
export type NitradoLike = {
  listAdmFiles(): Promise<AdmFileRef[]>;
  downloadFile(path: string): Promise<string>;
};

export type TickDeps = { serverId: number; client: NitradoLike; backfillBudget: number };

export type TickResult = {
  filesProcessed: number;
  linesCaptured: number;
  eventsAppended: number;
  /** The offset in force for this tick, derived or retained. */
  offsetMs: number;
};

/** One ingestion pass for one server: backfill oldest-first under budget, then the live file. */
export async function ingestTick(db: Database, deps: TickDeps): Promise<TickResult> {
  const { serverId, client, backfillBudget } = deps;
  const [server] = await db.select().from(servers).where(eq(servers.id, serverId));
  if (!server) throw new Error(`ingestTick: no server ${serverId}`);

  const out: TickResult = { filesProcessed: 0, linesCaptured: 0, eventsAppended: 0, offsetMs: server.clockOffsetMs };

  const files = await client.listAdmFiles();
  if (files.length === 0) return out;

  // ⚠️ Exclude files with a non-positive mtime. Nitrado sometimes omits
  // modified_at and the client reports that faithfully as 0; since the
  // derivation takes the MINIMUM candidate, a 0 would win and shift every
  // timestamp by decades.
  const candidates = files
    .filter((f) => f.localTimestampMs != null && Number.isFinite(f.localTimestampMs) && f.modifiedAtMs > 0)
    .map((f) => ({ localTimestampMs: f.localTimestampMs as number, modifiedAtMs: f.modifiedAtMs }));

  const derived = deriveClockOffsetMs(candidates);
  if (derived !== null) {
    out.offsetMs = derived;
    // The ONLY column of `servers` this worker writes. Identity is declared
    // by scripts/register-server.ts; the offset is observed.
    await db.update(servers).set({ clockOffsetMs: derived }).where(eq(servers.id, serverId));
  }

  const newestPath = files[files.length - 1]!.path;
  let budget = backfillBudget;
  let allCaughtUp = true;

  for (const file of files) {
    const isNewest = file.path === newestPath;

    const [row] = await db.select().from(admFiles)
      .where(and(eq(admFiles.serverId, serverId), eq(admFiles.filename, file.name)));

    if (row?.complete && !isNewest) continue;

    if (!isNewest) {
      if (budget <= 0) { allCaughtUp = false; continue; }
      budget--;
    } else if (!allCaughtUp) {
      // ⚠️ Do not advance to the live file while older files are still
      // pending: its timestamps depend on the history before it.
      continue;
    }

    let text: string;
    try {
      text = await client.downloadFile(file.path);
    } catch (err) {
      console.error(`ingest: download failed for ${file.path}`, err);
      allCaughtUp = false;
      continue;
    }

    let parsed: { bootAt: Date; lines: string[] };
    try {
      parsed = parseAdmContent(text);
    } catch (err) {
      // A file with no boot header cannot be timestamped at all. Skip it
      // rather than throwing: one bad file must not stop the sweep.
      console.error(`ingest: unusable file ${file.path}`, err);
      allCaughtUp = false;
      continue;
    }

    const r = await ingestFile(db, {
      serverId,
      filename: file.name,
      path: file.path,
      bootAt: parsed.bootAt,
      lines: parsed.lines,
      clockOffsetMs: out.offsetMs,
      markComplete: !isNewest,
    });

    out.filesProcessed++;
    out.linesCaptured += r.linesCaptured;
    out.eventsAppended += r.eventsAppended;
    if (r.unparsedFlagLines > 0) {
      console.warn(`ingest: ${r.unparsedFlagLines} unparsed flag-shaped lines in ${file.name}`);
    }
  }

  return out;
}
```

- [ ] **Step 4: Run the tests and typecheck**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/ingest-worker test && pnpm --filter @factions/ingest-worker typecheck`
Expected: PASS, 9 new tests. Add `@factions/nitrado` to `apps/ingest-worker/package.json` dependencies and run `pnpm install` if the import does not resolve.

- [ ] **Step 5: Commit**

```bash
git add apps/ingest-worker/src/tick.ts apps/ingest-worker/test/tick.test.ts apps/ingest-worker/package.json pnpm-lock.yaml
git commit -m "feat(ingest): per-server tick with backfill budget and ordering"
```

---

### Task 7: Sweep, config, and the loop

**Files:**
- Create: `apps/ingest-worker/src/sweep.ts`, `apps/ingest-worker/src/config.ts`
- Modify: `apps/ingest-worker/src/main.ts` (replace)
- Test: `apps/ingest-worker/test/sweep.test.ts`, `apps/ingest-worker/test/config.test.ts`

**Interfaces:**
- Consumes: `ingestTick`, `NitradoLike` (Task 6).
- Produces:
  ```ts
  export type ClientFactory = (nitradoServiceId: number) => NitradoLike;
  export type SweepDeps = { clientFor: ClientFactory; backfillBudget: number; onServerError?: (serverId: number, err: unknown) => void };
  export function ingestSweep(db: Database, deps: SweepDeps): Promise<{ servers: number }>;
  export type WorkerConfig = { databaseUrl: string; nitradoToken: string; intervalSeconds: number; backfillBudget: number };
  export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/ingest-worker/test/config.test.ts
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

const OK = { DATABASE_URL: "postgres://x", NITRADO_TOKEN: "t" };

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
```

```ts
// apps/ingest-worker/test/sweep.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createClient, runMigrations, requireTestDatabaseUrl, servers, type Database } from "@factions/db";
import { sql } from "drizzle-orm";
import { ingestSweep } from "../src/sweep.js";
import type { NitradoLike } from "../src/tick.js";

const URL = requireTestDatabaseUrl();
const HOUR = 3_600_000;
const empty: NitradoLike = { listAdmFiles: async () => [], downloadFile: async () => "" };

describe("ingestSweep", () => {
  let db: Database;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table events, raw_lines, adm_files, servers restart identity cascade`);
  });

  const addServer = (o: Record<string, unknown> = {}) => db.insert(servers).values({
    name: `S${Math.random()}`, map: "livonia", clockOffsetMs: 7 * HOUR, nitradoServiceId: 1, ...o,
  }).returning();

  it("sweeps every active server", async () => {
    await addServer();
    await addServer();
    const r = await ingestSweep(db, { clientFor: () => empty, backfillBudget: 15 });
    expect(r.servers).toBe(2);
  });

  it("skips inactive servers", async () => {
    // The database decides which servers are swept, so retiring one is a
    // flag rather than a config edit or a row deletion.
    await addServer({ active: false });
    const r = await ingestSweep(db, { clientFor: () => empty, backfillBudget: 15 });
    expect(r.servers).toBe(0);
  });

  it("continues the sweep when one server fails", async () => {
    // ⚠️ One server's Nitrado outage must not stop every other server from
    // ingesting.
    const [bad] = await addServer();
    await addServer();
    const onServerError = vi.fn();
    const clientFor = (id: number): NitradoLike => id === 99
      ? { listAdmFiles: async () => { throw new Error("nitrado down"); }, downloadFile: async () => "" }
      : empty;
    await db.update(servers).set({ nitradoServiceId: 99 }).where(sql`id = ${bad!.id}`);
    const r = await ingestSweep(db, { clientFor, backfillBudget: 15, onServerError });
    expect(r.servers).toBe(2);
    expect(onServerError).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/ingest-worker test sweep config`
Expected: FAIL — neither module resolves.

- [ ] **Step 3: Write the config**

```ts
// apps/ingest-worker/src/config.ts

export type WorkerConfig = {
  databaseUrl: string;
  nitradoToken: string;
  intervalSeconds: number;
  backfillBudget: number;
};

function required(env: NodeJS.ProcessEnv, key: string): string {
  const v = env[key];
  if (!v) throw new Error(`${key} is required.`);
  return v;
}

/** Plain decimal digits only, with an optional minimum. */
const DECIMAL_RE = /^\d+$/u;

function intAtLeast(env: NodeJS.ProcessEnv, key: string, fallback: number, min: number): number {
  const raw = env[key];
  if (raw === undefined) return fallback;
  // ⚠️ Number() accepts "1e3", " 10 " and "0x10", so a typo'd interval would
  // run this loop at a cadence nobody configured while looking correct. Same
  // reasoning as apps/bot/src/config.ts.
  const n = DECIMAL_RE.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min) {
    throw new Error(`${key} must be an integer >= ${min} in plain decimal digits, got ${JSON.stringify(raw)}.`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv): WorkerConfig {
  return {
    databaseUrl: required(env, "DATABASE_URL"),
    nitradoToken: required(env, "NITRADO_TOKEN"),
    intervalSeconds: intAtLeast(env, "INGEST_INTERVAL_SECONDS", 60, 1),
    // Zero is meaningful: process only the live file this tick.
    backfillBudget: intAtLeast(env, "ADM_BACKFILL_BUDGET", 15, 0),
  };
}
```

- [ ] **Step 4: Write the sweep**

```ts
// apps/ingest-worker/src/sweep.ts
import type { Database } from "@factions/db";
import { servers } from "@factions/db";
import { eq } from "drizzle-orm";
import { ingestTick, type NitradoLike } from "./tick.js";

export type ClientFactory = (nitradoServiceId: number) => NitradoLike;

export type SweepDeps = {
  clientFor: ClientFactory;
  backfillBudget: number;
  /** Called when one server's tick throws; the sweep continues with the rest. */
  onServerError?: (serverId: number, err: unknown) => void;
};

/** One sweep across every active server. The database decides which those are. */
export async function ingestSweep(db: Database, deps: SweepDeps): Promise<{ servers: number }> {
  const active = await db.select().from(servers).where(eq(servers.active, true));
  for (const s of active) {
    // ⚠️ Per-server isolation. One server's Nitrado outage must not abort the
    // sweep and leave every other server un-ingested.
    try {
      await ingestTick(db, {
        serverId: s.id,
        client: deps.clientFor(s.nitradoServiceId),
        backfillBudget: deps.backfillBudget,
      });
    } catch (err) {
      deps.onServerError?.(s.id, err);
    }
  }
  return { servers: active.length };
}
```

- [ ] **Step 5: Replace `main.ts` with the loop**

```ts
// apps/ingest-worker/src/main.ts
import { createClient } from "@factions/db";
import { NitradoClient } from "@factions/nitrado";
import { loadConfig } from "./config.js";
import { ingestSweep } from "./sweep.js";
import type { NitradoLike } from "./tick.js";

const cfg = loadConfig(process.env);
const db = createClient(cfg.databaseUrl);

// One client per service id, cached for the process lifetime.
const clients = new Map<number, NitradoLike>();
const clientFor = (serviceId: number): NitradoLike => {
  let c = clients.get(serviceId);
  if (!c) {
    c = new NitradoClient(cfg.nitradoToken, serviceId);
    clients.set(serviceId, c);
  }
  return c;
};

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Sequential by construction: the next sweep starts only after this one
// returns, so no overlap guard is needed (unlike the bot, whose timer fires
// regardless of whether the previous run finished).
for (;;) {
  const started = Date.now();
  try {
    const r = await ingestSweep(db, {
      clientFor,
      backfillBudget: cfg.backfillBudget,
      onServerError: (serverId, err) => console.error(`ingest failed for server ${serverId}`, err),
    });
    console.log(`ingest sweep: ${r.servers} servers in ${Date.now() - started}ms`);
  } catch (err) {
    // A thrown sweep must not kill the loop and silently stop all ingest.
    console.error("ingest sweep failed", err);
  }
  await sleep(cfg.intervalSeconds * 1000);
}
```

> The old `main.ts` upserted the server row from `SERVER_NAME` / `MAP` / `CLOCK_OFFSET_MS`. That is gone deliberately: it cannot know the Nitrado service id, and re-running it would silently reactivate a server someone deactivated. Registration is Task 8.

- [ ] **Step 6: Run the tests and typecheck**

Run: `export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" && pnpm --filter @factions/ingest-worker test && pnpm --filter @factions/ingest-worker typecheck`
Expected: PASS, 8 new tests.

- [ ] **Step 7: Commit**

```bash
git add apps/ingest-worker/src/config.ts apps/ingest-worker/src/sweep.ts apps/ingest-worker/src/main.ts apps/ingest-worker/test/config.test.ts apps/ingest-worker/test/sweep.test.ts
git commit -m "feat(ingest): continuous sweep loop over active servers"
```

---

### Task 8: Server registration script

**Files:**
- Create: `scripts/register-server.ts`
- Modify: `scripts/backfill.md` (document the new step)

**Interfaces:** none — an operator entry point.

- [ ] **Step 1: Write the script**

```ts
// scripts/register-server.ts
import { createClient, servers } from "@factions/db";

/**
 * Register or update one server row.
 *
 * Deliberately separate from the worker: the row carries a credential-scoped
 * Nitrado service id and a clock offset the schema refuses to default, and
 * re-running the worker must never silently reactivate a server someone
 * deactivated.
 *
 * Usage:
 *   DATABASE_URL=... pnpm exec tsx scripts/register-server.ts \
 *     --name "Clan Wars Livonia" --map livonia --service-id 1234 --offset-ms 25200000
 */
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const databaseUrl = process.env.DATABASE_URL;
const name = arg("--name");
const map = arg("--map");
const serviceIdRaw = arg("--service-id");
const offsetRaw = arg("--offset-ms");
const active = arg("--active") !== "false";

if (!databaseUrl || !name || !map || !serviceIdRaw || !offsetRaw) {
  console.error(
    "Usage: DATABASE_URL=... tsx scripts/register-server.ts --name <name> --map <map> " +
    "--service-id <n> --offset-ms <n> [--active false]\n\n" +
    "--offset-ms is milliseconds to ADD to this server's local ADM time to get UTC.\n" +
    "Measured production values: chernarus 14400000 (+4h), livonia and sakhal 25200000 (+7h).\n" +
    "It has no default: a wrong offset stores every timestamp hours off while every\n" +
    "count-based check stays green.",
  );
  process.exit(1);
}

const nitradoServiceId = Number(serviceIdRaw);
const clockOffsetMs = Number(offsetRaw);
if (!Number.isSafeInteger(nitradoServiceId) || !Number.isSafeInteger(clockOffsetMs)) {
  console.error("--service-id and --offset-ms must both be integers.");
  process.exit(1);
}

const db = createClient(databaseUrl);
const [row] = await db.insert(servers)
  .values({ name, map, clockOffsetMs, nitradoServiceId, active })
  .onConflictDoUpdate({
    target: [servers.name, servers.map],
    set: { clockOffsetMs, nitradoServiceId, active },
  })
  .returning();

console.log(`server ${row!.id}: ${row!.name} (${row!.map}) service ${row!.nitradoServiceId}, active=${row!.active}`);
process.exit(0);
```

- [ ] **Step 2: Verify it against the test database**

```bash
export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
DATABASE_URL="$TEST_DATABASE_URL" pnpm exec tsx scripts/register-server.ts \
  --name "Test Livonia" --map livonia --service-id 1234 --offset-ms 25200000
```

Expected: prints the row. Run it a second time with `--offset-ms 25200001` and confirm it UPDATES rather than inserting a duplicate, then delete the row:

```bash
docker compose exec -T postgres psql -U factions -d factions -c "delete from servers where name = 'Test Livonia';"
```

- [ ] **Step 3: Document the step**

Add a short section to `scripts/backfill.md` covering: register the server first, then start the worker; what each flag means; and the measured offsets per map.

- [ ] **Step 4: Commit**

```bash
git add scripts/register-server.ts scripts/backfill.md
git commit -m "feat(scripts): register a server for live ingest"
```

---

### Task 9: Docker and Compose

**Files:**
- Create: `apps/ingest-worker/Dockerfile`
- Modify: `docker-compose.yml`

**Interfaces:** none — deployment artifacts.

- [ ] **Step 1: Write the Dockerfile**

```dockerfile
# apps/ingest-worker/Dockerfile
FROM node:20-alpine
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/ingest-worker ./apps/ingest-worker
RUN pnpm install --frozen-lockfile
WORKDIR /repo/apps/ingest-worker
CMD ["pnpm", "start"]
```

No build step: this repo runs TypeScript through `tsx`.

- [ ] **Step 2: Add the healthcheck and the service**

In `docker-compose.yml`, add to the `postgres` service:

```yaml
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U factions"]
      interval: 5s
      timeout: 5s
      retries: 5
```

> ⚠️ The healthcheck is not decoration. Without it `condition: service_healthy` has nothing to wait on and the worker races the database on every `compose up`.

Then add the service:

```yaml
  ingest-worker:
    build: { context: ., dockerfile: apps/ingest-worker/Dockerfile }
    restart: unless-stopped
    depends_on:
      postgres: { condition: service_healthy }
    environment:
      DATABASE_URL: postgres://factions:factions@postgres:5432/factions
      NITRADO_TOKEN: ${NITRADO_TOKEN}
      INGEST_INTERVAL_SECONDS: "60"
      ADM_BACKFILL_BUDGET: "15"
```

Note the in-network port is 5432; only the host mapping is 5434.

- [ ] **Step 3: Verify the image builds**

```bash
docker compose build ingest-worker
```

Expected: a successful build. Do NOT `compose up` the worker without a real `NITRADO_TOKEN` — it will loop on auth failures.

- [ ] **Step 4: Commit**

```bash
git add apps/ingest-worker/Dockerfile docker-compose.yml
git commit -m "feat(deploy): containerise the ingest worker"
```

---

### Task 10: Acceptance

**Files:**
- Create: `docs/acceptance/2026-08-31-live-ingest.md`

**Interfaces:** none — evidence.

**⚠️ Use the backfill database, not the test database.** The DB suites truncate `factions`.

- [ ] **Step 1: Replay the export through the refactored ingest**

Recreate `factions_backfill`, migrate it, and run `apps/ingest-worker/src/replay-main.ts` against it exactly as `docs/acceptance/2026-08-31-ceremony-detection.md` documents. The export is at `/Users/steveharmeyer/Development/dayz-one-life/adm-raw-20260826.log.gz` — outside this repo; never copy it in.

- [ ] **Step 2: Verify the counts are unchanged**

```bash
docker compose exec -T postgres psql -U factions -d factions_backfill -c "select type, count(*) from events group by type order by 2 desc;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c "select payload->>'action' as action, count(*) from events where type in ('flag.raised','flag.lowered') group by 1;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c "select count(*) as ceremonies from ceremonies;"
docker compose exec -T postgres psql -U factions -d factions_backfill -c "select sum(lines_ingested) as lines, count(*) filter (where complete) as complete_files, count(*) as files from adm_files;"
```

| Check | Expected |
|---|---|
| Lines replayed | **69,326** |
| Flag changes / raises / lowers | **14 / 10 / 4** |
| `emote.performed` | **2,093** |
| Ceremonies | **0** |
| `adm_files` rows | **1,026**, all `complete` |

**This is the check that matters.** The cursor refactor is exactly the change that could silently drop or double lines, and these counts are how that would show. If any of them moves, the refactor is wrong — record the actual value and investigate rather than writing it up as a pass.

- [ ] **Step 3: Prove the resume path on real data**

Re-run the replay a second time against the same database without recreating it. Expected: the same counts, and **0 new lines captured** — every file is `complete`, so nothing is reprocessed. This is the defect the plan exists to fix, demonstrated on 69,326 real lines rather than a fixture.

- [ ] **Step 4: Run the full suite**

```bash
export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
npx turbo run typecheck test --concurrency=1 --force
```

Expected: every task passes, 0 skipped, and the count has grown from **378**. Force the run; a cached pass proves nothing.

- [ ] **Step 5: Record the results**

Write `docs/acceptance/2026-08-31-live-ingest.md` with the ACTUAL observed numbers, the commands, and the date. Include the second-replay result from Step 3, and this unchecked gate verbatim:

```markdown
- [ ] **Live Nitrado tick (REQUIRED before the worker is trusted in production).**
      Against the real service id, run one sweep. Confirm: files listed oldest-first,
      the derived clock offset matches the measured value for that map
      (chernarus +4h / livonia and sakhal +7h), events land, and a second tick
      ingests only lines added since the first. Record the derived offset here —
      if it disagrees with the measured table, STOP: the derivation over-estimates
      by however long a file was still being written, and that is exactly the
      silent failure clock_offset_ms exists to prevent.
```

- [ ] **Step 6: Commit**

```bash
git add docs/acceptance/2026-08-31-live-ingest.md
git commit -m "docs: live ingest acceptance against the production export"
```

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| §3 port rather than depend; take only list/download | 1 |
| §3 hand-rolled config, console logging | 7 |
| §4 `nitrado_service_id`, `active`, `path` | 2 |
| §4 cursor columns already exist | 4 (reads them) |
| §5 loop | 7 |
| §5 sweep with per-server isolation | 7 |
| §5 tick: derive offset, budget, ordering | 6 |
| §5 resume writes, advance cursor from 0 | 4 |
| §5 clamp a cursor past the end | 4 |
| §5 no trailing-empty guard, and why | 3 |
| §6 Dockerfile, compose service, healthcheck | 9 |
| §6 `scripts/register-server.ts` | 8 |
| §7 client unit tests with injected fetch | 1 |
| §7 midnight-crossing resume test | 4 |
| §7 budget, ordering, sweep isolation | 6, 7 |
| §7 real-data acceptance | 10 |
| §7 live smoke gate | 10 Step 5 |

**Gap found and closed:** the spec's §5 says a file that cannot be parsed should not stop the sweep, but no task originally handled `parseAdmContent` throwing inside the tick. Task 6's implementation now catches it, logs, and marks the tick not-caught-up.

**Placeholder scan:** clean. Task 2 Step 4 deliberately tells the implementer to report a migration-ordering concern rather than guessing, because whether `servers` holds rows depends on the database it runs against — that is a real instruction, not a TODO.

**Type consistency:** `AdmFileRef` is defined in Task 1 and consumed unchanged by Tasks 6 and 7. `NitradoLike` is defined in Task 6 and imported by Task 7's sweep and main. `IngestOptions.markComplete` (Task 4) is set by Task 6's tick and by the two existing callers Task 4 updates. `deriveClockOffsetMs` returns `number | null` (Task 5) and Task 6 branches on the null.

**Scope check:** ten tasks. Task 4 is the one that carries real risk; Tasks 8 and 9 are operator-facing and have no unit tests by nature, which is why Task 10 verifies the whole path against real data.
