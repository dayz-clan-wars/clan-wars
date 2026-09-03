# dayzclanwars.com Web App Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up `apps/web` — a Next.js app with one coming-soon page — deployable to a VPS behind Caddy, serving the 33 flag images that the faction feed's embed thumbnails need.

**Architecture:** An eleventh workspace package following the shape of the existing apps. The page reads nothing and the app has no database access, which is what makes it deployable while `factions_live` lives on a different machine. Flag images are fetched once from the Fandom MediaWiki API by a hand-run script, normalized to 256px, and committed as static files under `public/flags/`. The bot gains one optional env var that fills `feed-embed.ts`'s existing resolver hook.

**Tech Stack:** Next.js 16 (App Router), TypeScript, vitest, sharp (image resizing, dev-only), Docker + docker compose, Caddy.

**Spec:** `docs/superpowers/specs/2026-09-03-web-app-skeleton-design.md`

## Global Constraints

- **The full gate, always with `--force`:** `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`. It is **20 tasks today and becomes 22** when `apps/web` exists. Check the COUNT, not the exit code — a cached pass proves nothing.
- **CLAUDE.md says "Expect 20/20 tasks".** That line is instructions, not prose, and it must be updated in the same change that makes it false (Task 6).
- **Port 5434 only** for anything database-related. 5432 and 5433 belong to other projects on this machine.
- **NEVER write to `factions_live`.** It is production. This plan touches it not at all.
- **Do not start, stop or signal the running bot.** There is a strict one-instance rule; a second instance sends duplicate DMs to real players. Task 6 changes bot code but does not restart it — that is the deploy, and it is not part of this plan.
- **The site is a surface, never a source of truth.** Nothing here may write faction state.
- **Comments explain WHY, not what.** `⚠️` marks lines whose failure mode is silent. Match the density of the file being edited.
- **vitest 2.1**: `vi.fn` takes a SINGLE function-type argument, not the vitest-1 two-argument form.
- **A passing vitest run does NOT imply a passing typecheck** in this repo — vitest transpiles without typechecking. Run `tsc --noEmit` separately.

---

### Task 1: `apps/web` — the workspace package and the page

**Files:**
- Create: `apps/web/package.json`
- Create: `apps/web/tsconfig.json`
- Create: `apps/web/next.config.ts`
- Create: `apps/web/vitest.config.ts`
- Create: `apps/web/app/layout.tsx`
- Create: `apps/web/app/page.tsx`
- Create: `apps/web/app/globals.css`
- Create: `apps/web/.gitignore`
- Test: `apps/web/test/smoke.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: the `@factions/web` package, with `typecheck` and `test` scripts that turbo discovers. No exported code that later tasks import.

- [ ] **Step 1: Create the package manifest**

`apps/web/package.json`. Note `test` runs vitest, so turbo finds two tasks here exactly as it does for every other package:

```json
{
  "name": "@factions/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^16.3.4",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "sharp": "^0.35.4"
  }
}
```

⚠️ `sharp` is a **devDependency**. It is used only by the hand-run fetch script in Task 3 and must not end up in the runtime image — see that task for why the script never runs at build time.

- [ ] **Step 2: Create the TypeScript and Next configuration**

`apps/web/tsconfig.json` — Next needs settings the repo's base config does not carry (JSX, DOM libs, its plugin), so this extends the base and adds them rather than changing the base for everyone:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "preserve",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "allowJs": true,
    "noEmit": true,
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules", ".next"]
}
```

`apps/web/next.config.ts`:

```typescript
import type { NextConfig } from "next";

const config: NextConfig = {
  // ⚠️ Required by apps/web/Dockerfile (Task 5). The standalone output is a
  // self-contained server directory; without it the runtime image would need
  // the whole pnpm workspace and its node_modules copied in.
  output: "standalone",
};

export default config;
```

`apps/web/vitest.config.ts` — the web package's tests are plain Node tests over files and strings, with no React rendering, so no jsdom environment is needed:

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
```

⚠️ Do NOT add the repo's shared vitest `globalSetup` here. That setup creates a per-package Postgres database, and this package must never touch one — pulling it in would make a database a prerequisite for testing a static page.

`apps/web/.gitignore`:

```
.next/
next-env.d.ts
```

- [ ] **Step 3: Write the page**

`apps/web/app/globals.css` — a small, deliberate stylesheet; no framework:

```css
:root {
  color-scheme: dark;
  --bg: #0e1013;
  --fg: #e8e6e3;
  --muted: #8b9199;
  --accent: #c9a227;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  min-height: 100dvh;
  display: grid;
  place-items: center;
  padding: 2rem;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
}

main { max-width: 34rem; text-align: center; }

h1 {
  margin: 0 0 0.5rem;
  font-size: clamp(2rem, 6vw, 3rem);
  letter-spacing: 0.02em;
}

.tag { color: var(--accent); text-transform: uppercase; letter-spacing: 0.18em; font-size: 0.8rem; }
p { color: var(--muted); }
a { color: var(--fg); }
```

`apps/web/app/layout.tsx`:

```tsx
import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clan Wars",
  description: "Factions, territory and consequence on a DayZ server.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`apps/web/app/page.tsx`:

```tsx
export default function Home() {
  return (
    <main>
      <p className="tag">Coming soon</p>
      <h1>Clan Wars</h1>
      <p>
        Found a faction by ritual at a flagpole. Hold your ground, or lose the flag
        to someone who will. Player tools are moving here from Discord.
      </p>
      <p>
        Everything is earned in game and proved from the server&rsquo;s own logs.
      </p>
    </main>
  );
}
```

- [ ] **Step 4: Write the smoke test**

`apps/web/test/smoke.test.ts`. The spec says the page's markup is deliberately not snapshotted — it would fail on every copy edit while proving nothing. What IS worth pinning is the constraint that makes this app deployable at all:

```typescript
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APP = join(import.meta.dirname, "..", "app");

/**
 * ⚠️ The site is a surface, never a source of truth (spec §3). It is also
 * deployable today ONLY because it reads nothing — `factions_live` lives on a
 * different machine from the VPS, so a database import here would not fail at
 * review, it would fail at runtime in production.
 *
 * This test is the cheap structural guard on both. It is not a substitute for
 * the design decision; it is what makes the decision expensive to reverse by
 * accident.
 */
describe("the web app reads nothing", () => {
  const sources = readdirSync(APP, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => ({ file: f, text: readFileSync(join(APP, f), "utf8") }));

  it("has source files to check", () => {
    expect(sources.length).toBeGreaterThan(0);
  });

  it.each(["@factions/db", "drizzle-orm", "postgres"])(
    "imports no database package (%s)", (pkg) => {
      const offenders = sources.filter((s) => s.text.includes(`"${pkg}`) || s.text.includes(`'${pkg}`));
      expect(offenders.map((o) => o.file)).toEqual([]);
    },
  );

  it("reads no DATABASE_URL", () => {
    const offenders = sources.filter((s) => s.text.includes("DATABASE_URL"));
    expect(offenders.map((o) => o.file)).toEqual([]);
  });
});
```

- [ ] **Step 5: Install and run**

```bash
pnpm install
```

```bash
pnpm --filter @factions/web test
```

Expected: PASS, 5 tests (1 + 3 parameterised + 1).

```bash
cd apps/web && npx tsc --noEmit
```

⚠️ Expected on the FIRST run: an error about a missing `next-env.d.ts`. That file is generated by `next build`/`next dev`, not committed. Run `pnpm --filter @factions/web build` once to generate it, then re-run the typecheck and confirm it is clean. `next-env.d.ts` is gitignored in Step 2 — do not commit it.

- [ ] **Step 6: Confirm the gate is now 22**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: **22 successful, 22 total.** If it reports 20, turbo has not discovered the package — check `package.json`'s `scripts` block has both `typecheck` and `test`.

- [ ] **Step 7: Commit**

```bash
git add apps/web pnpm-lock.yaml
git commit -m "feat(web): apps/web — a Next.js skeleton with a coming-soon page

Reads nothing, on purpose: factions_live is on a different machine from the
VPS, so a database import here fails in production rather than at review. A
structural test pins that."
```

---

### Task 2: The flag name mapping

**Files:**
- Create: `apps/web/src/flag-images.ts`
- Test: `apps/web/test/flag-images.test.ts`

**Interfaces:**
- Consumes: `CLAIMABLE_FLAGS` from `@factions/domain`.
- Produces:
  - `WIKI_FILENAME_ALIASES: Readonly<Record<string, string>>`
  - `wikiFilenameFor(texture: string): string`
  - `flagImagePath(texture: string): string` — the repo-relative path under `public/`, i.e. `flags/<texture>.png`

This task adds `@factions/domain` as a dependency of `@factions/web`.

- [ ] **Step 1: Add the domain dependency**

In `apps/web/package.json`, add to `dependencies`:

```json
    "@factions/domain": "workspace:*",
```

Then `pnpm install`.

- [ ] **Step 2: Write the failing test**

`apps/web/test/flag-images.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { CLAIMABLE_FLAGS } from "@factions/domain";
import { WIKI_FILENAME_ALIASES, wikiFilenameFor, flagImagePath } from "../src/flag-images.js";

describe("wikiFilenameFor", () => {
  it("maps a texture to <texture>.png by default", () => {
    expect(wikiFilenameFor("Flag_Wolf")).toBe("Flag_Wolf.png");
    expect(wikiFilenameFor("Flag_Chernarus")).toBe("Flag_Chernarus.png");
  });

  it("⚠️ maps Flag_Sakhal to the wiki's differently-shaped filename", () => {
    // Verified against the Fandom MediaWiki API on 2026-09-03: 32 of the 33
    // claimable textures are <texture>.png, and this one is not. Getting it
    // wrong yields 32 working thumbnails and one silently broken faction.
    expect(wikiFilenameFor("Flag_Sakhal")).toBe("Sakhal_flag.PNG");
  });

  it("⚠️ the alias table contains ONLY textures the default rule cannot serve", () => {
    // A future tidy-up that "generalises" the rule must not leave a stale
    // alias behind, and an alias for a texture the rule already handles is a
    // sign the rule changed under it.
    expect(Object.keys(WIKI_FILENAME_ALIASES)).toEqual(["Flag_Sakhal"]);
  });

  it("every alias key is a real claimable texture", () => {
    for (const key of Object.keys(WIKI_FILENAME_ALIASES)) {
      expect(CLAIMABLE_FLAGS).toContain(key);
    }
  });
});

describe("flagImagePath", () => {
  it("is <texture>.png under flags/, regardless of the wiki's name", () => {
    // ⚠️ Our served filename follows OUR texture, not the wiki's. The bot's
    // resolver builds `${base}/flags/${texture}.png` with no alias table of
    // its own, so the Sakhal exception must be absorbed here, at fetch time.
    expect(flagImagePath("Flag_Wolf")).toBe("flags/Flag_Wolf.png");
    expect(flagImagePath("Flag_Sakhal")).toBe("flags/Flag_Sakhal.png");
  });

  it("covers every claimable flag", () => {
    expect(CLAIMABLE_FLAGS.map(flagImagePath)).toHaveLength(33);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

```bash
pnpm --filter @factions/web test -- flag-images
```

Expected: FAIL — cannot resolve `../src/flag-images.js`.

- [ ] **Step 4: Implement**

`apps/web/src/flag-images.ts`:

```typescript
/**
 * The 33 claimable flag textures are named consistently in game and almost
 * consistently on the DayZ Fandom wiki. This module owns that "almost".
 */

/**
 * Textures whose wiki filename does not follow `<texture>.png`.
 *
 * ⚠️ Exactly one entry, and it is a table rather than a cleverer rule on
 * purpose. `Flag_Sakhal` is `Sakhal_flag.PNG` on the wiki — different word
 * order, different capitalisation, uppercase extension. Any transform general
 * enough to derive that would also mangle names that are currently correct.
 *
 * The failure this prevents is the quiet one: 32 working thumbnails and one
 * faction whose feed embeds are subtly broken, discovered weeks later by
 * whoever happens to hold Sakhal.
 *
 * Verified against the MediaWiki API on 2026-09-03.
 */
export const WIKI_FILENAME_ALIASES: Readonly<Record<string, string>> = {
  Flag_Sakhal: "Sakhal_flag.PNG",
};

/** What the wiki calls this texture's image. */
export function wikiFilenameFor(texture: string): string {
  return WIKI_FILENAME_ALIASES[texture] ?? `${texture}.png`;
}

/**
 * Where we serve it, relative to `public/`.
 *
 * ⚠️ Named after OUR texture, never the wiki's. The bot's resolver builds
 * `${base}/flags/${texture}.png` and deliberately carries no alias table, so
 * the wiki's naming inconsistency has to stop here — at fetch time — rather
 * than travelling into the bot.
 */
export function flagImagePath(texture: string): string {
  return `flags/${texture}.png`;
}
```

- [ ] **Step 5: Run the tests**

```bash
pnpm --filter @factions/web test -- flag-images
```

Expected: PASS, 6 tests.

```bash
cd apps/web && npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/flag-images.ts apps/web/test/flag-images.test.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): the flag texture to wiki filename mapping

One alias, for Flag_Sakhal, which the wiki calls Sakhal_flag.PNG. A table
rather than a cleverer rule: any transform general enough to derive that
would mangle the 32 names that are already correct."
```

---

### Task 3: Fetch and normalize the images

**Files:**
- Create: `apps/web/scripts/fetch-flags.ts`
- Create: `apps/web/public/flags/*.png` (33 files, generated then committed)
- Create: `scripts/fetch-flags.md`
- Test: `apps/web/test/flag-assets.test.ts`

**Interfaces:**
- Consumes: `wikiFilenameFor`, `flagImagePath` from `../src/flag-images.js`; `CLAIMABLE_FLAGS` from `@factions/domain`.
- Produces: 33 committed PNGs. No exported code.

- [ ] **Step 1: Write the drift test first**

`apps/web/test/flag-assets.test.ts`. This is the test the spec calls for, and it will fail until Step 3 produces the files:

```typescript
import { describe, it, expect } from "vitest";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLAIMABLE_FLAGS } from "@factions/domain";

const FLAGS_DIR = join(import.meta.dirname, "..", "public", "flags");

/**
 * ⚠️ CLAIMABLE_FLAGS and the contents of public/flags/ are two statements of
 * one fact, and the compiler cannot see the second. Nothing but this test
 * holds them together.
 *
 * Drift is silent in the worst way: the symptom is a missing thumbnail in a
 * Discord channel, not a stack trace, and only for the faction holding the
 * affected flag. Same reasoning as packages/db/test/holding-index-drift.test.ts.
 */
describe("flag images match CLAIMABLE_FLAGS", () => {
  const files = readdirSync(FLAGS_DIR).filter((f) => f.endsWith(".png"));

  it("every claimable flag has an image", () => {
    const missing = CLAIMABLE_FLAGS.filter((t) => !files.includes(`${t}.png`));
    expect(missing).toEqual([]);
  });

  it("every image belongs to a claimable flag", () => {
    const orphans = files.filter((f) => !CLAIMABLE_FLAGS.includes(f.replace(/\.png$/u, "")));
    expect(orphans).toEqual([]);
  });

  it("there are exactly 33", () => {
    expect(files).toHaveLength(33);
  });

  it("⚠️ no image is anywhere near the wiki's original weight", () => {
    // Flag_Wolf.png is 877x1027 and 1.4MB at source, against a Discord embed
    // thumbnail rendered near 80x80. This asserts the normalisation in
    // scripts/fetch-flags.ts actually ran — committing the raw downloads
    // would add ~35MB to the repo and nothing else would complain.
    for (const f of files) {
      const bytes = statSync(join(FLAGS_DIR, f)).size;
      expect(bytes, `${f} is ${bytes} bytes`).toBeLessThan(200_000);
      expect(bytes, `${f} is suspiciously small`).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @factions/web test -- flag-assets
```

Expected: FAIL — `ENOENT`, the `public/flags` directory does not exist.

- [ ] **Step 3: Write the fetch script**

`apps/web/scripts/fetch-flags.ts`:

```typescript
/**
 * Fetch the 33 claimable flag images from the DayZ Fandom wiki, normalise
 * them, and write them into public/flags/.
 *
 * ⚠️ Run BY HAND, never at build or deploy time. A build that reaches out to
 * a third-party wiki is a build that fails when that wiki blocks it — and it
 * already blocks ordinary requests: a plain GET of the HTML page returns 403,
 * which is why this uses the MediaWiki API. It is also a build whose output
 * can change with nothing in this repository changing.
 *
 * The flag pool is fixed at 33 by design (see packages/domain/src/flags.ts),
 * so the expected frequency of running this is: once.
 *
 *   pnpm --filter @factions/web exec tsx scripts/fetch-flags.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { CLAIMABLE_FLAGS } from "@factions/domain";
import { wikiFilenameFor, flagImagePath } from "../src/flag-images.js";

const API = "https://dayz.fandom.com/api.php";
const PUBLIC = join(import.meta.dirname, "..", "public");

/** Long-edge target. Discord renders embed thumbnails near 80x80; this leaves
 *  room for a future directory page without being another 1.4MB per flag. */
const MAX_EDGE = 256;

/** The wiki serves these over a CDN that rejects requests without a UA. */
const HEADERS = { "User-Agent": "clan-wars-flag-fetch/1.0 (private DayZ community server)" };

async function imageUrl(wikiFilename: string): Promise<string> {
  const url = `${API}?action=query&titles=${encodeURIComponent(`File:${wikiFilename}`)}` +
    `&prop=imageinfo&iiprop=url&format=json`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`imageinfo ${wikiFilename}: HTTP ${res.status}`);
  const body = await res.json() as {
    query?: { pages?: Record<string, { imageinfo?: { url: string }[] }> };
  };
  const pages = Object.values(body.query?.pages ?? {});
  const direct = pages[0]?.imageinfo?.[0]?.url;
  // ⚠️ A missing page comes back as a page with no imageinfo rather than an
  // error, so an unchecked read here would write a zero-byte file and the
  // only symptom would be one blank thumbnail.
  if (!direct) throw new Error(`no imageinfo for File:${wikiFilename} — has the wiki renamed it?`);
  return direct;
}

async function main(): Promise<void> {
  await mkdir(join(PUBLIC, "flags"), { recursive: true });
  let written = 0;

  for (const texture of CLAIMABLE_FLAGS) {
    const wikiName = wikiFilenameFor(texture);
    const src = await imageUrl(wikiName);
    const res = await fetch(src, { headers: HEADERS });
    if (!res.ok) throw new Error(`download ${wikiName}: HTTP ${res.status}`);

    const raw = Buffer.from(await res.arrayBuffer());
    const out = await sharp(raw)
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: "inside", withoutEnlargement: true })
      .png({ compressionLevel: 9 })
      .toBuffer();

    const dest = join(PUBLIC, flagImagePath(texture));
    await mkdir(dirname(dest), { recursive: true });
    await writeFile(dest, out);
    written++;
    console.log(`${texture.padEnd(20)} <- ${wikiName.padEnd(22)} ${raw.length} -> ${out.length} bytes`);
  }

  console.log(`\nwrote ${written} flag image(s) to public/flags/`);
  if (written !== CLAIMABLE_FLAGS.length) {
    throw new Error(`expected ${CLAIMABLE_FLAGS.length}, wrote ${written}`);
  }
}

await main();
```

- [ ] **Step 4: Run it**

```bash
pnpm --filter @factions/web exec tsx scripts/fetch-flags.ts
```

Expected: 33 lines showing each texture, its wiki filename, and the size reduction, then `wrote 33 flag image(s)`.

⚠️ If any single flag 404s, do not comment it out or skip it. A missing flag means either the wiki renamed a file — in which case `WIKI_FILENAME_ALIASES` in Task 2 gains a second entry and its test updates — or `CLAIMABLE_FLAGS` and the wiki have genuinely diverged, which is a finding worth reporting, not routing around.

- [ ] **Step 5: Run the drift test**

```bash
pnpm --filter @factions/web test -- flag-assets
```

Expected: PASS, 4 tests.

Then check the total weight is sane:

```bash
du -sh apps/web/public/flags
```

Expected: comfortably under 5 MB for all 33.

- [ ] **Step 6: Write the operator doc**

`scripts/fetch-flags.md`, following the register of `scripts/backfill-faction-events.md`. It must say: what the script does; that it is hand-run and never part of a build or deploy, and why (the wiki 403s ordinary requests, and build output would not be reproducible); that its output is committed; that the flag pool is fixed at 33 so the expected run frequency is once; and what to do if a flag 404s (add an alias, do not skip).

- [ ] **Step 7: Commit**

```bash
git add apps/web/scripts/fetch-flags.ts apps/web/public/flags apps/web/test/flag-assets.test.ts scripts/fetch-flags.md
git commit -m "feat(web): the 33 flag images, fetched once and normalised

Resized to 256px on the long edge: Flag_Wolf is 877x1027 and 1.4MB at source
against a Discord thumbnail rendered near 80x80, so committing the raw
downloads would add ~35MB to display postage stamps. A drift test holds the
directory and CLAIMABLE_FLAGS together."
```

---

### Task 4: `FLAG_IMAGE_BASE_URL` in the bot

**Files:**
- Modify: `apps/bot/src/config.ts` (the `BotConfig` type, a new validator beside `optionalSnowflake` at line 72, and `loadConfig`'s object literal at line 119)
- Create: `apps/bot/src/flag-image.ts`
- Modify: `apps/bot/src/discord.ts` (the `feedTick` call at line 1199)
- Test: `apps/bot/test/flag-image.test.ts`
- Test: `apps/bot/test/config.test.ts` (append cases)

**Interfaces:**
- Consumes: `FlagImageResolver` from `apps/bot/src/feed-embed.ts` — `(texture: string) => string | null`.
- Produces:
  - `BotConfig.flagImageBaseUrl: string | undefined`
  - `flagImageResolver(baseUrl: string | undefined): FlagImageResolver`

- [ ] **Step 1: Write the failing resolver test**

`apps/bot/test/flag-image.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { flagImageResolver } from "../src/flag-image.js";

describe("flagImageResolver", () => {
  it("builds a URL under /flags/ named for the texture", () => {
    const resolve = flagImageResolver("https://dayzclanwars.com");
    expect(resolve("Flag_Wolf")).toBe("https://dayzclanwars.com/flags/Flag_Wolf.png");
  });

  it("⚠️ uses our texture name for every flag, including Sakhal", () => {
    // The wiki calls Sakhal's image Sakhal_flag.PNG, but that inconsistency is
    // absorbed at fetch time in apps/web. The bot carries no alias table, and
    // adding one here would be a second place for the same fact to live.
    const resolve = flagImageResolver("https://dayzclanwars.com");
    expect(resolve("Flag_Sakhal")).toBe("https://dayzclanwars.com/flags/Flag_Sakhal.png");
  });

  it("⚠️ strips a trailing slash rather than emitting a double one", () => {
    // A base URL copied from a browser usually has one. Harmless on most
    // servers, not on all, and the symptom is a missing thumbnail nobody
    // connects to a stray character in an env var.
    const resolve = flagImageResolver("https://dayzclanwars.com/");
    expect(resolve("Flag_Wolf")).toBe("https://dayzclanwars.com/flags/Flag_Wolf.png");
  });

  it("returns null for every texture when no base URL is configured", () => {
    const resolve = flagImageResolver(undefined);
    expect(resolve("Flag_Wolf")).toBeNull();
    expect(resolve("Flag_Sakhal")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  pnpm --filter @factions/bot test -- flag-image
```

Expected: FAIL — cannot resolve `../src/flag-image.js`.

- [ ] **Step 3: Implement the resolver**

`apps/bot/src/flag-image.ts`:

```typescript
import type { FlagImageResolver } from "./feed-embed.js";

/**
 * Fill `feed-embed.ts`'s resolver hook from configuration.
 *
 * ⚠️ Never fetches the URL to check it. A wrong base costs a missing
 * thumbnail and nothing else — Discord renders the embed without one. A
 * validating fetch would put a third-party network call between a faction
 * transition and its announcement, on the path whose first failure blocks the
 * whole feed queue by design.
 *
 * ⚠️ No alias table here. The wiki's one inconsistent filename (Sakhal) is
 * absorbed when the images are fetched, in apps/web — served files are always
 * named for our texture. A second table here would be the same fact stated
 * twice, and the two would drift.
 */
export function flagImageResolver(baseUrl: string | undefined): FlagImageResolver {
  if (!baseUrl) return () => null;
  // A base copied out of a browser usually carries a trailing slash.
  const base = baseUrl.replace(/\/+$/u, "");
  return (texture) => `${base}/flags/${texture}.png`;
}
```

- [ ] **Step 4: Run the resolver test**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  pnpm --filter @factions/bot test -- flag-image
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Write the failing config test**

Append to `apps/bot/test/config.test.ts`, inside the existing top-level `describe("loadConfig", ...)`. That file has a module-level constant `OK` holding a minimal valid environment — reuse it, matching the surrounding style:

```typescript
describe("FLAG_IMAGE_BASE_URL", () => {
  it("⚠️ is optional, so embeds keep posting without thumbnails when unset", () => {
    // The feed shipped before any artwork existed and must keep working
    // exactly as it does today for anyone who never sets this.
    expect(loadConfig({ ...OK }).flagImageBaseUrl).toBeUndefined();
  });

  it("reads an https base URL", () => {
    expect(loadConfig({ ...OK, FLAG_IMAGE_BASE_URL: "https://dayzclanwars.com" }).flagImageBaseUrl)
      .toBe("https://dayzclanwars.com");
  });

  it("treats an empty string as unset", () => {
    expect(loadConfig({ ...OK, FLAG_IMAGE_BASE_URL: "" }).flagImageBaseUrl).toBeUndefined();
  });

  it("⚠️ rejects a malformed URL at load rather than at first post", () => {
    // An unset base is silent by design, so a broken one would otherwise be
    // indistinguishable from an unconfigured one until someone noticed the
    // embeds had no thumbnails.
    expect(() => loadConfig({ ...OK, FLAG_IMAGE_BASE_URL: "dayzclanwars.com" }))
      .toThrow(/FLAG_IMAGE_BASE_URL/u);
  });

  it("rejects a non-http scheme", () => {
    expect(() => loadConfig({ ...OK, FLAG_IMAGE_BASE_URL: "file:///etc/passwd" }))
      .toThrow(/FLAG_IMAGE_BASE_URL/u);
  });
});
```

- [ ] **Step 6: Run it and watch it fail**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  pnpm --filter @factions/bot test -- config
```

Expected: FAIL — `flagImageBaseUrl` does not exist on `BotConfig`.

- [ ] **Step 7: Implement the config**

In `apps/bot/src/config.ts`, add to the `BotConfig` type:

```typescript
  /**
   * Base URL the flag images are served from — `https://dayzclanwars.com`.
   * Undefined means embeds post with no thumbnail, exactly as they did before
   * any artwork existed.
   */
  flagImageBaseUrl: string | undefined;
```

Add a validator beside `optionalSnowflake`:

```typescript
/**
 * ⚠️ Validated at load, not at first use — the same reasoning as
 * `optionalSnowflake` directly above. An unset base is silent by design, so a
 * malformed one would be indistinguishable from an unconfigured one until
 * somebody noticed the embeds had lost their thumbnails.
 */
function optionalHttpUrl(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const raw = env[key];
  if (raw === undefined || raw === "") return undefined;
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${key} must be an absolute URL, got ${JSON.stringify(raw)}.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${key} must be http or https, got ${JSON.stringify(parsed.protocol)}.`);
  }
  return raw;
}
```

And in `loadConfig`'s object literal, after `feedChannelId`:

```typescript
    flagImageBaseUrl: optionalHttpUrl(env, "FLAG_IMAGE_BASE_URL"),
```

- [ ] **Step 8: Wire it into the feed tick**

In `apps/bot/src/discord.ts`, the `feedTick` call at line 1199 already accepts a `flagImage` option. Add it:

```typescript
        const f = await feedTick(feedStore, feedPoster, {
          now: new Date(),
          flagImage: flagImageResolver(cfg.flagImageBaseUrl),
          onError: (id, err) => {
```

with the import:

```typescript
import { flagImageResolver } from "./flag-image.js";
```

⚠️ Build the resolver where it is used, not once outside the runner. It is a two-line closure over a string; hoisting it saves nothing and puts the configuration further from the call that depends on it.

- [ ] **Step 9: Run the bot's tests and typecheck**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  pnpm --filter @factions/bot test -- flag-image config feed-embed feed-tick feed-wiring
```

Expected: PASS, all files.

```bash
cd apps/bot && npx tsc --noEmit
```

Expected: clean, no output.

- [ ] **Step 10: Commit**

```bash
git add apps/bot/src/config.ts apps/bot/src/flag-image.ts apps/bot/src/discord.ts \
        apps/bot/test/flag-image.test.ts apps/bot/test/config.test.ts
git commit -m "feat(bot): FLAG_IMAGE_BASE_URL fills the feed's flag resolver

Optional: unset, embeds post with no thumbnail exactly as they do today. The
resolver never fetches the URL to validate it — a wrong base costs a missing
thumbnail, while a network call there would sit between a transition and its
announcement."
```

---

### Task 5: Dockerfile, compose services, and the Caddyfile

**Files:**
- Create: `apps/web/Dockerfile`
- Create: `apps/web/.dockerignore`
- Create: `Caddyfile`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: `output: "standalone"` from Task 1's `next.config.ts`.
- Produces: `web` and `caddy` compose services.

- [ ] **Step 1: Write the Dockerfile**

`apps/web/Dockerfile`. The existing `apps/ingest-worker/Dockerfile` is the pattern for how this repo builds a workspace package; this one adds a second stage because Next produces a self-contained bundle:

```dockerfile
# apps/web/Dockerfile
# ⚠️ node:22, not node:20 like apps/ingest-worker/Dockerfile. Next 16 requires
# Node ^20.9 || >=22, and pinning the newer line here leaves headroom without
# forcing a bump on the worker, which is fine where it is.
FROM node:22-alpine AS builder
RUN corepack enable
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY apps/web ./apps/web
RUN pnpm install --frozen-lockfile
WORKDIR /repo/apps/web
RUN pnpm build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
# Next's standalone output carries its own minimal node_modules, so the
# workspace and its install do not travel into the runtime image.
COPY --from=builder /repo/apps/web/.next/standalone ./
COPY --from=builder /repo/apps/web/.next/static ./apps/web/.next/static
COPY --from=builder /repo/apps/web/public ./apps/web/public
EXPOSE 3000
# ⚠️ The standalone server lands at the package's path inside the bundle, not
# at the root — a workspace build nests it under apps/web.
CMD ["node", "apps/web/server.js"]
```

`apps/web/.dockerignore`:

```
node_modules
.next
```

- [ ] **Step 2: Write the Caddyfile**

`Caddyfile` at the repo root:

```
# TLS for dayzclanwars.com. Caddy obtains and renews the certificate itself
# over ACME; there is no certbot and no cron entry to forget.
#
# ⚠️ Requires a DNS A record for this name pointing at the VPS, and ports 80
# AND 443 reachable, BEFORE it starts. Port 80 is not optional — it carries
# the HTTP-01 challenge. Caddy retries against Let's Encrypt's rate limits, so
# starting it before DNS resolves is not free.
dayzclanwars.com, www.dayzclanwars.com {
	encode gzip

	# The flag images are immutable in practice: the pool is fixed at 33 and
	# the files are regenerated only by a hand-run script. Discord caches
	# them against its own CDN regardless, so this mostly serves browsers.
	@flags path /flags/*
	header @flags Cache-Control "public, max-age=604800, immutable"

	reverse_proxy web:3000
}
```

- [ ] **Step 3: Add the compose services**

Append to `docker-compose.yml`'s `services:` block, and add the two volumes:

```yaml
  web:
    build: { context: ., dockerfile: apps/web/Dockerfile }
    restart: unless-stopped
    environment:
      NODE_ENV: production
    # ⚠️ No ports mapping. Caddy is the only thing that should reach it, and
    # publishing 3000 would serve the site over plain HTTP alongside the
    # TLS one.
  caddy:
    image: caddy:2-alpine
    restart: unless-stopped
    depends_on: [web]
    ports: ["80:80", "443:443"]
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - caddy-data:/data
      - caddy-config:/config
```

and under the existing `volumes:` key:

```yaml
  caddy-data:
  caddy-config:
```

⚠️ Add a comment above the `web` service recording the hazard the spec names:

```yaml
  # ⚠️ This file also describes `postgres` and `ingest-worker`, which must NOT
  # be started on the VPS. A bare `docker compose up -d` there would stand up a
  # second, EMPTY Postgres that looks like a working database and holds none of
  # the live data. On the VPS, name the services: `docker compose up -d web caddy`.
```

- [ ] **Step 4: Build the image and verify it serves**

```bash
docker compose build web
```

Expected: a successful build ending with the runtime stage.

```bash
docker compose up -d web
sleep 5
docker compose exec web wget -qO- http://localhost:3000/ | head -20
```

Expected: HTML containing `Clan Wars`.

```bash
docker compose exec web wget -q --server-response -O /dev/null http://localhost:3000/flags/Flag_Wolf.png 2>&1 | grep -E "HTTP/|Content-Type"
```

Expected: `HTTP/1.1 200 OK` and `Content-Type: image/png`.

⚠️ Then stop it — this machine is not the VPS and nothing here should keep a web server running:

```bash
docker compose stop web
docker compose rm -f web
```

⚠️ **Use `stop`, and never `docker compose down`.** `down` ignores any service name you
give it in older Compose versions and tears down the whole project — including `postgres`,
which holds `factions_live`, and `ingest-worker`, which is feeding the live game server.
`stop <service>` is the only form that is safe to type here.

- [ ] **Step 5: Commit**

```bash
git add apps/web/Dockerfile apps/web/.dockerignore Caddyfile docker-compose.yml
git commit -m "feat(web): Dockerfile, compose services and Caddy TLS

Both services go in the existing compose file because the stated end state is
one box. Comment records the matching hazard: a bare 'compose up' on the VPS
would start a second empty Postgres that looks like a working database."
```

---

### Task 6: Documentation, the runbook, and the full gate

**Files:**
- Modify: `CLAUDE.md`
- Modify: `apps/bot/README.md`
- Create: `apps/web/README.md`
- Create: `docs/deploy/2026-09-03-web-app-skeleton.md`
- Modify: `docs/superpowers/plans/PLAN-3-INBOX.md`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing code depends on.

- [ ] **Step 1: Run the full gate**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: **22 successful, 22 total.** Check the COUNT. If it is red, stop and fix before writing documentation over it.

- [ ] **Step 2: Update `CLAUDE.md`'s gate count**

Two edits, and both matter because that section is instructions rather than description:

Replace `Expect **20/20 tasks**.` with `Expect **22/22 tasks**.` and update the surrounding sentence if it names a package count.

Add to the "Running things" section:

```markdown
- **Web app:** `docker compose build web && docker compose up -d web caddy`. Not run on
  this machine in normal operation — it is deployed to the VPS. `pnpm --filter
  @factions/web dev` for local work.
```

- [ ] **Step 3: Add the invariants to `CLAUDE.md`**

```markdown
- **The website is a surface, never a source of truth.** Faction state is earned in game
  and proved from the server's logs; nothing on `dayzclanwars.com` may create a faction,
  claim a flag, bind a pole or alter a roster. `apps/web/test/smoke.test.ts` pins the
  structural half of this — the app imports no database package and reads no
  `DATABASE_URL`. That is also what makes it deployable at all: `factions_live` is on
  this machine, not the VPS, so a database import there fails in production rather than
  at review.
- **The 33 flag images and `CLAIMABLE_FLAGS` are two statements of one fact.**
  `apps/web/test/flag-assets.test.ts` holds them together. Drift shows up as a missing
  thumbnail in a Discord channel, not as an error.
- **⚠️ `docker-compose.yml` describes services the VPS must not start.** It carries
  `postgres` and `ingest-worker` alongside `web` and `caddy`. On the VPS, always name the
  services — `docker compose up -d web caddy` — because a bare `up -d` there stands up a
  second, empty Postgres that looks like a working database.
```

- [ ] **Step 4: Document the env var**

In `apps/bot/README.md`, add `FLAG_IMAGE_BASE_URL` to the environment table: optional, an absolute http(s) URL, unset means embeds post without thumbnails. Give `https://dayzclanwars.com` as the value and note that a trailing slash is tolerated.

Write `apps/web/README.md` covering: what the app is today (one static page plus the flag images), that it reads no database and why, how to run it locally, and how the flag images get there (a pointer to `scripts/fetch-flags.md`, not a second copy of that content).

Include a short note on the artwork's provenance, carrying over the spec's §7 reasoning
rather than restating it as settled: the images are Bohemia Interactive's game assets
mirrored from a Fandom wiki, reused non-commercially to identify those same in-game items
for a private community server; the practical risk is low, nobody qualified has reviewed
it, and undoing it is 33 files in one directory plus a resolver that already falls back to
null. A reader who wonders where the images came from should find that answer in the app
they are looking at.

- [ ] **Step 5: Write the deploy runbook**

`docs/deploy/2026-09-03-web-app-skeleton.md`, following the structure of `docs/deploy/2026-09-03-faction-feed.md`. In order:

1. **Prerequisites the deploy cannot satisfy for itself.** A DNS A record for `dayzclanwars.com` (and `www`) pointing at the VPS, propagated — verify with `dig +short dayzclanwars.com`. Ports 80 and 443 reachable. ⚠️ Port 80 is not optional; it carries the ACME HTTP-01 challenge.
2. **Get the code onto the VPS** and `docker compose build web`.
3. **Start only the web services:** `docker compose up -d web caddy`. ⚠️ Never a bare `docker compose up -d` — see the hazard above.
4. **Verify TLS and the images**, from outside the VPS:
   - `curl -sI https://dayzclanwars.com/ | head -1` → `HTTP/2 200`
   - `curl -sI https://dayzclanwars.com/flags/Flag_Wolf.png | grep -i content-type` → `image/png`
   - `curl -sI https://dayzclanwars.com/flags/Flag_Sakhal.png | head -1` → `HTTP/2 200`, checked explicitly because it is the one name that does not follow the rule.
5. **Turn on thumbnails:** add `FLAG_IMAGE_BASE_URL=https://dayzclanwars.com` to the bot's `.env` — ⚠️ in `.env`, not only on the start command line, for the same reason `BOT_FEED_CHANNEL_ID` lives there: a command-line-only variable turns the feature off at the next restart with nothing saying so.
6. **Restart the bot as a single instance:** `pkill -f "src/main.ts"`, then **count the survivors and confirm zero** before starting, per CLAUDE.md's one-instance rule.
7. **Acceptance**, and be honest about its cost — carry over the spec's §9 wording: waiting for a real transition costs nothing but the timing is not ours, while re-queueing a backfilled row (`update faction_events set posted_at = null where id = 2`) posts a duplicate embed into a channel real players can see. Steps 1-4 are verifiable without touching the bot at all.
8. **Rollback:** `docker compose stop web caddy` leaves the bot untouched; unsetting `FLAG_IMAGE_BASE_URL` and restarting returns embeds to their current thumbnail-less state. Neither requires a schema change.

- [ ] **Step 6: Close inbox item 35's first half**

Item 35 records two gaps: the missing flag artwork, and that a blocked feed queue has no alerting. The first is now closed. Edit the item to strike the artwork half with the date and commit, and leave the alerting half open and clearly separate — do not strike the whole item.

Also update `CLAUDE.md`'s "Known-open" entry 4, which names both; it should now name only the alerting gap.

- [ ] **Step 7: Re-run the gate and commit**

```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```

Expected: **22 successful, 22 total.**

```bash
git add CLAUDE.md apps/bot/README.md apps/web/README.md \
        docs/deploy/2026-09-03-web-app-skeleton.md docs/superpowers/plans/PLAN-3-INBOX.md
git commit -m "docs(web): gate count, invariants, env var and the deploy runbook"
```

---

## Notes for the implementer

**On the gate count.** It is 20 before Task 1 and 22 after. If you run the gate between tasks and see 20, the web package is not being discovered — check that its `package.json` has both `typecheck` and `test` scripts, since turbo derives tasks from those.

**On `next-env.d.ts`.** Next generates it, it is gitignored, and `tsc --noEmit` fails without it. Running `pnpm --filter @factions/web build` once creates it. If a fresh clone fails typecheck for this reason, that is the fix — not committing the file.

**On what is deliberately NOT built.** No Discord OAuth, no sessions, no database access, no map, no roster, no API, no CI. Every open question in `docs/direction/2026-09-02-web-app-and-faction-map.md` stays open, including the big one: `factions_live` is on a different machine from the VPS, and the intended resolution is moving the whole stack to the VPS later. Any future data-driven page has that as an unstated prerequisite.

**On not touching production.** This plan changes bot code but must not restart the bot, and must not start web services on this machine beyond the brief verification in Task 5 Step 4. The deploy is a separate, deliberate act with its own runbook.
