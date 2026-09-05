# Site foundation — implementation plan (increment 2a)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the site a real data path and a real design system — `packages/roster` with its first read, Tailwind and the palette as one `@theme`, the fixture prototypes gone, `/me` rendering the viewer's link and clan from the database at request time — and close the small sweeps deferred from increments 0 and 1.

**Architecture:** `apps/web` imports `@factions/roster` and never `@factions/db`; the package holds the database client, reads `DATABASE_URL` itself, and exports an allowlist of functions that a test in the package and a test in the web app both pin by name. Tailwind v4's `@theme` block states the palette once for the whole app, replacing two CSS modules that stated it twice. Every page that depends on who is looking is `force-dynamic` and reads the session cookie server-side, after the middleware.

**Tech Stack:** TypeScript, Next.js 16 (App Router, `output: "standalone"`), Tailwind v4 via `@tailwindcss/postcss`, drizzle-orm over postgres.js, vitest with the per-package test database (`TEST_DATABASE_URL` is a base URL; each package derives `factions_test_<package>`).

**Spec:** `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` §10.1, §10.4, §15 increment 2, §16; `docs/superpowers/specs/2026-09-04-web-frontend-rebuild-design.md` §2–§9 (the first increment there is folded in here, as the target spec's build order says).

## Why increment 2 is three plans

The target spec's increment 2 row names the roster package, the link flow, `/me`, `/claim`, `/base`, the full `/clan` roster with pending members and presence, requests, the directory, the clan page, rename/transfer/disband, `identity_holds`, retiring the slash commands, and the Tailwind rebuild. That is four migrations and every page the site has. It ships as three plans, each behind the gate and deployable on its own:

| Plan | File | Ships |
|---|---|---|
| **2a (this)** | `2026-09-05-site-foundation.md` | Tailwind + `@theme`; prototypes deleted; landing, `/login`, `/join` rebuilt; `packages/roster` with `viewerFor`; `/me` from the database; the deferred sweeps. No new capability for players. |
| 2b | `2026-09-xx-site-link-and-base.md` | `verification_challenges` nullable guild/channel (migration 0021); `startLink`/`cancelLink`/`unlink`; `/link` with autocomplete, 3 emotes, 10 min, 5 s poll; `/base` over `raisedPolesFor`/`declareSolo`/`releaseSolo`; inbox 7's refusal path. |
| 2c | `2026-09-xx-site-roster.md` | membership `status` pending/full, presence promotion, cap, `faction_join_requests`, `identity_holds`, recruiting columns (migration 0022); every roster write in `packages/roster`; `/clan`, `/clans`, `/clans/{tag}`, `/claim/{ceremony}`, `/clan/settings`; slash commands retired in the same deploy; the `/faction` exclusion in `vocabulary.test.ts` removed with them. |

⚠️ 2c is where players gain and lose capability, so it is the one whose deploy retires the slash commands. 2a and 2b add pages beside the commands.

## Global Constraints

- The full gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`. This plan adds one package, so the count goes from **22 to 24** at Task 3. Check the count, not the exit code.
- Plus, for every task that touches `apps/web`: `pnpm --filter @factions/web build` must succeed — Tailwind's compile step and `transpilePackages` are new, and the Docker build is where they would otherwise first fail.
- **`apps/web` imports no `@factions/db`, `drizzle-orm` or `postgres`, and no file under `app/`, `lib/`, `src/` or the package root mentions `DATABASE_URL`.** `packages/roster` owns the client. `smoke.test.ts` keeps holding this literally.
- **`packages/roster` exports exactly its allowlist.** `packages/roster/test/exports.test.ts` and `apps/web/test/smoke.test.ts` both pin the list by name. Adding an export means editing both tests on purpose.
- **Every page that depends on the viewer is `export const dynamic = "force-dynamic"` and reads the session cookie server-side.** Frontend rebuild §7: the middleware gates routes, not build-time content.
- **Player-facing strings say clan**, never faction (target spec §2; inbox 37). Code keeps `faction`. `@factions/...` package names are identifiers.
- **`--color-rust` means an outstanding obligation and nothing else** (frontend §4).
- Every number from `@factions/domain`'s `rules.ts`. No literals.
- Comments say **why**; `⚠️` marks silent failures.
- Lock order (spec §4.12): `factions → declarations → poles → faction_members → …`. This plan writes nothing, but the package's docblock states the order because 2b and 2c will.
- Commit trailer on every commit:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01Svc2Dv7g1XwWi8CSuY4h5e
  ```

---

### Task 1: Tailwind v4 and the palette as one `@theme`

**Files:**
- Modify: `apps/web/package.json` (dependencies)
- Create: `apps/web/postcss.config.mjs`
- Modify: `apps/web/app/globals.css` (rewritten)
- Create: `apps/web/test/theme-tokens.test.ts`
- Delete: `apps/web/test/palette-drift.test.ts`
- Modify: `apps/web/test/smoke.test.ts` (`ROOT_FILES` also scans `.mjs`)

**Interfaces:**
- Produces: the CSS custom properties `--color-ink, --color-ink-2, --color-muted, --color-dim, --color-frame, --color-surface, --color-rule, --color-rule-2, --color-gold, --color-rust, --color-olive, --color-terrain, --color-ground` and `--font-display, --font-sans, --font-mono`, usable as Tailwind utilities (`bg-frame`, `text-ink`, `font-display`, …) by every later task.

- [ ] **Step 1: Write the failing test**

```ts
// apps/web/test/theme-tokens.test.ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Frontend rebuild §4 and §6. The palette used to be stated twice, in two
 * scope-isolated CSS modules, and `palette-drift.test.ts` caught the two
 * disagreeing. Under `@theme` it is stated once — so the drift that test
 * caught can no longer be expressed, and this test guards the new failure
 * mode instead: ⚠️ a token dropped during a port is silent. One screen
 * renders in a browser default and looks merely plain.
 */
const TOKENS: Record<string, string> = {
  "--color-ink": "#e8e2d4",
  "--color-ink-2": "#b5afa4",
  "--color-muted": "#8a857c",
  "--color-dim": "#6e6a62",
  "--color-frame": "#0b0b0a",
  "--color-surface": "#131211",
  "--color-rule": "#1a1917",
  "--color-rule-2": "#2a2825",
  "--color-gold": "#d9a03c",
  "--color-rust": "#8c3a22",
  "--color-olive": "#8fa36a",
  "--color-terrain": "#111110",
  "--color-ground": "#050505",
};

const FACES = ["--font-display", "--font-sans", "--font-mono"];

describe("the @theme block carries the whole palette", () => {
  const css = readFileSync(join(import.meta.dirname, "..", "app", "globals.css"), "utf8");
  const theme = css.match(/@theme\s*\{([\s\S]*?)\n\}/u)?.[1] ?? "";

  it("has a @theme block", () => {
    expect(theme).not.toBe("");
  });

  it.each(Object.entries(TOKENS))("declares %s as %s", (token, value) => {
    expect(theme).toMatch(new RegExp(`${token}\\s*:\\s*${value}\\s*;`, "u"));
  });

  it.each(FACES)("declares %s", (face) => {
    expect(theme).toMatch(new RegExp(`${face}\\s*:`, "u"));
  });

  it("⚠️ states the palette exactly once — no second declaration of --color-gold anywhere in app/", () => {
    // The whole point of @theme. A second `--color-gold:` in any stylesheet
    // or module is the two-statements drift coming back.
    const goldDecls = css.match(/--color-gold\s*:/gu) ?? [];
    expect(goldDecls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @factions/web exec vitest run test/theme-tokens.test.ts`
Expected: FAIL — "has a @theme block" (no `@theme` in `globals.css` yet).

- [ ] **Step 3: Install Tailwind v4 and write the PostCSS config**

Run: `pnpm --filter @factions/web add -D tailwindcss@^4.1.0 @tailwindcss/postcss@^4.1.0`

```js
// apps/web/postcss.config.mjs
// Tailwind v4 is a PostCSS plugin; Next picks this file up with no other wiring.
// ⚠️ .mjs, so smoke.test.ts's ROOT_FILES filter must scan .mjs too — a config
// file scanned by nothing is exactly the hole that test keeps falling into.
export default { plugins: { "@tailwindcss/postcss": {} } };
```

- [ ] **Step 4: Rewrite `globals.css`**

```css
/* apps/web/app/globals.css */
@import "tailwindcss";

/*
 * The palette and faces, stated ONCE for the whole app (frontend rebuild §4).
 * These came off the design canvas via auth.module.css / mobile.module.css,
 * which stated them twice and needed palette-drift.test.ts to keep them
 * honest. Under @theme every screen reads the same token, so that test is
 * gone and theme-tokens.test.ts guards the new failure mode: a token dropped
 * here is a screen rendering in a browser default, silently.
 *
 * ⚠️ --color-rust means an outstanding obligation — a challenge pending or
 * expired — and nothing else. It is the one persistent cue that a player still
 * owes the server something. Never use it as a generic "error" colour.
 */
@theme {
  --color-ink: #e8e2d4;
  --color-ink-2: #b5afa4;
  --color-muted: #8a857c;
  --color-dim: #6e6a62;
  --color-frame: #0b0b0a;
  --color-surface: #131211;
  --color-rule: #1a1917;
  --color-rule-2: #2a2825;
  --color-gold: #d9a03c;
  --color-rust: #8c3a22;
  --color-olive: #8fa36a;
  --color-terrain: #111110;
  /* Page ground, below --color-frame, deliberately. */
  --color-ground: #050505;

  /* app/fonts.ts self-hosts these and sets the --font-archivo* variables on <html>. */
  --font-display: var(--font-archivo-black), system-ui, sans-serif;
  --font-sans: var(--font-archivo), system-ui, sans-serif;
  --font-mono: var(--font-space-mono), ui-monospace, monospace;
}

:root { color-scheme: dark; }

body {
  margin: 0;
  min-height: 100dvh;
  background: var(--color-ground);
  color: var(--color-ink);
  font-family: var(--font-sans);
  -webkit-tap-highlight-color: transparent;
}
```

- [ ] **Step 5: Delete the palette-drift test and widen the smoke scan**

Run: `git rm apps/web/test/palette-drift.test.ts`

In `apps/web/test/smoke.test.ts`, change the `ROOT_FILES` filter from `.filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))` to:

```ts
  // ⚠️ .mjs too: postcss.config.mjs and any future tailwind/next config in
  // that extension. This list has silently missed a new file twice already.
  .filter((f) => (f.endsWith(".ts") || f.endsWith(".mjs")) && !f.endsWith(".d.ts"))
```

- [ ] **Step 6: Run the web tests and the build, commit**

Run: `pnpm --filter @factions/web test && pnpm --filter @factions/web typecheck && pnpm --filter @factions/web build`
Expected: theme-tokens PASS (17 tests); everything else still green; the build compiles Tailwind. (`auth.module.css` and `mobile.module.css` still exist and still declare `--gold` etc. — their variables are named `--gold`, not `--color-gold`, so the "exactly once" test passes; Task 2 deletes them.)

```bash
git add apps/web/package.json apps/web/postcss.config.mjs apps/web/app/globals.css apps/web/test pnpm-lock.yaml
git commit -m "feat(web): Tailwind v4; the palette and faces as one @theme block"
```

---

### Task 2: Delete the prototypes; rebuild the landing, `/login` and `/join`

**Files:**
- Delete: `apps/web/app/mobile/` (all 14 files), `apps/web/app/link/` (all 10 files), `apps/web/app/auth.module.css`
- Modify: `apps/web/app/components/sign-in-card.tsx` (rebuilt on Tailwind)
- Modify: `apps/web/app/layout.tsx`, `apps/web/app/page.tsx`, `apps/web/app/login/page.tsx`, `apps/web/app/join/page.tsx`
- Modify: `apps/web/next.config.ts` (drop the `/mobile` and `/link` noindex headers — the routes no longer exist)
- Create: `apps/web/test/copy-vocabulary.test.ts`
- Modify: `apps/web/README.md` ("What this is today")

**Interfaces:**
- Produces: `<SignInCard step heading body action actionHref footnote error? />` (same props as today, Tailwind classes), `<Shell>` is NOT introduced — `layout.tsx` applies the font variables and ground colour to `<html>`/`<body>`; pages own their layout.

- [ ] **Step 1: Write the failing vocabulary test**

```ts
// apps/web/test/copy-vocabulary.test.ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Inbox 37: the guide says "clan"; every string a player reads on the site
 * must too. Unlike the bot's vocabulary test this scans whole files, not just
 * string literals, because JSX text is not a string literal. Module
 * specifiers (`@factions/roster`) and comments are stripped first; anything
 * left that says faction is player-facing copy or an identifier that leaked
 * into copy — either way, a finding.
 */
const ROOTS = [join(import.meta.dirname, "..", "app")];
const MODULE_SPECIFIERS = /^\s*(?:import|export)\b[^;]*?\bfrom\s+["'][^"']+["'];?|^\s*import\s+["'][^"']+["'];?/gmu;
const COMMENTS = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|\{\/\*[\s\S]*?\*\/\}/gu;

const files = ROOTS.filter(existsSync).flatMap((root) =>
  readdirSync(root, { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
    .map((f) => join(root, f)),
);

describe("site copy says clan, not faction", () => {
  it("has files to scan", () => expect(files.length).toBeGreaterThan(0));
  it.each(files)("%s", (file) => {
    const text = readFileSync(file, "utf8").replace(MODULE_SPECIFIERS, "").replace(COMMENTS, "");
    const hits = [...text.matchAll(/[^\n]*faction[^\n]*/giu)].map((m) => m[0].trim());
    expect(hits).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @factions/web exec vitest run test/copy-vocabulary.test.ts`
Expected: FAIL on `app/layout.tsx` ("Factions, territory…"), `app/page.tsx` ("Found a faction…"), `app/login/page.tsx` ("Your faction, roster and map…"), and the prototype files.

- [ ] **Step 3: Delete the prototypes**

```bash
git rm -r apps/web/app/mobile apps/web/app/link apps/web/app/auth.module.css
```

In `apps/web/next.config.ts`, delete the whole `headers()` function and its docblock (both routes it covered are gone), leaving `output: "standalone"` and the `@factions/domain` comment (Task 4 replaces that comment).

- [ ] **Step 4: Rebuild `layout.tsx`**

```tsx
// apps/web/app/layout.tsx
import type { Metadata } from "next";
import { archivo, archivoBlack, spaceMono } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: "Clan Wars",
  description: "Clans, bases and consequence on a DayZ server.",
};

/**
 * The three font variables ride on <html> so @theme's --font-* tokens
 * resolve everywhere, including portals and the 404 page. Pages own their
 * own layout below this; there is no shared chrome yet.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${archivo.variable} ${archivoBlack.variable} ${spaceMono.variable}`}>
      <body className="bg-ground text-ink font-sans antialiased">{children}</body>
    </html>
  );
}
```

- [ ] **Step 5: Rebuild the sign-in card**

```tsx
// apps/web/app/components/sign-in-card.tsx
/**
 * The 390px card from the `Clan Wars Gamertag Link.dc.html` design canvas,
 * on Tailwind. The touch minimums (44 / 52 / 56px) and the step / headline /
 * body / action / footnote structure are the canvas's, unchanged.
 *
 * ⚠️ The refusal block is NOT rust. Rust means an outstanding obligation
 * (frontend rebuild §4); a failed sign-in owes the server nothing. It uses
 * the stronger rule colour and plain ink instead.
 */
export function SignInCard({
  step,
  heading,
  body,
  action,
  actionHref,
  footnote,
  error,
}: {
  step: string;
  heading: string;
  body: string;
  action: string;
  actionHref: string;
  footnote: string;
  error?: string;
}) {
  return (
    <div className="w-full max-w-[390px] rounded-lg border border-rule bg-frame p-6">
      <div className="font-mono text-xs uppercase tracking-[0.18em] text-muted">{step}</div>
      <h1 className="mt-3 font-display text-3xl leading-tight text-ink">{heading}</h1>
      <p className="mt-3 text-base leading-relaxed text-ink-2">{body}</p>
      {error && (
        <div className="mt-4 rounded-md border border-rule-2 bg-surface p-3" role="alert">
          <div className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Sign-in failed</div>
          <div className="mt-1 text-sm text-ink">{error}</div>
        </div>
      )}
      <a
        className="mt-6 flex min-h-[52px] items-center justify-center rounded-md bg-gold px-4 font-display text-base text-ground"
        href={actionHref}
      >
        {action}
      </a>
      <div className="mt-4 font-mono text-xs leading-relaxed text-muted">{footnote}</div>
    </div>
  );
}
```

- [ ] **Step 6: Rebuild the landing page**

```tsx
// apps/web/app/page.tsx
/**
 * Public. Static is fine here: nothing on this page depends on who is looking.
 * The viewer's own page is /me, which is gated and rendered at request time.
 */
export default function Home() {
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-8">
      <main className="w-full max-w-[34rem] text-center">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-gold">DayZ Clan Wars</p>
        <h1 className="mt-2 font-display text-[clamp(2rem,6vw,3rem)] leading-none text-ink">Clan Wars</h1>
        <p className="mt-4 text-ink-2">
          Found a clan at a flagpole with two friends. Declare a base. Raid other clans to
          climb the scoreboard, and defend your own flag or lose it.
        </p>
        <p className="mt-3 text-ink-2">
          Everything is earned in game and recorded from the server&rsquo;s own log.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3">
          <a
            className="flex min-h-[52px] w-full max-w-[390px] items-center justify-center rounded-md bg-gold px-4 font-display text-ground"
            href="/me"
          >
            Sign in with Discord
          </a>
          <a className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" href="https://discord.gg/TJu4XP25nr">
            Join the Discord
          </a>
        </div>
      </main>
    </div>
  );
}
```

(`/me` is gated; a signed-out visitor pressing "Sign in with Discord" is redirected by the middleware to `/login?next=/me`, which is the flow we want. Task 4 builds `/me`.)

- [ ] **Step 7: Rebuild `/login` and `/join`**

```tsx
// apps/web/app/login/page.tsx
import type { Metadata } from "next";
import { SignInCard } from "../components/sign-in-card";
import { safeNextPath } from "@/lib/auth/next-path";

export const metadata: Metadata = {
  title: "Clan Wars — sign in",
  robots: { index: false, follow: false },
};

/** ⚠️ Never echo the raw ?error= value into the page — it is attacker-supplied. */
const ERRORS: Record<string, string> = {
  state: "That sign-in link expired or did not come from here. Start again.",
  discord: "Discord did not answer. This is usually temporary — try again shortly.",
  banned: "You are banned from the Clan Wars Discord, so we cannot add you to it.",
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);
  const rawError = typeof params.error === "string" ? params.error : "";

  return (
    <div className="flex min-h-dvh flex-col items-center px-4 pb-18 pt-7">
      <SignInCard
        step="Sign in"
        heading="Link your character"
        body="Sign in with the Discord account you use on the server. Your clan, roster and map all hang off this one link."
        action="Continue with Discord"
        actionHref={`/api/auth/discord?next=${encodeURIComponent(next)}`}
        footnote="One character per account. You need to be in the Clan Wars Discord — we will offer to add you if you are not."
        error={ERRORS[rawError]}
      />
    </div>
  );
}
```

```tsx
// apps/web/app/join/page.tsx
import type { Metadata } from "next";
import { SignInCard } from "../components/sign-in-card";
import { safeNextPath } from "@/lib/auth/next-path";

export const metadata: Metadata = {
  title: "Clan Wars — join the Discord",
  robots: { index: false, follow: false },
};

export default async function JoinPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === "string" ? params.next : null);

  return (
    <div className="flex min-h-dvh flex-col items-center px-4 pb-18 pt-7">
      {/*
        ⚠️ The button is the consent. Discord will ask for "Join servers for
        you" on the round this starts, and that prompt should follow something
        the player just pressed rather than arriving unexplained.
      */}
      <SignInCard
        step="One step left"
        heading="Join the Discord"
        body="Clan Wars runs out of its Discord server, and the site is for players who are in it. We can add you now — Discord will ask you to confirm."
        action="Join and continue"
        actionHref={`/api/auth/discord?mode=join&next=${encodeURIComponent(next)}`}
        footnote="You can leave the server at any time from Discord. Leaving also ends your access here."
      />
    </div>
  );
}
```

- [ ] **Step 8: README**

Replace the "What this is today" section of `apps/web/README.md` with:

```markdown
## What this is today

A Next.js 16 (App Router) app on Tailwind v4. Public: the landing page. Gated
behind Discord login and guild membership (`lib/auth`, `middleware.ts`): `/me`,
which shows the viewer's link and clan, read through `@factions/roster`.

**It imports no database package.** `packages/roster` owns the client and
exports only the operations the site is allowed to perform — see the target-
state spec §10.4 and the frontend rebuild spec §2–§3 for the boundary and why
it is a package rather than an HTTP service. `apps/web/test/smoke.test.ts`
pins both halves: the app imports no `@factions/db`, and `@factions/roster`
exports exactly its allowlist.

Rituals are earned in game; administration is not a ritual. The site will
never create a clan, claim a flag or bind a pole. Roster chores land here in
later increments.
```

- [ ] **Step 9: Run the tests and the build, commit**

Run: `pnpm --filter @factions/web test && pnpm --filter @factions/web typecheck && pnpm --filter @factions/web build`
Expected: copy-vocabulary PASS; smoke PASS (the `ROOTS` scan still finds `lib/auth/cookies.ts`); build succeeds with no `/mobile` or `/link` routes.

```bash
git add -A apps/web
git commit -m "feat(web): delete the fixture prototypes; landing, /login and /join on Tailwind; copy says clan"
```

---

### Task 3: `packages/roster` — the capability package, with its first read

**Files:**
- Create: `packages/roster/package.json`, `packages/roster/tsconfig.json`, `packages/roster/vitest.config.ts`
- Create: `packages/roster/src/client.ts`, `packages/roster/src/viewer.ts`, `packages/roster/src/index.ts`
- Test: `packages/roster/test/viewer.test.ts`, `packages/roster/test/exports.test.ts`

**Interfaces:**
- Produces (public, from `@factions/roster`): `viewerFor(discordId: string): Promise<Viewer>` where
  ```ts
  type Viewer = {
    link: { dayzId: string; gamertag: string; verifiedAt: Date } | null;
    clan: { id: number; name: string; tag: string; texture: string; status: string; role: "leader" | "officer" | "member" } | null;
  };
  ```
- Produces (internal, `src/viewer.ts`): `viewerForDb(db: Database, discordId: string): Promise<Viewer>` — tests and later writes use it; it is deliberately NOT exported from `index.ts`.
- Produces (internal, `src/client.ts`): `db(): Database` — lazy, reads `DATABASE_URL`, throws if unset.

- [ ] **Step 1: Scaffold the package**

```json
// packages/roster/package.json
{
  "name": "@factions/roster",
  "version": "0.0.0",
  "type": "module",
  "main": "src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "scripts": { "typecheck": "tsc --noEmit", "test": "vitest run" },
  "dependencies": {
    "@factions/db": "workspace:*",
    "@factions/domain": "workspace:*",
    "drizzle-orm": "^0.36.0"
  },
  "devDependencies": { "typescript": "^5.6.0", "vitest": "^2.1.0" }
}
```

```json
// packages/roster/tsconfig.json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "noEmit": true, "types": ["node"] },
  "include": ["src", "test"]
}
```

```ts
// packages/roster/vitest.config.ts
import { defineConfig } from "vitest/config";

// ⚠️ `globalSetup` creates this package's own test database
// (`factions_test_roster`). Without it the suites cannot connect at all,
// which is the intended failure — see inbox item 21 and packages/db.
export default defineConfig({
  test: {
    fileParallelism: false,
    globalSetup: ["../db/src/test-setup.ts"],
  },
});
```

Run: `pnpm install`

- [ ] **Step 2: Write the failing tests**

```ts
// packages/roster/test/exports.test.ts
import { describe, it, expect } from "vitest";

/**
 * The capability rule (target spec §10.4; frontend rebuild §3). The site can
 * do exactly what this package exports, so the export list IS the
 * permission list. It is pinned by name, in full, and apps/web pins the
 * same list from its side — adding an export means editing both on purpose.
 *
 * ⚠️ An allowlist, not a denylist. A denylist of forbidden names can be
 * dodged by a synonym; an allowlist cannot grow by accident.
 */
export const ROSTER_EXPORTS = ["viewerFor"] as const;

describe("@factions/roster exports exactly its allowlist", () => {
  it("matches", async () => {
    const mod = await import("../src/index.js");
    expect(Object.keys(mod).sort()).toEqual([...ROSTER_EXPORTS].sort());
  });

  it("exports nothing that could set a clan active or dormant, write a raid, or bind a pole", async () => {
    const mod = await import("../src/index.js");
    const names = Object.keys(mod).map((n) => n.toLowerCase());
    for (const bad of ["activate", "dormant", "raid", "defense", "declaration", "reserve", "createfaction", "insert"]) {
      expect(names.filter((n) => n.includes(bad))).toEqual([]);
    }
  });
});
```

```ts
// packages/roster/test/viewer.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import {
  createClient, runMigrations, requireTestDatabaseUrl,
  servers, factions, factionMembers, identityLinks, type Database,
} from "@factions/db";
import { sql } from "drizzle-orm";
import { viewerForDb } from "../src/viewer.js";

const URL = requireTestDatabaseUrl();
const now = new Date("2026-09-05T12:00:00Z");

describe("viewerForDb", () => {
  let db: Database;
  let serverId = 0;

  beforeEach(async () => {
    db = createClient(URL);
    await runMigrations(db);
    await db.execute(sql`truncate table faction_members, factions, identity_links, servers restart identity cascade`);
    const [s] = await db.insert(servers).values({ name: "S", map: "livonia", clockOffsetMs: 0 }).returning();
    serverId = s!.id;
  });

  it("a stranger has no link and no clan", async () => {
    expect(await viewerForDb(db, "d-nobody")).toEqual({ link: null, clan: null });
  });

  it("a linked solo has a link and no clan", async () => {
    await db.insert(identityLinks).values({ discordId: "d1", dayzId: "A".repeat(40), gamertag: "Steve", verifiedAt: now, createdAt: now });
    const v = await viewerForDb(db, "d1");
    expect(v.link).toEqual({ dayzId: "A".repeat(40), gamertag: "Steve", verifiedAt: now });
    expect(v.clan).toBeNull();
  });

  it("a member sees their clan and role", async () => {
    await db.insert(identityLinks).values({ discordId: "d1", dayzId: "A".repeat(40), gamertag: "Steve", verifiedAt: now, createdAt: now });
    const [f] = await db.insert(factions).values({
      serverId, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", leaderDiscordId: "d1", createdAt: now,
    }).returning();
    await db.insert(factionMembers).values({ factionId: f!.id, serverId, dayzId: "A".repeat(40), discordId: "d1", role: "leader", joinedAt: now });
    const v = await viewerForDb(db, "d1");
    expect(v.clan).toEqual({ id: f!.id, name: "Bears", tag: "BEAR", texture: "Flag_Bear", status: "active", role: "leader" });
  });

  it("⚠️ a disbanded clan is not the viewer's clan", async () => {
    // HOLDING_STATUSES is the predicate. A roster row left behind on a
    // disbanded faction (there should be none — disband deletes them — but
    // the read must not depend on that) is not a clan the viewer is in.
    await db.insert(identityLinks).values({ discordId: "d1", dayzId: "A".repeat(40), gamertag: "Steve", verifiedAt: now, createdAt: now });
    const [f] = await db.insert(factions).values({
      serverId, name: "Gone", tag: "GONE", texture: "Flag_Wolf", status: "disbanded", leaderDiscordId: "d1", createdAt: now,
    }).returning();
    await db.insert(factionMembers).values({ factionId: f!.id, serverId, dayzId: "A".repeat(40), discordId: "d1", role: "member", joinedAt: now });
    expect((await viewerForDb(db, "d1")).clan).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/roster test`
Expected: FAIL — cannot find `../src/index.js` / `../src/viewer.js`.

- [ ] **Step 4: Write the package**

```ts
// packages/roster/src/client.ts
import { createClient, type Database } from "@factions/db";

let cached: Database | null = null;

/**
 * The ONE database client the site has. It lives here so that `apps/web`
 * never names DATABASE_URL or imports @factions/db — smoke.test.ts holds both
 * lines — and so the connection pool is shared across every request in the
 * standalone server rather than opened per page.
 *
 * ⚠️ Throws when DATABASE_URL is unset rather than falling back. A web
 * container without the variable must fail its first page load loudly, not
 * render empty states that read as "you have no clan".
 */
export function db(): Database {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL is not set. @factions/roster cannot read anything without it.");
  }
  cached = createClient(url);
  return cached;
}
```

```ts
// packages/roster/src/viewer.ts
import type { Database } from "@factions/db";
import { factions, factionMembers, identityLinks } from "@factions/db";
import { HOLDING_STATUSES } from "@factions/domain";
import { and, asc, eq, inArray } from "drizzle-orm";

export type Role = "leader" | "officer" | "member";

export type Viewer = {
  link: { dayzId: string; gamertag: string; verifiedAt: Date } | null;
  clan: { id: number; name: string; tag: string; texture: string; status: string; role: Role } | null;
};

/**
 * Who is looking (target spec §10.1). Everything the site renders for a
 * signed-in player hangs off this: `link` decides "linked", `clan` decides
 * "clan-level".
 *
 * ⚠️ Increment 2c adds `faction_members.status`; when it does, `clan` must
 * require `status = 'full'` — a pending member is not a clan-level viewer
 * (spec §10.1). Until then every roster row is a full member.
 */
export async function viewerForDb(db: Database, discordId: string): Promise<Viewer> {
  const [link] = await db.select({
    dayzId: identityLinks.dayzId, gamertag: identityLinks.gamertag, verifiedAt: identityLinks.verifiedAt,
  }).from(identityLinks).where(eq(identityLinks.discordId, discordId));

  // One clan per player per server; this deployment has one server. Ordered
  // so a second server would still give a deterministic answer.
  const [clan] = await db.select({
    id: factions.id, name: factions.name, tag: factions.tag, texture: factions.texture,
    status: factions.status, role: factionMembers.role,
  }).from(factionMembers)
    .innerJoin(factions, eq(factions.id, factionMembers.factionId))
    .where(and(eq(factionMembers.discordId, discordId), inArray(factions.status, [...HOLDING_STATUSES])))
    .orderBy(asc(factions.id))
    .limit(1);

  return {
    link: link ?? null,
    clan: clan ? { ...clan, role: clan.role as Role } : null,
  };
}
```

```ts
// packages/roster/src/index.ts
/**
 * @factions/roster — what the site is allowed to do (target spec §10.4).
 *
 * `apps/web` imports this and never @factions/db. The export list below IS
 * the permission list; test/exports.test.ts pins it by name and so does
 * apps/web/test/smoke.test.ts. Nothing here may ever set a clan active or
 * dormant, write a raid or a defense, insert a declaration without citing
 * evidence the log already holds, or create a faction without a ceremony.
 *
 * Lock order for the writes that land in increments 2b and 2c (spec §4.12):
 * factions → declarations → poles → faction_members → faction_invites →
 * faction_join_requests → … → faction_events. Every write appends its feed
 * or notice row in the transition's own transaction.
 */
import { db } from "./client.js";
import { viewerForDb, type Viewer, type Role } from "./viewer.js";

export type { Viewer, Role };

/** Who is looking: their link and their clan, or null for either. */
export function viewerFor(discordId: string): Promise<Viewer> {
  return viewerForDb(db(), discordId);
}
```

Check `HOLDING_STATUSES` is exported from `@factions/domain` (`packages/domain/src/factions.ts`); it is a readonly tuple, hence the spread.

- [ ] **Step 5: Run the package tests, then the full gate**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/roster test && pnpm --filter @factions/roster typecheck`
Expected: PASS, 6 tests.

Run the full gate. Expected: **`Tasks: 24 successful, 24 total`** (roster adds typecheck + test).

- [ ] **Step 6: Commit**

```bash
git add packages/roster pnpm-lock.yaml
git commit -m "feat(roster): the capability package, with viewerFor as its first export"
```

---

### Task 4: `/me` reads the viewer through `@factions/roster`

**Files:**
- Modify: `apps/web/package.json` (add `@factions/roster`)
- Modify: `apps/web/next.config.ts` (`transpilePackages`, `serverExternalPackages`)
- Create: `apps/web/lib/viewer.ts`
- Create: `apps/web/app/me/page.tsx`
- Modify: `apps/web/test/smoke.test.ts` (capability half)
- Create: `apps/web/test/request-time-rendering.test.ts`
- Modify: `docker-compose.yml` (web gets `DATABASE_URL`)

**Interfaces:**
- Consumes: `viewerFor(discordId)` from `@factions/roster`; `decodeSession`, `sessionKey` from `lib/auth/session`; `SESSION_COOKIE` from `lib/auth/cookies`.
- Produces: `currentSession(): Promise<Session | null>` in `apps/web/lib/viewer.ts` — the one place a server component reads the cookie.

- [ ] **Step 1: Write the failing tests**

Add to `apps/web/test/smoke.test.ts`, inside the existing `describe`:

```ts
  it("⚠️ @factions/roster exports exactly the allowlist the site is permitted", async () => {
    // The capability rule (frontend rebuild §6; target spec §10.4). This is
    // the site's half of the pin; packages/roster/test/exports.test.ts is
    // the package's. Both must change for an export to land.
    const roster = await import("@factions/roster");
    expect(Object.keys(roster).sort()).toEqual(["viewerFor"]);
  });
```

```ts
// apps/web/test/request-time-rendering.test.ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Frontend rebuild §7, the static-rendering trap: middleware.ts gates routes,
 * not content. A gated page that is built statically bakes its data into a
 * chunk under /_next/static that anyone can fetch. ⚠️ There is no error, log
 * line or runtime signal for this — so it is pinned structurally: every page
 * that reads the viewer must opt out of static rendering.
 */
const APP = join(import.meta.dirname, "..", "app");
const pages = readdirSync(APP, { recursive: true, encoding: "utf8" })
  .filter((f) => f.endsWith("page.tsx"))
  .map((f) => join(APP, f))
  .filter((f) => existsSync(f));

describe("pages that depend on the viewer render at request time", () => {
  const viewerPages = pages.filter((f) => readFileSync(f, "utf8").includes("currentSession("));
  it("finds at least /me", () => {
    expect(viewerPages.some((f) => f.endsWith(`${join("me", "page.tsx")}`))).toBe(true);
  });
  it.each(viewerPages)("%s is force-dynamic", (file) => {
    expect(readFileSync(file, "utf8")).toMatch(/export const dynamic = "force-dynamic"/u);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `pnpm --filter @factions/web exec vitest run test/smoke.test.ts test/request-time-rendering.test.ts`
Expected: FAIL — `@factions/roster` not resolvable; no page contains `currentSession(`.

- [ ] **Step 3: Wire the dependency and Next config**

Run: `pnpm --filter @factions/web add @factions/roster@workspace:*`

```ts
// apps/web/next.config.ts
import type { NextConfig } from "next";

const config: NextConfig = {
  // ⚠️ Required by apps/web/Dockerfile. The standalone output is a
  // self-contained server directory; without it the runtime image would need
  // the whole pnpm workspace and its node_modules copied in.
  output: "standalone",

  // ⚠️ Every @factions/* package is raw TypeScript (`exports: "./src/index.ts"`),
  // not a built package. @factions/roster pulls in @factions/db and
  // @factions/domain transitively, so all three are listed — a missing one
  // fails `next build` on a package it doesn't know how to compile.
  transpilePackages: ["@factions/roster", "@factions/db", "@factions/domain"],

  // postgres.js is a Node driver with no browser build; keep it external to
  // the server bundle rather than letting Next try to compile it.
  serverExternalPackages: ["postgres"],
};

export default config;
```

- [ ] **Step 4: The session reader and `/me`**

```ts
// apps/web/lib/viewer.ts
import { cookies } from "next/headers";
import { SESSION_COOKIE } from "./auth/cookies";
import { decodeSession, sessionKey, type Session } from "./auth/session";

/**
 * The signed-in viewer, from the session cookie, for server components.
 *
 * ⚠️ Call this only from a page that is `force-dynamic`. It reads a request
 * cookie, which Next forbids at build time — but a page that could be built
 * statically and merely happened to call this at request time would still
 * have the static-rendering trap (frontend rebuild §7) one refactor away.
 * test/request-time-rendering.test.ts pins the pairing.
 *
 * The middleware has already run: a null here means the cookie was tampered
 * with or the secret rotated, not that the visitor is anonymous.
 */
export async function currentSession(): Promise<Session | null> {
  const jar = await cookies();
  const raw = jar.get(SESSION_COOKIE)?.value ?? "";
  return decodeSession(raw, sessionKey(process.env.SESSION_SECRET ?? ""));
}
```

```tsx
// apps/web/app/me/page.tsx
import type { Metadata } from "next";
import { viewerFor } from "@factions/roster";
import { currentSession } from "@/lib/viewer";

export const metadata: Metadata = {
  title: "Clan Wars — you",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

export default async function MePage() {
  const session = await currentSession();
  if (!session) {
    // The middleware admitted this request, so the cookie was valid a moment
    // ago. Say what happened rather than rendering an empty page.
    return (
      <main className="mx-auto max-w-[34rem] px-4 py-10">
        <p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/me">Sign in again</a>.</p>
      </main>
    );
  }
  const viewer = await viewerFor(session.sub);

  return (
    <main className="mx-auto max-w-[34rem] px-4 py-10">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Signed in as</p>
      <h1 className="mt-1 font-display text-3xl text-ink">{session.name}</h1>

      <section className="mt-8 rounded-lg border border-rule bg-frame p-5">
        <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Your character</h2>
        {viewer.link ? (
          <p className="mt-2 text-ink">
            Linked to <span className="font-mono">{viewer.link.gamertag}</span>
          </p>
        ) : (
          <p className="mt-2 text-ink-2">
            Not linked yet. Linking moves here from Discord soon; until then, use <span className="font-mono">/link</span> in the Discord.
          </p>
        )}
      </section>

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Your clan</h2>
        {viewer.clan ? (
          <p className="mt-2 text-ink">
            <span className="font-display">{viewer.clan.name}</span>{" "}
            <span className="font-mono text-ink-2">[{viewer.clan.tag}]</span> — {viewer.clan.role}
            {viewer.clan.status === "dormant" && <span className="ml-2 font-mono text-xs uppercase text-muted">dormant</span>}
            {viewer.clan.status === "reserved" && <span className="ml-2 font-mono text-xs uppercase text-muted">reserved</span>}
          </p>
        ) : (
          <p className="mt-2 text-ink-2">You are not in a clan.</p>
        )}
      </section>

      <p className="mt-8 font-mono text-xs text-muted">
        Player tools land here over the coming increments. Nothing on this page is invented: it is what the server log has recorded.
      </p>
      {/* The logout route is POST-only (app/api/auth/logout/route.ts), so a form, not a link. */}
      <form className="mt-4" action="/api/auth/logout" method="post">
        <button className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" type="submit">Sign out</button>
      </form>
    </main>
  );
}
```

- [ ] **Step 5: The web container gets the database**

In `docker-compose.yml`, in the `web` service's `environment`, add directly under `NODE_ENV: production`:

```yaml
      # ⚠️ factions_live, NOT factions — the test suites truncate `factions`.
      # Read ONLY through @factions/roster; apps/web itself never names this
      # variable (smoke.test.ts). Same string the bot and worker use.
      DATABASE_URL: postgres://factions:factions@postgres:5432/factions_live
```

and add `depends_on: { postgres: { condition: service_healthy } }` to the `web` service if it lacks one (the worker's block shows the shape).

- [ ] **Step 6: Run the tests and the build, then the gate**

Run: `pnpm --filter @factions/web test && pnpm --filter @factions/web typecheck && pnpm --filter @factions/web build`
Expected: smoke (7 tests), request-time-rendering (2), copy-vocabulary, theme-tokens all PASS; `next build` compiles the three transpiled packages and reports `/me` as dynamic (ƒ) and `/` as static (○).

Run the full gate: `Tasks: 24 successful, 24 total`.

- [ ] **Step 7: Commit**

```bash
git add apps/web docker-compose.yml pnpm-lock.yaml
git commit -m "feat(web): /me reads the viewer's link and clan through @factions/roster, at request time"
```

---

### Task 5: The sweeps deferred from increments 0 and 1

**Files:**
- Modify: `apps/bot/test/vocabulary.test.ts` (`PLAYER_FACING` gains two files)
- Modify: `apps/bot/src/faction-commands.ts`, `apps/bot/src/rebind-commands.ts` (strings say clan)
- Modify: `scripts/guide-numbers.ts` (paths from `import.meta.dirname`)
- Modify: `apps/bot/README.md` (three env rows)

- [ ] **Step 1: Extend the vocabulary test and watch it fail**

In `apps/bot/test/vocabulary.test.ts`:

```ts
const PLAYER_FACING = [
  "feed-embed.ts", "ceremony-notify.ts", "dormancy-notify.ts", "notify.ts",
  // Increment 2a: the claim and rebind command replies reach players too.
  // roster-commands.ts is retired whole in increment 2c and is not swept.
  "faction-commands.ts", "rebind-commands.ts",
];
```

Run: `pnpm --filter @factions/bot exec vitest run test/vocabulary.test.ts`
Expected: FAIL on the two new files, listing every offending literal.

- [ ] **Step 2: Sweep the strings**

For each literal the test lists in `faction-commands.ts` (about 4) and `rebind-commands.ts` (about 15): replace the word faction with clan in the player-facing sentence, keeping `/faction …` command names untouched (the test already strips the `/faction` token). Typical: "another faction" → "another clan"; "your faction" → "your clan"; "The faction" → "The clan". Do not change the meaning of any sentence; do not touch identifiers.

Run the test again: PASS. Then run the command suites that assert on reply text:

`TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot exec vitest run test/faction-commands.test.ts test/rebind-commands.test.ts test/faction-wiring.test.ts test/rebind-discord.test.ts`

Fix any assertion that quoted the old wording.

- [ ] **Step 3: `scripts/guide-numbers.ts` stops depending on the cwd**

Replace the two path lines:

```ts
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Repo root, from this file's own location — not from the cwd, which under
// turbo, pnpm --filter and a worktree checkout is three different places.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = process.argv[2] ?? resolve(ROOT, "..", "field-guide", "numbers.html");
```

and the write target to `resolve(ROOT, "docs", "guide-numbers.json")`. Update the docblock's usage lines to say the default reads `../field-guide/numbers.html` relative to the repo root.

Run: `pnpm guide:numbers` from the repo root, then `git diff --stat docs/guide-numbers.json` — only `generatedAt` changes. Run it once more from `packages/domain` (`cd packages/domain && pnpm -w guide:numbers`) to prove the cwd no longer matters. Then `git checkout docs/guide-numbers.json` (the regenerated file is identical except the timestamp; do not commit churn).

- [ ] **Step 4: README rows**

In `apps/bot/README.md`'s environment table, after the `BOT_RENAME_COOLDOWN_MS` row, add:

```markdown
| `BOT_DORMANT_AFTER_MS` | no (default `604800000`, 7 days) | How long without a member raising the clan's flag at its pole before the clan goes dormant. Default from `packages/domain/src/rules.ts` (`DORMANT_AFTER_MS`). Plain decimal digits only. |
| `BOT_DISBAND_AFTER_DORMANT_MS` | no (default `1209600000`, 14 days) | How long a clan stays dormant before it is disbanded. Default from `packages/domain/src/rules.ts` (`DISBAND_AFTER_DORMANT_MS`). Plain decimal digits only. |
| `BOT_REBIND_COOLDOWN_MS` | no (default `604800000`, 7 days) | The minimum time between two base moves of the same clan. Default from `packages/domain/src/rules.ts` (`REBIND_COOLDOWN_MS`). Plain decimal digits only. |
```

and the same three keys with those defaults to the `.env` example block below it.

- [ ] **Step 5: Gate and commit**

Run the full gate: `Tasks: 24 successful, 24 total`.

```bash
git add apps/bot scripts/guide-numbers.ts
git commit -m "chore: sweep the claim and rebind replies to clan; guide-numbers.ts is cwd-independent; README env rows"
```

---

### Task 6: CLAUDE.md, the spec's build order, the inbox, and the deploy note

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` (§15 table)
- Modify: `docs/superpowers/plans/PLAN-3-INBOX.md` (item 37)
- Create: `docs/deploy/2026-09-05-site-foundation.md`

- [ ] **Step 1: CLAUDE.md**

- Under "⚠️ Read this before touching anything", find the bullet **"The website is a surface, never a source of truth"** and rewrite it to record frontend rebuild §2: rituals (founding, claiming a flag, binding a pole) are earned in game and never done from the web; administration (roster chores) is permitted from the web through `packages/roster`; the boundary is the package's export allowlist, pinned by `packages/roster/test/exports.test.ts` and `apps/web/test/smoke.test.ts`; and the `evidence_*` NOT NULL pair on `declarations` is the guard the export list leans on (target spec §16).
- Under the lock-order bullet, add: "`packages/roster` is the fifth roster writer and the first outside the bot process. It holds no writes yet (increment 2a); 2b and 2c add them, every one appending its feed or notice row in the transition's own transaction."
- Under "two statements of one fact will drift" (or the tests list), replace the `palette-drift.test.ts` line with: "`apps/web/test/theme-tokens.test.ts` — the `@theme` block against the palette; a dropped token renders a browser default silently."
- In "Running things", note that the web container now needs `DATABASE_URL` and that `apps/web` reads it only through `@factions/roster`.
- In "Current state", add: "Increment 2a (site foundation) landed: Tailwind, `packages/roster` with `viewerFor`, `/me` from the database. No new player capability; the slash commands still run."

- [ ] **Step 2: The spec's build order**

In §15's table, replace the single increment 2 row with three rows — 2a `2026-09-05-site-foundation.md` (this plan's "Ships" text), 2b `2026-09-xx-site-link-and-base.md`, 2c `2026-09-xx-site-roster.md` — using the "Why increment 2 is three plans" table at the top of this plan verbatim, and keep the ⚠️ paragraph below the table pointing at 2c as the deploy that retires the slash commands. Update the "Depends on" column: 2a → 1; 2b → 2a; 2c → 2b; and every later row that said "2" now says "2c".

- [ ] **Step 3: Inbox item 37**

Retitle to `## 37. ~~`apps/web` player copy still says "faction"~~ — DONE 2026-09-05` and append one line: "Closed by increment 2a: the prototypes are deleted, the rebuilt pages say clan, and `apps/web/test/copy-vocabulary.test.ts` scans every file under `app/`."

- [ ] **Step 4: The deploy note**

```markdown
# Site foundation — deploy note

No migration. The web container gains one environment variable and its first
database read.

1. Read `docker-compose.yml`'s `web` service: `DATABASE_URL` points at
   `factions_live` on the compose network. Confirm `depends_on: postgres`.
2. Build: `docker compose build web`. The build compiles Tailwind and the three
   transpiled `@factions/*` packages; a failure here is the build, not the deploy.
3. `docker compose up -d web`. Watch `docker compose logs -f web` for the
   standalone server's ready line.
4. Acceptance, in a browser signed in as a linked member: `/me` shows the
   gamertag from `identity_links` and the clan from `faction_members`. Signed
   out, `/me` redirects to `/login?next=/me`. `/mobile` and `/link` are 404.
5. ⚠️ If `/me` renders "Your session could not be read" for everyone,
   `SESSION_SECRET` in the web container differs from the one the cookies
   were signed with — nothing is wrong with the database.
```

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md docs
git commit -m "docs: increment 2 split into 2a/2b/2c; CLAUDE.md records the web write boundary and the roster package"
```

---

## Self-review

- **Spec coverage.** Frontend rebuild §8 steps 1–5: Tailwind + `@theme` (Task 1); prototypes deleted (Task 2); landing rebuilt (Task 2); `/login` + `/join` rebuilt from the card's structure (Task 2); signed-in page rendering the viewer's Discord identity at request time (Task 4 — `/me`, from the database rather than a placeholder, which is what the target spec's §10.2 asks for and costs one read). Frontend §6: `palette-drift` deleted, `theme-tokens` added, smoke extended then rewritten to the capability rule (Tasks 1, 4). Frontend §9 and target §16 CLAUDE.md consequences (Task 6). Target §10.4's package with the first export and both pins (Tasks 3, 4). The deferred sweeps from increments 0 and 1: vocabulary files, `guide-numbers.ts` paths, README rows (Task 5); web copy (Task 2). **Deliberately not here:** the `/faction` token exclusion in `vocabulary.test.ts` (leaves with the commands, 2c); `roster-commands.ts` strings (retired whole, 2c); every write, every migration (2b, 2c).
- **Placeholders.** None: every code step carries the code. The logout route is POST-only and the page uses a form accordingly.
- **Type consistency.** `Viewer`/`Role` defined in Task 3 `viewer.ts`, re-exported from `index.ts`, consumed by Task 4's page; `viewerForDb(db, discordId)` internal, `viewerFor(discordId)` public; `currentSession()` defined in Task 4 `lib/viewer.ts` and matched by name in `request-time-rendering.test.ts`; the export allowlist `["viewerFor"]` appears identically in `exports.test.ts` and `smoke.test.ts`.
- **Gate arithmetic.** 22 tasks today; `packages/roster` adds `typecheck` and `test` → 24 from Task 3 onward.
