# Site Roster (increment 2c-b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The site becomes the tool: `/clans`, `/clans/{tag}`, `/clan`, `/clan/settings`, `/claim/{ceremony}` and a fuller `/me`, all over the 34 `@factions/roster` exports; every Discord slash command is retired in the same deploy and answers with one line and a link.

**Architecture:** Pages are React server components rendered per request (`force-dynamic`) that call `@factions/roster` reads; every write is a plain HTML `<form method="post">` to a route handler under `apps/web/app/api/**` that calls one `@factions/roster` write and 303-redirects back with a `?result=` code the page looks up in a copy table (the `/base` pattern from increment 2b, generalised by one `formAction` helper). No client JavaScript is added. The bot keeps registering its four command names so a stale Discord client gets a pointer instead of "unknown command", but every handler, button, select and autocomplete behind them is deleted; the ceremony DM points at `/claim/{id}`.

**Tech Stack:** Next 16 (App Router, Turbopack), React 19, Tailwind v4 `@theme` tokens, `@factions/roster` (raw TS, transpiled), discord.js in `apps/bot`, vitest.

**Spec:** `docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md` — §9.1 (commands retired), §10.1 (access levels), §10.2 (routes), §10.4 (capability package), §5.1 (reserved → active), §5.3 (pending), §14 (hazards), §15 row 2c-b. Increment 2c-a's plan (`2026-09-05-roster-package.md`) built the package this plan consumes.

## Global Constraints

- **`apps/web` imports `@factions/roster` and never `@factions/db`, `drizzle-orm`, `postgres` or `@factions/roster/internal`** (`apps/web/test/smoke.test.ts`). Adding a roster export means re-pinning BOTH `packages/roster/test/exports.test.ts` and `apps/web/test/smoke.test.ts`; this plan adds none — the pin stays at the 34 names.
- **Every page that reads the viewer or the database is `export const dynamic = "force-dynamic"`** (spec §10.1; `request-time-rendering.test.ts`). A page that renders live data statically bakes it into a public chunk at build time, or fails `next build` against no database.
- **Access levels (spec §10.1):** public = no session; linked = session + `identity_links` row; clan = linked + a `full` roster row. **A pending member is not a clan-level viewer.** The middleware gates every path not in `PUBLIC_PATHS`/`PUBLIC_PREFIXES`; pages do the linked/clan distinction themselves from what the package returns.
- **Every rule lives in the package's writes, never in a page** (spec §10.4 ⚠️): cap, cooldowns, 200 m, name/tag holds, authority. A route handler validates shape (a string is a string, an id is digits) and nothing else.
- **Copy says "clan", never "faction"** in anything a player reads (`apps/web/test/copy-vocabulary.test.ts` scans every file under `app/`, `src/`, `lib/`; `apps/bot/test/vocabulary.test.ts` scans player-facing bot modules). Identifiers like `faction_members` are exempt.
- **No literal restates a `rules.ts` number.** `CLAN_SIZE_CAP`, `JOIN_PRESENCE_RADIUS_M`, `PENDING_EXPIRY_MS`, `ROSTER_COOLDOWN_MS`, `RENAME_COOLDOWN_MS`, `REBIND_CONFIRM_MS`, `REBIND_COOLDOWN_MS`, `ACTIVATION_WINDOW_MS`, `CLAN_NAME_LENGTH`, `CLAN_TAG_LENGTH`, `MIN_BASE_SPACING_M`, `RELEASED_POLE_GRACE_MS`, `FLAG_POOL_SIZE` come from `@factions/domain`.
- **Query-string codes are looked up, never echoed** — `lookupCopy` (`Object.hasOwn`) from `apps/web/lib/copy-lookup.ts`, so `?result=__proto__` misses.
- **Mutating routes are POST only** (an `<img>` can trigger a GET). Personal reads carry `Cache-Control: no-store, private`.
- **No coordinate reaches a page other than the viewer's own `/base`.** Nothing in this plan renders `x`, `y`, `z` or a pole position; `rebindCandidates` carry pole keys only.
- **The slash commands are retired in the same deploy as the pages that replace them, never before** (spec §15 ⚠️). The runbook deploys bot and web together.
- **Relative imports inside `packages/*/src` are extensionless** (`transpiled-imports.test.ts`).
- **Full gate:** from the repo root, `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` → **26 successful, 26 total**. Never touch `factions_live`.
- **Commits** end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` and `Claude-Session: https://claude.ai/code/session_01Svc2Dv7g1XwWi8CSuY4h5e`.

## File structure

**Roster package (two small changes, no new exports)**
- `packages/roster/src/writes.ts` — `inviteDb` accepts the invitee by Discord id **or by gamertag** (the site has no Discord picker); `packages/roster/src/index.ts` `invite` widens accordingly.
- `packages/roster/src/internal/rebind.ts` — `REBIND_WINDOW_MS` (the bot's 1 h) deleted; `selectCandidates` requires `windowMs`.

**Web — shared**
- `apps/web/lib/auth/gate.ts` — `/clans` and `/clans/` become public.
- `apps/web/lib/form.ts` — `formAction`, `text`, `id`, `confirmed`: the one shape every write route has.
- `apps/web/lib/clan-copy.ts` — every `?result=` code the roster routes can redirect with, typed against the package's outcome unions so a new outcome fails typecheck until it has copy.
- `apps/web/lib/clan-limits.ts` — field lengths for the recruiting post (site-owned, not guide numbers).
- `apps/web/lib/format.ts` — `when(date)`, `days(ms)` shared by the pages (today duplicated in `/base` and `base-copy.ts`).

**Web — pages and routes**
- `apps/web/app/clans/page.tsx` (public directory), `apps/web/app/clans/[tag]/page.tsx` (public clan page), `apps/web/app/api/clans/[tag]/request/route.ts`.
- `apps/web/app/me/page.tsx` (pending banner, invites, requests, claim link), `apps/web/app/api/me/invite/accept/route.ts`, `.../invite/decline/route.ts`, `.../request/withdraw/route.ts`.
- `apps/web/app/claim/[ceremony]/page.tsx`, `apps/web/app/api/claim/route.ts`.
- `apps/web/app/clan/page.tsx`, `apps/web/app/api/clan/{invite,revoke-invite,decide-request,leave,kick,promote,demote}/route.ts`.
- `apps/web/app/clan/settings/page.tsx`, `apps/web/app/api/clan/{recruiting,rename,transfer,disband,rebind}/route.ts`.

**Bot**
- `apps/bot/src/retired-commands.ts` — the one-line reply and the path each retired command points at.
- `apps/bot/src/discord.ts` — four bare commands registered; every interaction answers with the retired line; the handlers, buttons, selects, autocompletes and DM delivery deleted.
- Deleted: `apps/bot/src/{roster-commands,faction-commands,rebind-commands,roster-context}.ts` and their tests; the `/link`, `/unlink`, `/whoami` handlers in `commands.ts`.
- `apps/bot/src/config.ts` — `SITE_BASE_URL`; the retired commands' env vars removed.
- `apps/bot/src/ceremony-notify.ts` — the DM points at `/claim/{id}`.
- `apps/bot/test/vocabulary.test.ts` — the `/faction` exclusion removed.

**Docs**
- `docs/deploy/2026-09-05-site-roster.md`, `CLAUDE.md`, `apps/bot/README.md`, spec §15.

---

### Task 1: Roster package — invite by gamertag; the 1 h rebind window goes

**Files:**
- Modify: `packages/roster/src/writes.ts:20-30` (`inviteDb`), `packages/roster/src/index.ts` (`invite`), `packages/roster/src/internal/rebind.ts:28-62`, `packages/roster/src/internal/index.ts` (if it re-exports `REBIND_WINDOW_MS`)
- Test: `packages/roster/test/writes.test.ts`, `apps/bot/test/rebind.test.ts`

**Interfaces:**
- Produces: `invite(actorDiscordId: string, invitee: { discordId: string } | { gamertag: string }): Promise<{ outcome: InviteOutcome; inviteId: number | null }>` — `"invitee-not-linked"` when the gamertag matches no `identity_links` row (case-insensitive on `gamertag`). `selectCandidates(raises, { currentPoleKey, now, windowMs })` — `windowMs` required; `REBIND_WINDOW_MS` no longer exists anywhere.

- [ ] **Step 1: Failing tests**

`packages/roster/test/writes.test.ts` — beside the existing invite test (reuse its fixture: a clan, a linked officer/leader, a linked outsider with gamertag `"Steve"`):
```ts
  it("invites by gamertag, case-insensitively, and refuses a gamertag nobody has linked", async () => {
    const byTag = await inviteDb(db, now, LEADER_DISCORD, { gamertag: "steve" });
    expect(byTag.outcome).toBe("ok");
    expect(byTag.inviteId).not.toBeNull();
    const nobody = await inviteDb(db, now, LEADER_DISCORD, { gamertag: "NoSuchPlayer" });
    expect(nobody).toEqual({ outcome: "invitee-not-linked", inviteId: null });
  });
```
`apps/bot/test/rebind.test.ts` — replace every `REBIND_WINDOW_MS` with a local `const WINDOW_MS = 3_600_000;` passed as `windowMs` in `opts`, and drop `REBIND_WINDOW_MS` from the import. The existing boundary tests (`ago(WINDOW_MS + 1)` → `[]`, `ago(WINDOW_MS)` → one) keep their meaning: they test the edge, whatever the window.

- [ ] **Step 2: Run to see them fail**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/roster exec vitest run test/writes.test.ts` → the new test fails on the argument shape (typecheck) or on `invitee-not-linked` for `{ gamertag }`. `pnpm --filter @factions/bot exec tsc --noEmit -p .` fails on the missing export once Step 3 lands.

- [ ] **Step 3: Implement**

`packages/roster/src/writes.ts`:
```ts
export type InviteeRef = { discordId: string } | { gamertag: string };
export async function inviteDb(db: Database, now: Date, actorDiscordId: string, invitee: InviteeRef): Promise<{ outcome: InviteOutcome; inviteId: number | null }> {
  const a = await actorFor(db, actorDiscordId);
  if (isRefusal(a)) return { outcome: a, inviteId: null };
  // The site invites by gamertag — it has no Discord user picker — and the
  // link row is the ONLY place a gamertag maps to a Discord account.
  const where = "discordId" in invitee
    ? eq(identityLinks.discordId, invitee.discordId)
    : sql`lower(${identityLinks.gamertag}) = lower(${invitee.gamertag})`;
  const [link] = await db.select({ dayzId: identityLinks.dayzId, discordId: identityLinks.discordId }).from(identityLinks).where(where);
  if (!link) return { outcome: "invitee-not-linked", inviteId: null };
  return new PgRosterStore(db).createInvite({
    factionId: a.factionId, serverId: a.serverId, inviteeDiscordId: link.discordId, inviteeDayzId: link.dayzId, invitedByDiscordId: a.discordId,
    at: now, expiresAt: new Date(now.getTime() + PENDING_EXPIRY_MS),
  });
}
```
`packages/roster/src/index.ts`:
```ts
/** Invite a linked player to your clan, by Discord id or by gamertag. Officer+ only; the invitee must already be linked. */
export function invite(actorDiscordId: string, invitee: InviteeRef): Promise<{ outcome: InviteOutcome; inviteId: number | null }> {
  return inviteDb(db(), new Date(), actorDiscordId, invitee);
}
```
and add `InviteeRef` to the `export type { … }` line for `InviteOutcome`. Update the existing invite test's call sites from `inviteDb(db, now, actor, "discord-id")` to `inviteDb(db, now, actor, { discordId: "discord-id" })`.

`packages/roster/src/internal/rebind.ts`: delete the `REBIND_WINDOW_MS` constant and its docblock; change the signature to `opts: { currentPoleKey: string | null; now: Date; windowMs: number }` and the body to `const cutoff = opts.now.getTime() - opts.windowMs;`. Fix the docblock above `selectCandidates` to say the window is the caller's (the site passes `REBIND_CONFIRM_MS`). Remove `REBIND_WINDOW_MS` from `packages/roster/src/internal/index.ts` if it re-exports it (`grep -rn REBIND_WINDOW_MS packages apps` must return nothing after this step). `writes.ts` and `reads.ts` already pass `windowMs: REBIND_CONFIRM_MS`; `apps/bot/src/rebind-commands.ts` still compiles against the default — leave it, Task 8 deletes the file. Until then it must pass `windowMs` explicitly: add `windowMs: REBIND_WINDOW_LOCAL` where `const REBIND_WINDOW_LOCAL = 3_600_000;` sits at the top of `rebind-commands.ts` with the comment `// Deleted with this file in Task 8.`

- [ ] **Step 4: Run the package and bot suites**

Run: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/roster test` and `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot test` → green; `grep -rn REBIND_WINDOW_MS packages apps` → nothing.

- [ ] **Step 5: Commit**

```bash
git add packages/roster/src/writes.ts packages/roster/src/index.ts packages/roster/src/internal/rebind.ts packages/roster/src/internal/index.ts packages/roster/test/writes.test.ts apps/bot/test/rebind.test.ts apps/bot/src/rebind-commands.ts
git commit -m "feat(roster): invite by gamertag; the rebind window is the caller's"
```

---

### Task 2: Web plumbing — public `/clans`, the form helper, the copy table, the structural tests

**Files:**
- Modify: `apps/web/lib/auth/gate.ts`, `apps/web/test/auth-gate.test.ts`, `apps/web/test/request-time-rendering.test.ts`, `apps/web/lib/base-copy.ts` (`days` moves out), `apps/web/app/base/page.tsx` (`when` moves out)
- Create: `apps/web/lib/form.ts`, `apps/web/lib/format.ts`, `apps/web/lib/clan-copy.ts`, `apps/web/lib/clan-limits.ts`, `apps/web/test/form.test.ts`, `apps/web/test/clan-copy.test.ts`, `apps/web/test/api-routes.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // lib/form.ts
  export type Redirect = { back: string; code: string };
  export function formAction(req: NextRequest, back: string, run: (session: Session, form: FormData) => Promise<string | Redirect>): Promise<NextResponse>;
  export function text(form: FormData, name: string, max: number): string | null;   // trimmed; null if absent, empty or too long
  export function id(form: FormData, name: string): number | null;                  // 1–12 decimal digits
  export const confirmed: (form: FormData) => boolean;                              // form.confirm === "yes"
  // lib/format.ts
  export const when: (d: Date) => string;   // "5 Sep, 14:03 UTC"
  export const days: (ms: number) => string; // "7 days" / "1 day"
  // lib/clan-copy.ts
  export const RESULT_COPY: Record<string, string>;   // keys "<action>.<outcome>", e.g. "invite.cap"
  export const code: (action: Action, outcome: string) => string;   // `${action}.${outcome}`
  // lib/clan-limits.ts
  export const RECRUITING_LIMITS = { playWindow: 64, language: 32, pitch: 280 } as const;
  export const GAMERTAG_MAX = 64; export const POLE_KEY_MAX = 64;
  ```
- Consumes: `siteUrl(origin, path)` from `lib/auth/site-url.ts`; `currentSession` from `lib/viewer.ts`; the outcome types exported by `@factions/roster` (`InviteOutcome`, `AcceptInviteOutcome`, `RequestJoinOutcome`, `DecideRequestOutcome`, `LeaveOutcome`, `KickOutcome`, `SetRoleOutcome`, `TransferOutcome`, `RenameOutcome`, `ReserveOutcome`, `ActorRefusal`).

- [ ] **Step 1: Failing tests**

`apps/web/test/auth-gate.test.ts` — change the two pins and add cases:
```ts
  it("pins the public paths", () => {
    expect([...PUBLIC_PATHS]).toEqual(["/", "/clans"]);
  });
  it("pins the public prefixes", () => {
    expect([...PUBLIC_PREFIXES]).toEqual(["/api/auth/", "/flags/", "/clans/"]);
  });
  // in describe("pathIsPublic"):
  it("lets the clan directory and clan pages through, but not the member's own clan", () => {
    expect(pathIsPublic("/clans")).toBe(true);
    expect(pathIsPublic("/clans/BEAR")).toBe(true);
    expect(pathIsPublic("/clan")).toBe(false);
    expect(pathIsPublic("/clan/settings")).toBe(false);
    expect(pathIsPublic("/clansomething")).toBe(false);
  });
```
`apps/web/test/request-time-rendering.test.ts` — widen the detector so a page that reads the database through the package is caught even when it never reads the cookie (the public directory is exactly that page):
```ts
  const viewerPages = pages.filter((f) => {
    const text = readFileSync(f, "utf8");
    return text.includes("currentSession(") || text.includes("viewerFor(") || text.includes('from "@factions/roster"');
  });
```
`apps/web/test/form.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { text, id, confirmed } from "../lib/form";

const form = (entries: Record<string, string>) => { const f = new FormData(); for (const [k, v] of Object.entries(entries)) f.set(k, v); return f; };

describe("form field readers", () => {
  it("text trims, and refuses empty or over-long values", () => {
    expect(text(form({ name: "  Bears " }), "name", 32)).toBe("Bears");
    expect(text(form({ name: "   " }), "name", 32)).toBeNull();
    expect(text(form({ name: "x".repeat(33) }), "name", 32)).toBeNull();
    expect(text(form({}), "name", 32)).toBeNull();
  });
  it("id accepts decimal digits only", () => {
    expect(id(form({ inviteId: "42" }), "inviteId")).toBe(42);
    expect(id(form({ inviteId: "4e2" }), "inviteId")).toBeNull();
    expect(id(form({ inviteId: "-1" }), "inviteId")).toBeNull();
    expect(id(form({ inviteId: "1".repeat(13) }), "inviteId")).toBeNull();
  });
  it("confirmed is the literal yes", () => {
    expect(confirmed(form({ confirm: "yes" }))).toBe(true);
    expect(confirmed(form({ confirm: "on" }))).toBe(false);
  });
});
```
`apps/web/test/clan-copy.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { RESULT_COPY, code } from "../lib/clan-copy";

describe("clan result copy", () => {
  it("has a non-empty sentence for every code", () => {
    for (const [k, v] of Object.entries(RESULT_COPY)) {
      expect(k, k).toMatch(/^[a-z-]+\.[a-z-]+$/u);
      expect(v.trim().length, k).toBeGreaterThan(0);
    }
  });
  it("builds keys the table has", () => {
    expect(RESULT_COPY[code("invite", "cap")]).toBeDefined();
    expect(RESULT_COPY[code("claim", "too-close")]).toBeDefined();
  });
  it("misses on a prototype key", () => {
    expect(Object.hasOwn(RESULT_COPY, "__proto__")).toBe(false);
  });
});
```
`apps/web/test/api-routes.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Every write on the site is a form POST; a GET that mutates can be fired by
 * any <img> on the internet (see api/auth/logout). The auth routes and the
 * /link status poll are the only GETs.
 */
const API = join(import.meta.dirname, "..", "app", "api");
const routes = readdirSync(API, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith("route.ts")).map((f) => join(API, f));
const GET_ALLOWED = [`${sep}api${sep}auth${sep}`, `${sep}api${sep}link${sep}status${sep}`, `${sep}api${sep}link${sep}search${sep}`];

describe("api routes", () => {
  it("finds the clan routes", () => {
    expect(routes.some((f) => f.includes(`${sep}api${sep}clan${sep}`))).toBe(true);
  });
  it.each(routes)("%s exports POST unless it is an allowed read", (file) => {
    const text = readFileSync(file, "utf8");
    if (GET_ALLOWED.some((p) => file.includes(p))) return;
    expect(text).toMatch(/export async function POST\(/u);
    expect(text).not.toMatch(/export async function GET\(/u);
  });
});
```
(The "finds the clan routes" assertion fails until Task 6; that is intended — mark it `it.todo` in this task and un-todo it in Task 6.)

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @factions/web test` → gate pins fail, `form.ts`/`clan-copy.ts` missing.

- [ ] **Step 3: Implement**

`apps/web/lib/auth/gate.ts`:
```ts
/** The landing page and the clan directory (spec §10.2: public). */
export const PUBLIC_PATHS = ["/", "/clans"] as const;
/** … existing comment … `/clans/` is the public clan pages (`/clans/{tag}`); `/clan` (singular, the member's own) is gated. */
export const PUBLIC_PREFIXES = ["/api/auth/", "/flags/", "/clans/"] as const;
```
`apps/web/lib/format.ts`:
```ts
const DAY = 86_400_000;
export const when = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
export const days = (ms: number) => `${Math.round(ms / DAY)} day${Math.round(ms / DAY) === 1 ? "" : "s"}`;
```
Then in `apps/web/lib/base-copy.ts` replace the local `DAY`/`days` with `import { days } from "./format"; export { days };` (keep the re-export so `base-copy.test.ts` still imports it), and in `apps/web/app/base/page.tsx` replace the local `when` with `import { when } from "@/lib/format";`.

`apps/web/lib/clan-limits.ts`:
```ts
/** Site-owned field lengths for the recruiting post. Not guide numbers — the guide sets no limit — so they live here, not in rules.ts. */
export const RECRUITING_LIMITS = { playWindow: 64, language: 32, pitch: 280 } as const;
/** Gamertags and pole keys are bounded by the log's own shapes; these only stop a form from posting a novel. */
export const GAMERTAG_MAX = 64;
export const POLE_KEY_MAX = 64;
```
`apps/web/lib/form.ts`:
```ts
import { NextResponse, type NextRequest } from "next/server";
import { currentSession } from "./viewer";
import { siteUrl } from "./auth/site-url";
import type { Session } from "./auth/session";

export type Redirect = { back: string; code: string };

/**
 * Every roster write on the site has this shape: a form POST, one package
 * call, a 303 back to the page with a `?result=` code the page looks up.
 * ⚠️ The code is looked up, never echoed (lib/copy-lookup.ts). The rule
 * being enforced — cap, cooldown, authority — is the package's; this file
 * checks only that a string is a string.
 */
export async function formAction(req: NextRequest, back: string, run: (session: Session, form: FormData) => Promise<string | Redirect>): Promise<NextResponse> {
  const origin = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const session = await currentSession();
  if (!session) return NextResponse.redirect(siteUrl(origin, `/login?next=${encodeURIComponent(back)}`), { status: 303 });
  const form = await req.formData();
  const out = await run(session, form);
  const { back: target, code } = typeof out === "string" ? { back, code: out } : out;
  return NextResponse.redirect(siteUrl(origin, `${target}?result=${encodeURIComponent(code)}`), { status: 303 });
}

export function text(form: FormData, name: string, max: number): string | null {
  const v = form.get(name);
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length === 0 || t.length > max ? null : t;
}
const ID_RE = /^\d{1,12}$/u;
export function id(form: FormData, name: string): number | null {
  const v = form.get(name);
  return typeof v === "string" && ID_RE.test(v) ? Number(v) : null;
}
export const confirmed = (form: FormData): boolean => form.get("confirm") === "yes";
```
`apps/web/lib/clan-copy.ts` — every table is typed against the package's union so an outcome added later fails typecheck here until it has a sentence:
```ts
import {
  ACTIVATION_WINDOW_MS, CLAN_NAME_LENGTH, CLAN_SIZE_CAP, CLAN_TAG_LENGTH, JOIN_PRESENCE_RADIUS_M, MIN_BASE_SPACING_M,
  PENDING_EXPIRY_MS, REBIND_COOLDOWN_MS, RELEASED_POLE_GRACE_MS, RENAME_COOLDOWN_MS, ROSTER_COOLDOWN_MS,
} from "@factions/domain";
import type {
  ActorRefusal, InviteOutcome, AcceptInviteOutcome, RequestJoinOutcome, DecideRequestOutcome, LeaveOutcome, KickOutcome,
  SetRoleOutcome, TransferOutcome, RenameOutcome, ReserveOutcome,
} from "@factions/roster";
import { days } from "./format";

const REFUSAL: Record<ActorRefusal, string> = {
  "not-linked": "Link your character first — clan actions are taken by the character, not the Discord account.",
  "not-in-clan": "You are not in a clan.",
  "pending": `You are pending: stand within ${JOIN_PRESENCE_RADIUS_M} m of the clan's base in game to become a full member before you can act for the clan.`,
};
const INVITE: Record<InviteOutcome, string> = {
  ...REFUSAL,
  ok: "Invited. They have been told, and the invite lasts " + days(PENDING_EXPIRY_MS) + ".",
  "not-permitted": "Only an officer or the leader can invite.",
  "already-member": "That player is already in a clan.",
  cooldown: `That player left or was removed from a clan recently; they can join again after ${days(ROSTER_COOLDOWN_MS)}.`,
  "not-holding": "Your clan is not active.",
  cap: `Your clan is full — ${CLAN_SIZE_CAP} counting pending members.`,
  "invitee-not-linked": "No linked player has that gamertag. They need to link their character on the site first.",
};
const REVOKE: Record<"ok" | "not-permitted" | "gone" | ActorRefusal, string> = {
  ...REFUSAL, ok: "Invite withdrawn.", "not-permitted": "Only an officer or the leader can withdraw an invite.", gone: "That invite had already been answered or had expired.",
};
const ACCEPT: Record<AcceptInviteOutcome | "not-linked", string> = {
  ok: `You are in, pending: stand within ${JOIN_PRESENCE_RADIUS_M} m of the clan's base in game and the log will make you a full member. Unseen for ${days(PENDING_EXPIRY_MS)}, the spot expires.`,
  gone: "That invite had already been answered or had expired.",
  "already-member": "You are already in a clan.",
  cooldown: `You left or were removed from a clan recently; you can join again after ${days(ROSTER_COOLDOWN_MS)}.`,
  "not-holding": "That clan is no longer active.",
  "link-changed": "Your linked character changed since the invite was sent. Ask for a new one.",
  cap: `That clan is full — ${CLAN_SIZE_CAP} counting pending members.`,
  "not-linked": REFUSAL["not-linked"],
};
const DECLINE: Record<"declined" | "gone", string> = { declined: "Declined.", gone: "That invite had already been answered or had expired." };
const REQUEST: Record<RequestJoinOutcome | "not-linked" | "no-such-clan", string> = {
  ok: "Requested. The clan's officers have been told.",
  "not-recruiting": "That clan is not recruiting.",
  "not-holding": "That clan is not active.",
  "already-member": "You are already in a clan.",
  cooldown: `You left or were removed from a clan recently; you can join again after ${days(ROSTER_COOLDOWN_MS)}.`,
  cap: `That clan is full — ${CLAN_SIZE_CAP} counting pending members.`,
  "already-requested": "You already have a request open with that clan.",
  "not-linked": REFUSAL["not-linked"],
  "no-such-clan": "No clan has that tag.",
};
const WITHDRAW: Record<"withdrawn" | "gone", string> = { withdrawn: "Request withdrawn.", gone: "That request had already been decided or had expired." };
const DECIDE: Record<DecideRequestOutcome | ActorRefusal, string> = {
  ...REFUSAL,
  ok: "Done.",
  "not-permitted": "Only an officer or the leader can decide a request.",
  gone: "That request had already been decided or had expired.",
  cap: `Your clan is full — ${CLAN_SIZE_CAP} counting pending members.`,
  cooldown: `That player left or was removed from a clan recently; they can join again after ${days(ROSTER_COOLDOWN_MS)}.`,
  "link-changed": "That player's linked character changed since they asked. They need to ask again.",
  "not-recruiting": "Your clan is not recruiting. Turn recruiting on in settings to accept requests.",
};
const LEAVE: Record<LeaveOutcome | "not-in-clan" | "unconfirmed", string> = {
  ok: `You have left. You can join a clan again after ${days(ROSTER_COOLDOWN_MS)}.`,
  "not-member": "You are not in a clan.",
  "not-in-clan": "You are not in a clan.",
  "leader-must-transfer": "A leader cannot leave. Transfer leadership in settings first, or disband.",
  unconfirmed: "Tick the box to confirm before leaving.",
};
const KICK: Record<KickOutcome | ActorRefusal, string> = {
  ...REFUSAL,
  ok: `Removed. They can join a clan again after ${days(ROSTER_COOLDOWN_MS)}.`,
  "not-permitted": "Only an officer or the leader can remove a member.",
  "target-not-member": "That player is not in your clan.",
  "cannot-kick-self": "Use Leave to leave.",
  "cannot-kick-officer": "Only the leader can remove an officer. Demote them first.",
  "cannot-kick-leader": "The leader cannot be removed.",
};
const ROLE: Record<SetRoleOutcome | ActorRefusal, string> = {
  ...REFUSAL, ok: "Done.", "not-leader": "Only the leader can change ranks.", "target-not-member": "That player is not a full member of your clan.", "cannot-target-leader": "The leader's rank cannot be changed this way — transfer leadership instead.",
};
const TRANSFER: Record<TransferOutcome | ActorRefusal | "unconfirmed", string> = {
  ...REFUSAL, ok: "Leadership transferred. You are now an officer.", "not-leader": "Only the leader can transfer leadership.", "target-not-member": "That player is not a full member of your clan.", unconfirmed: "Tick the box to confirm before transferring leadership.",
};
const DISBAND: Record<"ok" | "not-leader" | ActorRefusal | "unconfirmed", string> = {
  ...REFUSAL,
  ok: `Disbanded. The flag and the pole are back in the pool; the name and tag are held. The pole stays private for ${days(RELEASED_POLE_GRACE_MS)}, then becomes public if nobody declares it.`,
  "not-leader": "Only the leader can disband the clan.",
  unconfirmed: "Tick the box to confirm before disbanding.",
};
const RENAME: Record<RenameOutcome | ActorRefusal | "bad-name" | "bad-tag", string> = {
  ...REFUSAL,
  ok: "Renamed.",
  "not-leader": "Only the leader can rename the clan.",
  cooldown: `A clan can be renamed once every ${days(RENAME_COOLDOWN_MS)}.`,
  "name-taken": "Another clan has that name.",
  "tag-taken": "Another clan has that tag.",
  "name-held": "That name belongs to a clan that renamed or disbanded and is held.",
  "tag-held": "That tag belongs to a clan that renamed or disbanded and is held.",
  unchanged: "That is already the clan's name and tag.",
  "bad-name": `A clan name is ${CLAN_NAME_LENGTH.min} to ${CLAN_NAME_LENGTH.max} characters.`,
  "bad-tag": `A tag is ${CLAN_TAG_LENGTH.min} to ${CLAN_TAG_LENGTH.max} letters or digits.`,
};
const RECRUITING: Record<"ok" | "not-permitted" | ActorRefusal, string> = { ...REFUSAL, ok: "Recruiting post saved.", "not-permitted": "Only an officer or the leader can edit the recruiting post." };
const REBIND: Record<"ok" | "refused" | "too-close" | "no-candidate" | "not-leader" | ActorRefusal, string> = {
  ...REFUSAL,
  ok: "Moved. Your base is the new pole; the old one goes public after its grace period.",
  refused: `Your clan moved its base within the last ${days(REBIND_COOLDOWN_MS)}, or has no declared base to move.`,
  "too-close": `Too close to another declared base — no two bases sit within ${MIN_BASE_SPACING_M} m of each other.`,
  "no-candidate": "No member has raised your flag at that pole recently. Raise it again and come back.",
  "not-leader": "Only the leader can confirm a move.",
};
const CLAIM: Record<ReserveOutcome | "not-linked" | "no-such-ceremony" | "bad-name" | "bad-tag" | "bad-flag" | "bad-roster", string> = {
  ok: `Reserved. Raise your flag at the pole within ${days(ACTIVATION_WINDOW_MS)} to activate the clan; until then the name, tag, flag and pole are yours alone.`,
  "ceremony-taken": "Someone at the ceremony already founded the clan.",
  "flag-taken": "That flag was taken while you were choosing. Pick another.",
  "tag-taken": "Another clan has that tag.",
  "pole-taken": "That pole is already declared by someone else.",
  "too-close": `Too close to another declared base. No two declared bases sit within ${MIN_BASE_SPACING_M} m of each other — first declared wins. The map cannot show you private bases, so this refusal is your first warning that one is nearby.`,
  "name-taken": "Another clan has that name.",
  "name-held": "That name belongs to a clan that renamed or disbanded and is held.",
  "tag-held": "That tag belongs to a clan that renamed or disbanded and is held.",
  "not-linked": REFUSAL["not-linked"],
  "no-such-ceremony": "That ceremony is not yours, or it has expired or already been claimed.",
  "bad-name": `A clan name is ${CLAN_NAME_LENGTH.min} to ${CLAN_NAME_LENGTH.max} characters.`,
  "bad-tag": `A tag is ${CLAN_TAG_LENGTH.min} to ${CLAN_TAG_LENGTH.max} letters or digits.`,
  "bad-flag": "Pick one of the free flags.",
  "bad-roster": "The roster must be people who were at the ceremony, and must include you.",
};
const INPUT: Record<"bad-input", string> = { "bad-input": "Something in that form was missing or too long. Try again." };

const TABLES = {
  invite: INVITE, revoke: REVOKE, accept: ACCEPT, decline: DECLINE, request: REQUEST, withdraw: WITHDRAW, decide: DECIDE,
  leave: LEAVE, kick: KICK, role: ROLE, transfer: TRANSFER, disband: DISBAND, rename: RENAME, recruiting: RECRUITING, rebind: REBIND, claim: CLAIM, input: INPUT,
} as const;
export type Action = keyof typeof TABLES;
export const code = (action: Action, outcome: string): string => `${action}.${outcome}`;

/** Every code a roster route can redirect with, flattened to "<action>.<outcome>". A null-prototype object so a query-string key cannot reach Object.prototype. */
export const RESULT_COPY: Record<string, string> = Object.assign(Object.create(null), Object.fromEntries(
  Object.entries(TABLES).flatMap(([action, table]) => Object.entries(table).map(([outcome, text]) => [`${action}.${outcome}`, text])),
));
```
(`ReserveOutcome` and `ActorRefusal` are already exported types from `@factions/roster`; if `ReserveOutcome` is not, add it to the `export type` line in `packages/roster/src/index.ts` — it is a type, not a runtime export, so the 34-name pin is unaffected.)

- [ ] **Step 4: Run the web suite**

Run: `pnpm --filter @factions/web typecheck && pnpm --filter @factions/web test` → green except the one `it.todo`. The vocabulary test scans `lib/clan-copy.ts`: no "faction" may appear in it.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib apps/web/app/base/page.tsx apps/web/test
git commit -m "feat(web): public /clans, the form-action helper, the clan result copy, structural tests for the roster routes"
```

---

### Task 3: `/clans` and `/clans/{tag}` — the public directory and clan page, with Request to join

**Files:**
- Create: `apps/web/app/clans/page.tsx`, `apps/web/app/clans/[tag]/page.tsx`, `apps/web/app/api/clans/[tag]/request/route.ts`
- Modify: `apps/web/app/page.tsx` (a "Browse the clans" link under the Discord link)

**Interfaces:**
- Consumes: `directory(): Promise<{ clans: DirectoryEntry[]; flags: { taken: string[]; free: string[] } }>`; `clanByTag(tag, viewerDiscordId | null): Promise<ClanPage | null>` where `ClanPage = DirectoryEntry & { createdAt; roster: { gamertag; role }[]; canRequest: "yes" | "not-linked" | "in-clan" | "not-recruiting" | "cooldown" | "cap" | "already-requested" }`; `requestJoin(discordId, tag)`; `flagImagePath(texture)` from `apps/web/src/flag-images.ts` (returns `flags/<texture>.png`, no leading slash); `FLAG_POOL_SIZE`; `formAction`, `RESULT_COPY`, `code`, `lookupCopy`, `when`.

- [ ] **Step 1: The directory page**

`apps/web/app/clans/page.tsx`:
```tsx
import type { Metadata } from "next";
import { directory } from "@factions/roster";
import { FLAG_POOL_SIZE } from "@factions/domain";
import { flagImagePath } from "@/src/flag-images";

export const metadata: Metadata = { title: "Clan Wars — clans" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";

export default async function ClansPage() {
  const { clans, flags } = await directory();
  const recruiting = clans.filter((c) => c.recruiting);
  return (
    <main className="mx-auto max-w-[40rem] px-4 py-10">
      <p className={label}>Clans</p>
      <h1 className="mt-1 font-display text-3xl text-ink">{clans.length} on the server</h1>
      <p className="mt-2 text-sm text-ink-2">{flags.taken.length} of {FLAG_POOL_SIZE} flags flying. Recruiting clans first.</p>

      {recruiting.length > 0 && (
        <section className="mt-8">
          <h2 className={label}>Recruiting</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {recruiting.map((c) => (
              <li key={c.tag} className="rounded-lg border border-rule bg-frame p-4">
                <a className="flex items-center gap-3" href={`/clans/${encodeURIComponent(c.tag)}`}>
                  <img src={`/${flagImagePath(c.texture)}`} alt="" width={40} height={40} className="h-10 w-10 object-contain" />
                  <span className="font-display text-lg text-ink">{c.name}</span>
                  <span className="font-mono text-ink-2">[{c.tag}]</span>
                  <span className="ml-auto font-mono text-xs text-muted">{c.memberCount} members</span>
                </a>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm text-ink-2">
                  {c.playWindow && <><dt className={label}>Plays</dt><dd>{c.playWindow}</dd></>}
                  {c.language && <><dt className={label}>Speaks</dt><dd>{c.language}</dd></>}
                  {c.pitch && <><dt className={label}>Pitch</dt><dd>{c.pitch}</dd></>}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h2 className={label}>Every clan</h2>
        <ul className="mt-2 divide-y divide-rule-2 rounded-lg border border-rule bg-frame">
          {clans.map((c) => (
            <li key={c.tag}>
              <a className="flex min-h-[56px] items-center gap-3 px-4" href={`/clans/${encodeURIComponent(c.tag)}`}>
                <img src={`/${flagImagePath(c.texture)}`} alt="" width={32} height={32} className="h-8 w-8 object-contain" />
                <span className="font-display text-ink">{c.name}</span>
                <span className="font-mono text-sm text-ink-2">[{c.tag}]</span>
                {c.status === "dormant" && <span className="font-mono text-xs uppercase text-muted">dormant</span>}
                <span className="ml-auto font-mono text-xs text-muted">{c.memberCount}</span>
              </a>
            </li>
          ))}
          {clans.length === 0 && <li className="px-4 py-3 text-ink-2">No clan yet. Found one at a flagpole with two friends.</li>}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className={label}>The flag pool</h2>
        <p className="mt-2 text-sm text-ink-2">{flags.free.length} free.</p>
        <ul className="mt-2 flex flex-wrap gap-2">
          {flags.free.map((f) => <li key={f}><img src={`/${flagImagePath(f)}`} alt={f} title={f} width={32} height={32} className="h-8 w-8 object-contain" /></li>)}
        </ul>
      </section>
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/me">Your page</a></p>
    </main>
  );
}
```

- [ ] **Step 2: The clan page**

`apps/web/app/clans/[tag]/page.tsx`:
```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { clanByTag, type ClanPage } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { when } from "@/lib/format";
import { flagImagePath } from "@/src/flag-images";

export const metadata: Metadata = { title: "Clan Wars — clan" };
/** ⚠️ Public but viewer-aware (canRequest), so per request. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";
const REQUEST_HINT: Record<Exclude<ClanPage["canRequest"], "yes">, string> = {
  "not-linked": "Sign in and link your character to ask to join.",
  "in-clan": "You are already in a clan.",
  "not-recruiting": "This clan is not recruiting.",
  cooldown: "You left or were removed from a clan recently — you can ask again once your cooldown ends.",
  cap: "This clan is full.",
  "already-requested": "You have a request open with this clan. Withdraw it from your page.",
};

export default async function ClanPage({ params, searchParams }: { params: Promise<{ tag: string }>; searchParams: Promise<{ result?: string }> }) {
  const { tag } = await params;
  const { result } = await searchParams;
  // ⚠️ Anonymous is fine here: /clans/ is public. The session only decides canRequest.
  const session = await currentSession();
  const clan = await clanByTag(tag, session?.sub ?? null);
  if (!clan) notFound();
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  const back = `/clans/${encodeURIComponent(clan.tag)}`;

  return (
    <main className="mx-auto max-w-[34rem] px-4 py-10">
      <div className="flex items-center gap-4">
        <img src={`/${flagImagePath(clan.texture)}`} alt="" width={64} height={64} className="h-16 w-16 object-contain" />
        <div>
          <p className={label}>[{clan.tag}] · {clan.status}</p>
          <h1 className="mt-1 font-display text-3xl text-ink">{clan.name}</h1>
          <p className="mt-1 text-sm text-ink-2">Founded {when(clan.createdAt)} · {clan.memberCount} members</p>
        </div>
      </div>
      {notice && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{notice}</p>}

      {clan.recruiting && (
        <section className="mt-8 rounded-lg border border-gold bg-frame p-5">
          <h2 className={label}>Recruiting</h2>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm text-ink-2">
            {clan.playWindow && <><dt className={label}>Plays</dt><dd>{clan.playWindow}</dd></>}
            {clan.language && <><dt className={label}>Speaks</dt><dd>{clan.language}</dd></>}
            {clan.pitch && <><dt className={label}>Pitch</dt><dd className="text-ink">{clan.pitch}</dd></>}
          </dl>
        </section>
      )}

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Roster</h2>
        <ul className="mt-2 flex flex-col gap-1">
          {clan.roster.map((r, i) => (
            <li key={`${r.gamertag ?? "?"}-${i}`} className="flex justify-between text-ink">
              <span className="font-mono">{r.gamertag ?? "unknown"}</span>
              <span className="font-mono text-xs uppercase text-muted">{r.role}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-4">
        {clan.canRequest === "yes" ? (
          <form action={`/api/clans/${encodeURIComponent(clan.tag)}/request`} method="post">
            <button className="min-h-[52px] w-full rounded-md bg-gold px-4 font-display text-ground" type="submit">Request to join</button>
          </form>
        ) : (
          <p className="text-sm text-ink-2">{REQUEST_HINT[clan.canRequest]}{clan.canRequest === "not-linked" && <> <a className="text-gold underline-offset-4 hover:underline" href={`/login?next=${encodeURIComponent(back)}`}>Sign in</a>.</>}</p>
        )}
      </section>
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/clans">All clans</a></p>
    </main>
  );
}
```

- [ ] **Step 3: The request route**

`apps/web/app/api/clans/[tag]/request/route.ts`:
```ts
import type { NextRequest, NextResponse } from "next/server";
import { requestJoin } from "@factions/roster";
import { formAction } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from the Request to join button. Recruiting, cap, cooldown and one-open-request are the package's. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ tag: string }> }): Promise<NextResponse> {
  const { tag } = await ctx.params;
  const back = `/clans/${encodeURIComponent(tag)}`;
  return formAction(req, back, async (session) => {
    const { outcome } = await requestJoin(session.sub, tag);
    return code("request", outcome);
  });
}
```
`apps/web/app/page.tsx`: under the Discord link add `<a className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" href="/clans">Browse the clans</a>`.

- [ ] **Step 4: Typecheck, test, and look at it**

Run: `pnpm --filter @factions/web typecheck && pnpm --filter @factions/web test` → green (`request-time-rendering` now sees both pages as `@factions/roster` importers and demands `force-dynamic`; `copy-vocabulary` scans them). Then, with the dev database seeded from any roster test (`packages/roster/test/seed.ts` shows the shape) or empty: `DATABASE_URL="postgres://factions:factions@localhost:5434/factions_test_roster" SESSION_SECRET=dev pnpm --filter @factions/web dev` and open `/clans` — an empty directory renders "No clan yet"; `/clans/NOPE` renders Next's 404.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/clans apps/web/app/api/clans apps/web/app/page.tsx
git commit -m "feat(web): /clans directory and /clans/{tag} with Request to join"
```

---

### Task 4: `/me` — pending, invites, requests, the claim link

**Files:**
- Modify: `apps/web/app/me/page.tsx`
- Create: `apps/web/app/api/me/invite/accept/route.ts`, `apps/web/app/api/me/invite/decline/route.ts`, `apps/web/app/api/me/request/withdraw/route.ts`

**Interfaces:**
- Consumes: `viewerFor(discordId): Promise<Viewer>` with `Viewer.pending: { id; name; tag } | null`; `myInvites(discordId): Promise<PendingInvite[]>` (`{ id; factionId; factionName; tag; serverId; serverName; expiresAt }`); `myRequests(discordId)` (rows `{ id; factionId; …; expiresAt }` — join the clan name by displaying the tag from `clanByTag`? No: `requestsBy` rows carry `factionId` only. Render `Request #id · expires when` and rely on the withdraw button; increment 3's notices name the clan); `claimContext(discordId): Promise<ClaimContext>`; `acceptInvite(discordId, inviteId)`, `declineInvite(discordId, inviteId): Promise<boolean>`, `withdrawRequest(discordId, requestId): Promise<boolean>`.

- [ ] **Step 1: The routes**

`apps/web/app/api/me/invite/accept/route.ts`:
```ts
import type { NextRequest, NextResponse } from "next/server";
import { acceptInvite } from "@factions/roster";
import { formAction, id } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /me. Accepting makes a PENDING member; the cap and cooldown are the package's. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/me", async (session, form) => {
    const inviteId = id(form, "inviteId");
    if (inviteId === null) return code("input", "bad-input");
    return code("accept", await acceptInvite(session.sub, inviteId));
  });
}
```
`apps/web/app/api/me/invite/decline/route.ts` — same shape: `const ok = await declineInvite(session.sub, inviteId); return code("decline", ok ? "declined" : "gone");`
`apps/web/app/api/me/request/withdraw/route.ts` — `const requestId = id(form, "requestId"); … const ok = await withdrawRequest(session.sub, requestId); return code("withdraw", ok ? "withdrawn" : "gone");`

- [ ] **Step 2: The page**

In `apps/web/app/me/page.tsx`:
- Imports: add `myInvites, myRequests, claimContext` from `@factions/roster`; `JOIN_PRESENCE_RADIUS_M, PENDING_EXPIRY_MS` from `@factions/domain`; `RESULT_COPY` from `@/lib/clan-copy`; `when, days` from `@/lib/format`.
- `searchParams` type becomes `Promise<{ unlink?: string; result?: string }>`; read `result` and `const resultNotice = result ? lookupCopy(RESULT_COPY, result) : undefined;` rendered exactly like `unlinkNotice` (a second `<p role="status">`).
- After `const viewer = await viewerFor(session.sub);` add `const [invites, requests, claim] = await Promise.all([myInvites(session.sub), myRequests(session.sub), claimContext(session.sub)]);`.
- In the "Your clan" section, when `viewer.clan` is set, wrap the name in `<a href="/clan">` and add `<a className="text-gold underline-offset-4 hover:underline" href="/clan">Your clan page</a>`. When `viewer.pending` is set (and `viewer.clan` is null), render instead:
  ```tsx
  <p className="mt-2 text-ink">Pending in <span className="font-display">{viewer.pending.name}</span> <span className="font-mono text-ink-2">[{viewer.pending.tag}]</span></p>
  <p className="mt-2 text-sm text-ink-2">Stand within {JOIN_PRESENCE_RADIUS_M} m of the clan&rsquo;s base in game and the server log will make you a full member. Unseen for {days(PENDING_EXPIRY_MS)}, the spot expires. Until then your solo base, if you have one, is still yours.</p>
  <a className="text-gold underline-offset-4 hover:underline" href="/clan">The roster you are joining</a>
  ```
  When neither, keep "You are not in a clan." and add `<a … href="/clans">Browse the clans</a>` beside the solo-base link.
- New section, only when `claim` is not null:
  ```tsx
  <section className="mt-4 rounded-lg border border-gold bg-frame p-5">
    <h2 className={label}>A ceremony is waiting</h2>
    <p className="mt-2 text-ink">{claim.ceremony.participants.length} linked players raised the neutral flag together. Any one of you can found the clan until {when(claim.ceremony.expiresAt)}.</p>
    <a className="mt-3 inline-flex min-h-[44px] items-center rounded-md bg-gold px-4 font-display text-ground" href={`/claim/${claim.ceremony.id}`}>Found the clan</a>
  </section>
  ```
- New section "Invites", only when `invites.length > 0` and `viewer.clan === null && viewer.pending === null`:
  ```tsx
  <ul className="mt-2 flex flex-col gap-2">
    {invites.map((inv) => (
      <li key={inv.id} className="flex min-h-[56px] flex-wrap items-center justify-between gap-3 rounded-md border border-rule-2 px-4 py-2">
        <div><span className="font-display text-ink">{inv.factionName}</span> <span className="font-mono text-ink-2">[{inv.tag}]</span><div className="text-xs text-ink-2">expires {when(inv.expiresAt)}</div></div>
        <div className="flex gap-2">
          <form action="/api/me/invite/accept" method="post"><input type="hidden" name="inviteId" value={inv.id} /><button className="min-h-[44px] rounded-md bg-gold px-4 font-display text-ground" type="submit">Accept</button></form>
          <form action="/api/me/invite/decline" method="post"><input type="hidden" name="inviteId" value={inv.id} /><button className="min-h-[44px] rounded-md border border-rule px-4 font-display text-ink" type="submit">Decline</button></form>
        </div>
      </li>
    ))}
  </ul>
  ```
- New section "Your requests", only when `requests.length > 0`: one row per request with `Asked {when(r.createdAt)} · expires {when(r.expiresAt)}` and a Withdraw form posting `requestId`.
- Replace the closing "Player tools land here…" paragraph with `<p className="mt-8 font-mono text-xs text-muted">Nothing on this page is invented: it is what the server log has recorded.</p>`.
- Define `const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";` at module scope and use it for the section headings (the file repeats the class string today).

- [ ] **Step 3: Typecheck and test**

Run: `pnpm --filter @factions/web typecheck && pnpm --filter @factions/web test` → green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/me apps/web/app/api/me
git commit -m "feat(web): /me shows pending, invites, requests and the waiting ceremony"
```

---

### Task 5: `/claim/{ceremony}` — found the clan on the site

**Files:**
- Create: `apps/web/app/claim/[ceremony]/page.tsx`, `apps/web/app/api/claim/route.ts`

**Interfaces:**
- Consumes: `claimContext(discordId): Promise<{ ceremony: { id; detectedAt; expiresAt; participants: { dayzId; gamertag; discordId }[] }; freeFlags: string[] } | null>`; `claimCeremony(discordId, ceremonyId, { name, tag, texture, memberDayzIds }): Promise<ReserveOutcome | "not-linked" | "no-such-ceremony" | "bad-name" | "bad-tag" | "bad-flag" | "bad-roster">`; `CLAN_NAME_LENGTH`, `CLAN_TAG_LENGTH`, `ACTIVATION_WINDOW_MS`, `CLAN_SIZE_CAP`, `MIN_BASE_SPACING_M`.

- [ ] **Step 1: The route**

`apps/web/app/api/claim/route.ts`:
```ts
import type { NextRequest, NextResponse } from "next/server";
import { claimCeremony } from "@factions/roster";
import { CLAN_NAME_LENGTH, CLAN_TAG_LENGTH } from "@factions/domain";
import { formAction, id, text } from "@/lib/form";
import { code } from "@/lib/clan-copy";

const DAYZ_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * POST from /claim/{ceremony}. Name, tag, flag and the pruned roster go to
 * the package, which checks the ceremony is the caller's, the identity is
 * free and unheld, and the pole is 200 m from every other declaration.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/me", async (session, form) => {
    const ceremonyId = id(form, "ceremonyId");
    if (ceremonyId === null) return code("input", "bad-input");
    const back = `/claim/${ceremonyId}`;
    const name = text(form, "name", CLAN_NAME_LENGTH.max);
    const tag = text(form, "tag", CLAN_TAG_LENGTH.max)?.toUpperCase() ?? null;
    const texture = text(form, "texture", 64);
    const members = form.getAll("member").filter((m): m is string => typeof m === "string" && DAYZ_ID_RE.test(m));
    if (!name || !tag || !texture) return { back, code: code("input", "bad-input") };
    const outcome = await claimCeremony(session.sub, ceremonyId, { name, tag, texture, memberDayzIds: members });
    return outcome === "ok" ? { back: "/clan", code: code("claim", "ok") } : { back, code: code("claim", outcome) };
  });
}
```

- [ ] **Step 2: The page**

`apps/web/app/claim/[ceremony]/page.tsx`:
```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { claimContext } from "@factions/roster";
import { ACTIVATION_WINDOW_MS, CLAN_NAME_LENGTH, CLAN_SIZE_CAP, CLAN_TAG_LENGTH, MIN_BASE_SPACING_M } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { when, days } from "@/lib/format";
import { flagImagePath } from "@/src/flag-images";

export const metadata: Metadata = { title: "Clan Wars — found your clan", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";
const field = "mt-1 w-full rounded-md border border-rule bg-ground px-3 py-2 font-mono text-ink";

export default async function ClaimPage({ params, searchParams }: { params: Promise<{ ceremony: string }>; searchParams: Promise<{ result?: string }> }) {
  const { ceremony: raw } = await params;
  const { result } = await searchParams;
  const session = await currentSession();
  if (!session) {
    return <main className="mx-auto max-w-[34rem] px-4 py-10"><p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href={`/login?next=/claim/${encodeURIComponent(raw)}`}>Sign in again</a>.</p></main>;
  }
  // ⚠️ The package returns the VIEWER's open ceremony; the id in the URL must be that one, or it is not theirs to see.
  const ctx = await claimContext(session.sub);
  if (!ctx || String(ctx.ceremony.id) !== raw) notFound();
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  const me = ctx.ceremony.participants.find((p) => p.discordId === session.sub);

  return (
    <main className="mx-auto max-w-[34rem] px-4 py-10">
      <p className={label}>Found your clan</p>
      <h1 className="mt-1 font-display text-3xl text-ink">{ctx.ceremony.participants.length} of you raised the flag</h1>
      <p className="mt-2 text-sm text-ink-2">Witnessed {when(ctx.ceremony.detectedAt)}. Claim it before {when(ctx.ceremony.expiresAt)}. Whoever claims becomes leader.</p>
      {notice && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{notice}</p>}

      <form className="mt-8 flex flex-col gap-6" action="/api/claim" method="post">
        <input type="hidden" name="ceremonyId" value={ctx.ceremony.id} />
        <label className="block"><span className={label}>Name</span>
          <input className={field} name="name" required minLength={CLAN_NAME_LENGTH.min} maxLength={CLAN_NAME_LENGTH.max} autoComplete="off" />
        </label>
        <label className="block"><span className={label}>Tag — {CLAN_TAG_LENGTH.min} to {CLAN_TAG_LENGTH.max} letters or digits</span>
          <input className={`${field} uppercase`} name="tag" required minLength={CLAN_TAG_LENGTH.min} maxLength={CLAN_TAG_LENGTH.max} pattern="[A-Za-z0-9]+" autoComplete="off" />
        </label>

        <fieldset>
          <legend className={label}>Flag — {ctx.freeFlags.length} free</legend>
          <ul className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6">
            {ctx.freeFlags.map((f) => (
              <li key={f}>
                <label className="flex cursor-pointer flex-col items-center gap-1 rounded-md border border-rule p-2 has-[:checked]:border-gold">
                  <input type="radio" name="texture" value={f} required className="sr-only" />
                  <img src={`/${flagImagePath(f)}`} alt={f} width={48} height={48} className="h-12 w-12 object-contain" />
                  <span className="font-mono text-[10px] text-muted">{f.replace(/^Flag_/u, "")}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <fieldset>
          <legend className={label}>Roster — untick anyone who should not be in</legend>
          <p className="mt-1 text-xs text-ink-2">Only people at the ceremony can be founding members. A clan holds at most {CLAN_SIZE_CAP}.</p>
          <ul className="mt-2 flex flex-col gap-1">
            {ctx.ceremony.participants.map((p) => (
              <li key={p.dayzId}>
                <label className="flex min-h-[44px] items-center gap-3 text-ink">
                  <input type="checkbox" name="member" value={p.dayzId} defaultChecked disabled={p.dayzId === me?.dayzId} className="h-5 w-5" />
                  <span className="font-mono">{p.gamertag}</span>
                  {p.dayzId === me?.dayzId && <span className="font-mono text-xs uppercase text-muted">you — leader</span>}
                </label>
              </li>
            ))}
          </ul>
          {/* A disabled checkbox does not post; the claimant must be on the roster, so carry them explicitly. */}
          {me && <input type="hidden" name="member" value={me.dayzId} />}
        </fieldset>

        <p className="text-sm text-ink-2">Claiming reserves the name, tag, flag and pole. Raise your flag at the pole within {days(ACTIVATION_WINDOW_MS)} to activate. No two bases sit within {MIN_BASE_SPACING_M} m of each other — if the pole is too close to one you cannot see, the claim is refused.</p>
        <button className="min-h-[52px] rounded-md bg-gold px-4 font-display text-ground" type="submit">Found the clan</button>
      </form>
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/me">Your page</a></p>
    </main>
  );
}
```

- [ ] **Step 3: Typecheck and test**

Run: `pnpm --filter @factions/web typecheck && pnpm --filter @factions/web test` → green. `/clan?result=claim.ok` is what a successful claim lands on; Task 6 renders it.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/claim apps/web/app/api/claim
git commit -m "feat(web): /claim/{ceremony} founds the clan on the site"
```

---

### Task 6: `/clan` — the roster and the roster writes

**Files:**
- Create: `apps/web/app/clan/page.tsx`, `apps/web/app/api/clan/invite/route.ts`, `.../revoke-invite/route.ts`, `.../decide-request/route.ts`, `.../leave/route.ts`, `.../kick/route.ts`, `.../promote/route.ts`, `.../demote/route.ts`
- Modify: `apps/web/test/api-routes.test.ts` (un-todo "finds the clan routes")

**Interfaces:**
- Consumes: `clanFor(discordId): Promise<ClanView | "not-linked" | "not-in-clan">` with `ClanView = { clan: { id; name; tag; texture; status; createdAt; activatedAt; recruiting; playWindow; language; pitch }; me: { role; status }; roster: RosterRow[]; invitesOut: (PendingInvite & { inviteeDiscordId; inviteeGamertag })[]; requestsIn: JoinRequest[]; rebindCandidates }`, `RosterRow = { dayzId; discordId; gamertag; role; status; joinedAt; lastSeenAt }`; `invite(actor, { gamertag })` (Task 1), `revokeInvite(actor, inviteId)`, `decideRequest(actor, requestId, "accepted" | "declined")`, `leave(discordId)`, `kick(actor, targetDiscordId)`, `promote(actor, targetDiscordId)`, `demote(actor, targetDiscordId)`.
- Produces: the `/clan` page every later route redirects to; the `role`-gated markup pattern Task 7 repeats.

- [ ] **Step 1: The routes**

`apps/web/app/api/clan/invite/route.ts`:
```ts
import type { NextRequest, NextResponse } from "next/server";
import { invite } from "@factions/roster";
import { formAction, text } from "@/lib/form";
import { GAMERTAG_MAX } from "@/lib/clan-limits";
import { code } from "@/lib/clan-copy";

/** POST from /clan. Officer+; the invitee is named by gamertag and must be linked. Cap and cooldown are the package's. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan", async (session, form) => {
    const gamertag = text(form, "gamertag", GAMERTAG_MAX);
    if (!gamertag) return code("input", "bad-input");
    const { outcome } = await invite(session.sub, { gamertag });
    return code("invite", outcome);
  });
}
```
`revoke-invite/route.ts`: `const inviteId = id(form, "inviteId"); if (inviteId === null) return code("input","bad-input"); return code("revoke", await revokeInvite(session.sub, inviteId));`
`decide-request/route.ts`:
```ts
    const requestId = id(form, "requestId");
    const decision = form.get("decision");
    if (requestId === null || (decision !== "accepted" && decision !== "declined")) return code("input", "bad-input");
    return code("decide", await decideRequest(session.sub, requestId, decision));
```
`leave/route.ts`: `if (!confirmed(form)) return code("leave", "unconfirmed"); const out = await leave(session.sub); return out === "ok" ? { back: "/me", code: code("leave", "ok") } : code("leave", out);`
`kick/route.ts`, `promote/route.ts`, `demote/route.ts` — each reads `const target = text(form, "target", 32); if (!target || !/^\d+$/u.test(target)) return code("input", "bad-input");` (a Discord id is a snowflake: digits) and returns `code("kick", await kick(session.sub, target))` / `code("role", await promote(…))` / `code("role", await demote(…))`.

- [ ] **Step 2: The page**

`apps/web/app/clan/page.tsx`:
```tsx
import type { Metadata } from "next";
import { clanFor } from "@factions/roster";
import { ACTIVATION_WINDOW_MS, JOIN_PRESENCE_RADIUS_M, PENDING_EXPIRY_MS } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { GAMERTAG_MAX } from "@/lib/clan-limits";
import { when, days } from "@/lib/format";
import { flagImagePath } from "@/src/flag-images";

export const metadata: Metadata = { title: "Clan Wars — your clan", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";
const small = "min-h-[44px] rounded-md border border-rule px-3 font-display text-sm text-ink";
const danger = "min-h-[44px] rounded-md border border-rust px-3 font-display text-sm text-ink";

/** Hidden target + one button: the shape of every per-row action. */
function RowAction({ action, target, children, style = small }: { action: string; target: string; children: React.ReactNode; style?: string }) {
  return (
    <form action={`/api/clan/${action}`} method="post">
      <input type="hidden" name="target" value={target} />
      <button className={style} type="submit">{children}</button>
    </form>
  );
}

export default async function ClanPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const { result } = await searchParams;
  const session = await currentSession();
  if (!session) {
    return <main className="mx-auto max-w-[40rem] px-4 py-10"><p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/clan">Sign in again</a>.</p></main>;
  }
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  const view = await clanFor(session.sub);

  if (view === "not-linked" || view === "not-in-clan") {
    return (
      <main className="mx-auto max-w-[40rem] px-4 py-10">
        <p className={label}>Your clan</p>
        {notice && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{notice}</p>}
        {view === "not-linked"
          ? <p className="mt-6 text-ink-2"><a className="text-gold underline-offset-4 hover:underline" href="/link">Link your character</a> first — a clan is joined by the character, not the Discord account.</p>
          : <p className="mt-6 text-ink-2">You are not in a clan. <a className="text-gold underline-offset-4 hover:underline" href="/clans">Browse the clans</a>, accept an invite on <a className="text-gold underline-offset-4 hover:underline" href="/me">your page</a>, or found one at a flagpole with two friends.</p>}
      </main>
    );
  }

  const { clan, me, roster, invitesOut, requestsIn } = view;
  const officer = me.status === "full" && (me.role === "officer" || me.role === "leader");
  const leader = me.status === "full" && me.role === "leader";
  const full = roster.filter((r) => r.status === "full");
  const pending = roster.filter((r) => r.status === "pending");

  return (
    <main className="mx-auto max-w-[40rem] px-4 py-10">
      <div className="flex items-center gap-4">
        <img src={`/${flagImagePath(clan.texture)}`} alt="" width={56} height={56} className="h-14 w-14 object-contain" />
        <div>
          <p className={label}>[{clan.tag}] · {clan.status} · you are {me.status === "pending" ? "pending" : me.role}</p>
          <h1 className="mt-1 font-display text-3xl text-ink">{clan.name}</h1>
        </div>
        {officer && <a className={`${label} ml-auto underline-offset-4 hover:underline`} href="/clan/settings">Settings</a>}
      </div>
      {notice && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{notice}</p>}

      {clan.status === "reserved" && (
        <p className="mt-6 rounded-md border border-gold bg-frame p-4 text-ink">Reserved. Raise your flag at the pole within {days(ACTIVATION_WINDOW_MS)} of the claim to activate the clan. Until then nobody else can take the name, tag, flag or pole.</p>
      )}
      {me.status === "pending" && (
        <p className="mt-6 rounded-md border border-gold bg-frame p-4 text-ink">You are pending. Stand within {JOIN_PRESENCE_RADIUS_M} m of the clan&rsquo;s base in game and the server log will make you a full member. Unseen for {days(PENDING_EXPIRY_MS)}, the spot expires.</p>
      )}

      <section className="mt-8 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Roster — {full.length} full{pending.length > 0 && `, ${pending.length} pending`}</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {[...full, ...pending].map((r) => {
            const self = r.discordId === session.sub;
            return (
              <li key={r.dayzId} className="flex flex-wrap items-center gap-3 rounded-md border border-rule-2 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-ink">{r.gamertag ?? "unknown"}</span>
                  <span className="ml-2 font-mono text-xs uppercase text-muted">{r.status === "pending" ? "pending" : r.role}</span>
                  <div className="text-xs text-ink-2">joined {when(r.joinedAt)}{r.lastSeenAt && ` · seen ${when(r.lastSeenAt)}`}</div>
                </div>
                {!self && officer && r.status === "full" && r.role === "member" && <RowAction action="kick" target={r.discordId} style={danger}>Remove</RowAction>}
                {!self && officer && r.status === "pending" && <RowAction action="kick" target={r.discordId} style={danger}>Remove</RowAction>}
                {!self && leader && r.status === "full" && r.role === "member" && <RowAction action="promote" target={r.discordId}>Make officer</RowAction>}
                {!self && leader && r.status === "full" && r.role === "officer" && <RowAction action="demote" target={r.discordId}>Demote</RowAction>}
              </li>
            );
          })}
        </ul>
      </section>

      {officer && (
        <>
          <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Invite</h2>
            <form className="mt-2 flex gap-2" action="/api/clan/invite" method="post">
              <input className="min-w-0 flex-1 rounded-md border border-rule bg-ground px-3 py-2 font-mono text-ink" name="gamertag" placeholder="gamertag" required maxLength={GAMERTAG_MAX} autoComplete="off" />
              <button className="min-h-[44px] rounded-md bg-gold px-4 font-display text-ground" type="submit">Invite</button>
            </form>
            <p className="mt-2 text-xs text-ink-2">They must have linked their character on the site.</p>
            {invitesOut.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1">
                {invitesOut.map((inv) => (
                  <li key={inv.id} className="flex items-center justify-between gap-3 text-sm text-ink">
                    <span><span className="font-mono">{inv.inviteeGamertag ?? "unknown"}</span> <span className="text-xs text-ink-2">expires {when(inv.expiresAt)}</span></span>
                    <form action="/api/clan/revoke-invite" method="post"><input type="hidden" name="inviteId" value={inv.id} /><button className={small} type="submit">Withdraw</button></form>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Requests to join — {requestsIn.length}</h2>
            {requestsIn.length === 0
              ? <p className="mt-2 text-sm text-ink-2">{clan.recruiting ? "None open." : "Turn recruiting on in settings to receive requests."}</p>
              : (
                <ul className="mt-2 flex flex-col gap-2">
                  {requestsIn.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink">
                      <span><span className="font-mono">{r.gamertag ?? "unknown"}</span> <span className="text-xs text-ink-2">asked {when(r.createdAt)}</span></span>
                      <div className="flex gap-2">
                        <form action="/api/clan/decide-request" method="post"><input type="hidden" name="requestId" value={r.id} /><input type="hidden" name="decision" value="accepted" /><button className="min-h-[44px] rounded-md bg-gold px-3 font-display text-sm text-ground" type="submit">Accept</button></form>
                        <form action="/api/clan/decide-request" method="post"><input type="hidden" name="requestId" value={r.id} /><input type="hidden" name="decision" value="declined" /><button className={small} type="submit">Decline</button></form>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </>
      )}

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Leave</h2>
        {leader
          ? <p className="mt-2 text-sm text-ink-2">A leader cannot leave. <a className="text-gold underline-offset-4 hover:underline" href="/clan/settings">Transfer leadership</a> first, or disband.</p>
          : (
            <form className="mt-2" action="/api/clan/leave" method="post">
              <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" className="h-5 w-5" /> I understand I cannot join a clan again for a while after leaving.</label>
              <button className={`${danger} mt-3`} type="submit">Leave the clan</button>
            </form>
          )}
      </section>
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/me">Your page</a></p>
    </main>
  );
}
```
Note the leave confirmation says "for a while" and not a number: the number is in the result copy (`LEAVE.ok`), from `ROSTER_COOLDOWN_MS`; a second statement of it here would be one more place to drift.

- [ ] **Step 3: Un-todo the route test, typecheck, test**

In `apps/web/test/api-routes.test.ts` change `it.todo("finds the clan routes", …)` back to `it(`. Run: `pnpm --filter @factions/web typecheck && pnpm --filter @factions/web test` → green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/clan/page.tsx apps/web/app/api/clan apps/web/test/api-routes.test.ts
git commit -m "feat(web): /clan — roster, invites, requests, ranks, leave"
```

---

### Task 7: `/clan/settings` — recruiting post, rename, transfer, rebind, disband

**Files:**
- Create: `apps/web/app/clan/settings/page.tsx`, `apps/web/app/api/clan/recruiting/route.ts`, `.../rename/route.ts`, `.../transfer/route.ts`, `.../rebind/route.ts`, `.../disband/route.ts`

**Interfaces:**
- Consumes: `clanFor` (Task 6's `ClanView`, incl. `rebindCandidates: { poleKey; raisedAt; by }[]`), `setRecruitingPost(actor, { recruiting; playWindow; language; pitch })`, `rename(actor, { name; tag? })`, `transfer(actor, targetDiscordId)`, `confirmRebind(actor, poleKey)`, `disband(actor)`; `RECRUITING_LIMITS`, `POLE_KEY_MAX`; `RENAME_COOLDOWN_MS`, `REBIND_CONFIRM_MS`, `REBIND_COOLDOWN_MS`, `RELEASED_POLE_GRACE_MS`, `CLAN_NAME_LENGTH`, `CLAN_TAG_LENGTH`.

- [ ] **Step 1: The routes**

`recruiting/route.ts`:
```ts
import type { NextRequest, NextResponse } from "next/server";
import { setRecruitingPost } from "@factions/roster";
import { formAction, text } from "@/lib/form";
import { RECRUITING_LIMITS } from "@/lib/clan-limits";
import { code } from "@/lib/clan-copy";

/** POST from /clan/settings. Officer+. Empty fields clear the post; the checkbox is the switch. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session, form) => {
    const post = {
      recruiting: form.get("recruiting") === "yes",
      playWindow: text(form, "playWindow", RECRUITING_LIMITS.playWindow),
      language: text(form, "language", RECRUITING_LIMITS.language),
      pitch: text(form, "pitch", RECRUITING_LIMITS.pitch),
    };
    return code("recruiting", await setRecruitingPost(session.sub, post));
  });
}
```
`rename/route.ts`: `const name = text(form, "name", CLAN_NAME_LENGTH.max); const tag = text(form, "tag", CLAN_TAG_LENGTH.max)?.toUpperCase(); if (!name) return code("input", "bad-input"); return code("rename", await rename(session.sub, tag ? { name, tag } : { name }));`
`transfer/route.ts`: `if (!confirmed(form)) return code("transfer", "unconfirmed"); const target = text(form, "target", 32); if (!target || !/^\d+$/u.test(target)) return code("input", "bad-input"); return code("transfer", await transfer(session.sub, target));`
`rebind/route.ts`: `const poleKey = text(form, "poleKey", POLE_KEY_MAX); if (!poleKey) return code("input", "bad-input"); return code("rebind", await confirmRebind(session.sub, poleKey));`
`disband/route.ts`: `if (!confirmed(form)) return code("disband", "unconfirmed"); const out = await disband(session.sub); return out === "ok" ? { back: "/me", code: code("disband", "ok") } : code("disband", out);`

- [ ] **Step 2: The page**

`apps/web/app/clan/settings/page.tsx`:
```tsx
import type { Metadata } from "next";
import { clanFor } from "@factions/roster";
import { CLAN_NAME_LENGTH, CLAN_TAG_LENGTH, REBIND_CONFIRM_MS, REBIND_COOLDOWN_MS, RELEASED_POLE_GRACE_MS, RENAME_COOLDOWN_MS } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { RECRUITING_LIMITS } from "@/lib/clan-limits";
import { when, days } from "@/lib/format";

export const metadata: Metadata = { title: "Clan Wars — clan settings", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";
const field = "mt-1 w-full rounded-md border border-rule bg-ground px-3 py-2 font-mono text-ink";
const hours = (ms: number) => `${Math.round(ms / 3_600_000)} h`;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const { result } = await searchParams;
  const session = await currentSession();
  if (!session) {
    return <main className="mx-auto max-w-[34rem] px-4 py-10"><p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/clan/settings">Sign in again</a>.</p></main>;
  }
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  const view = await clanFor(session.sub);
  const officer = typeof view !== "string" && view.me.status === "full" && (view.me.role === "officer" || view.me.role === "leader");
  if (typeof view === "string" || !officer) {
    return (
      <main className="mx-auto max-w-[34rem] px-4 py-10">
        <p className={label}>Clan settings</p>
        {notice && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{notice}</p>}
        <p className="mt-6 text-ink-2">Settings are for a clan&rsquo;s officers and leader. <a className="text-gold underline-offset-4 hover:underline" href="/clan">Your clan</a>.</p>
      </main>
    );
  }
  const { clan, me, roster, rebindCandidates } = view;
  const leader = me.role === "leader";
  const others = roster.filter((r) => r.status === "full" && r.discordId !== session.sub);

  return (
    <main className="mx-auto max-w-[34rem] px-4 py-10">
      <p className={label}>Clan settings</p>
      <h1 className="mt-1 font-display text-3xl text-ink">{clan.name} <span className="font-mono text-xl text-ink-2">[{clan.tag}]</span></h1>
      {notice && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{notice}</p>}

      <section className="mt-8 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Recruiting post</h2>
        <form className="mt-2 flex flex-col gap-3" action="/api/clan/recruiting" method="post">
          <label className="flex items-center gap-2 text-ink"><input type="checkbox" name="recruiting" value="yes" defaultChecked={clan.recruiting} className="h-5 w-5" /> Recruiting — listed first on the clans page; players can ask to join</label>
          <label className="block"><span className={label}>When you play</span><input className={field} name="playWindow" defaultValue={clan.playWindow ?? ""} maxLength={RECRUITING_LIMITS.playWindow} placeholder="EU evenings, weekends" /></label>
          <label className="block"><span className={label}>Language</span><input className={field} name="language" defaultValue={clan.language ?? ""} maxLength={RECRUITING_LIMITS.language} placeholder="English" /></label>
          <label className="block"><span className={label}>Pitch</span><textarea className={field} name="pitch" defaultValue={clan.pitch ?? ""} maxLength={RECRUITING_LIMITS.pitch} rows={3} /></label>
          <button className="min-h-[44px] self-start rounded-md bg-gold px-4 font-display text-ground" type="submit">Save</button>
        </form>
      </section>

      {leader && (
        <>
          <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Rename — once every {days(RENAME_COOLDOWN_MS)}</h2>
            <form className="mt-2 flex flex-col gap-3" action="/api/clan/rename" method="post">
              <label className="block"><span className={label}>Name</span><input className={field} name="name" defaultValue={clan.name} required minLength={CLAN_NAME_LENGTH.min} maxLength={CLAN_NAME_LENGTH.max} /></label>
              <label className="block"><span className={label}>Tag</span><input className={`${field} uppercase`} name="tag" defaultValue={clan.tag} minLength={CLAN_TAG_LENGTH.min} maxLength={CLAN_TAG_LENGTH.max} pattern="[A-Za-z0-9]+" /></label>
              <p className="text-xs text-ink-2">The old name and tag stay held — nobody else can take them.</p>
              <button className="min-h-[44px] self-start rounded-md border border-rule px-4 font-display text-ink" type="submit">Rename</button>
            </form>
          </section>

          <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Transfer leadership</h2>
            {others.length === 0 ? <p className="mt-2 text-sm text-ink-2">No other full member to hand over to.</p> : (
              <form className="mt-2 flex flex-col gap-3" action="/api/clan/transfer" method="post">
                <label className="block"><span className={label}>To</span>
                  <select className={field} name="target" required>
                    {others.map((r) => <option key={r.discordId} value={r.discordId}>{r.gamertag ?? "unknown"} — {r.role}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" className="h-5 w-5" /> I understand I become an officer and they lead.</label>
                <button className="min-h-[44px] self-start rounded-md border border-rust px-4 font-display text-ink" type="submit">Transfer</button>
              </form>
            )}
          </section>

          <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Move the base</h2>
            <p className="mt-2 text-sm text-ink-2">When a member raises your flag at another pole, it appears here for {hours(REBIND_CONFIRM_MS)}. Confirming moves the base; the old pole goes public after {days(RELEASED_POLE_GRACE_MS)}. One move per {days(REBIND_COOLDOWN_MS)}.</p>
            {rebindCandidates.length === 0 ? <p className="mt-2 text-sm text-ink-2">No recent raise elsewhere.</p> : (
              <ul className="mt-2 flex flex-col gap-2">
                {rebindCandidates.map((c) => (
                  <li key={c.poleKey} className="flex items-center justify-between gap-3 rounded-md border border-rule-2 px-4 py-2 text-sm text-ink">
                    <span>raised by <span className="font-mono">{c.by}</span> {when(c.raisedAt)}</span>
                    <form action="/api/clan/rebind" method="post"><input type="hidden" name="poleKey" value={c.poleKey} /><button className="min-h-[44px] rounded-md bg-gold px-3 font-display text-sm text-ground" type="submit">Move here</button></form>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-4 rounded-lg border border-rust bg-frame p-5">
            <h2 className={label}>Disband</h2>
            <p className="mt-2 text-sm text-ink-2">Irreversible. The flag and the pole return to the pool for anyone to claim; the name and tag are held so nobody can impersonate you. Every member is out, with no cooldown.</p>
            <form className="mt-3" action="/api/clan/disband" method="post">
              <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" className="h-5 w-5" /> Disband {clan.name}.</label>
              <button className="mt-3 min-h-[44px] rounded-md border border-rust px-4 font-display text-ink" type="submit">Disband the clan</button>
            </form>
          </section>
        </>
      )}
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/clan">Your clan</a></p>
    </main>
  );
}
```
The pole key is a coordinate string (`x:y:z`). It rides in a hidden field, is never rendered as text, and the page shows only who raised and when — the same "no coordinates" line `/clan`'s `rebindCandidates` read already draws.

- [ ] **Step 3: Typecheck and test**

Run: `pnpm --filter @factions/web typecheck && pnpm --filter @factions/web test` → green.

- [ ] **Step 4: Commit**

```bash
git add apps/web/app/clan/settings apps/web/app/api/clan
git commit -m "feat(web): /clan/settings — recruiting post, rename, transfer, move, disband"
```

---

### Task 8: Retire the slash commands

**Files:**
- Create: `apps/bot/src/retired-commands.ts`, `apps/bot/test/retired-commands.test.ts`
- Modify: `apps/bot/src/discord.ts`, `apps/bot/src/commands.ts`, `apps/bot/src/config.ts`, `apps/bot/src/ceremony-notify.ts`, `apps/bot/test/discord.test.ts`, `apps/bot/test/commands.test.ts`, `apps/bot/test/config.test.ts`, `apps/bot/test/ceremony-notify.test.ts`, `apps/bot/test/vocabulary.test.ts`, `apps/bot/README.md`
- Delete: `apps/bot/src/roster-commands.ts`, `apps/bot/src/faction-commands.ts`, `apps/bot/src/rebind-commands.ts`, `apps/bot/src/roster-context.ts`, `apps/bot/test/roster-commands.test.ts`, `apps/bot/test/faction-commands.test.ts`, `apps/bot/test/rebind-commands.test.ts`, `apps/bot/test/rebind-discord.test.ts`, `apps/bot/test/roster-context.test.ts`, `apps/bot/test/faction-wiring.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // retired-commands.ts
  export const RETIRED_COMMANDS = ["link", "unlink", "whoami", "faction"] as const;
  export const RETIRED_DESCRIPTION = "Retired — manage this on the site.";
  export function retiredPath(commandName: string, subcommand: string | null): string;
  export function retiredReply(siteBaseUrl: string, commandName: string, subcommand: string | null): Reply;  // { content: `Manage this on the site: ${url}`, ephemeral: true }
  // config.ts
  BotConfig.siteBaseUrl: string   // SITE_BASE_URL, default "https://dayzclanwars.com", validated like FLAG_IMAGE_BASE_URL (bare origin)
  // ceremony-notify.ts
  export function formatCeremonyDm(c: { id: number; poleKey: string; participants: { gamertag: string }[]; expiresAt: Date }, siteBaseUrl: string): string;
  ```
- Consumes: spec §9.1 (one line and a link), §9.4 `ceremony_detected` wording.

- [ ] **Step 1: Failing tests**

`apps/bot/test/retired-commands.test.ts`:
```ts
import { describe, it, expect } from "vitest";
import { retiredPath, retiredReply, RETIRED_COMMANDS } from "../src/retired-commands.js";
import { buildCommands } from "../src/discord.js";

describe("retired commands", () => {
  it("registers exactly the four old names, bare, so a stale client gets a pointer and not 'unknown command'", () => {
    const cmds = buildCommands();
    expect(cmds.map((c) => c.name).sort()).toEqual([...RETIRED_COMMANDS].sort());
    for (const c of cmds) expect((c as { options?: unknown[] }).options ?? []).toEqual([]);
  });
  it("points each command at the page that replaced it", () => {
    expect(retiredPath("link", null)).toBe("/link");
    expect(retiredPath("unlink", null)).toBe("/me");
    expect(retiredPath("whoami", null)).toBe("/me");
    expect(retiredPath("faction", "claim")).toBe("/me");
    expect(retiredPath("faction", "invites")).toBe("/me");
    expect(retiredPath("faction", "info")).toBe("/clans");
    expect(retiredPath("faction", "roster")).toBe("/clans");
    expect(retiredPath("faction", "rename")).toBe("/clan/settings");
    expect(retiredPath("faction", "rebind")).toBe("/clan/settings");
    expect(retiredPath("faction", "invite")).toBe("/clan");
    expect(retiredPath("faction", null)).toBe("/clan");
  });
  it("answers with one line and a link, ephemerally", () => {
    const r = retiredReply("https://dayzclanwars.com", "faction", "kick");
    expect(r).toEqual({ content: "Manage this on the site: https://dayzclanwars.com/clan", ephemeral: true });
  });
});
```
`apps/bot/test/ceremony-notify.test.ts` — the assertion at line ~51 becomes `expect(text).toContain("https://dayzclanwars.com/claim/7")` with the fixture given `id: 7` and `formatCeremonyDm({...}, "https://dayzclanwars.com")`; the comment on line ~65 says "any one of them can claim on the site". Wherever `notifyCeremonies` is called in that test, pass the site base URL the same way `notifyCeremonies` now takes it (see Step 3).
`apps/bot/test/config.test.ts` — add:
```ts
  describe("SITE_BASE_URL", () => {
    it("defaults to the production site", () => { expect(loadConfig(env()).siteBaseUrl).toBe("https://dayzclanwars.com"); });
    it("accepts a bare origin and rejects a path", () => {
      expect(loadConfig({ ...env(), SITE_BASE_URL: "http://localhost:3000" }).siteBaseUrl).toBe("http://localhost:3000");
      expect(() => loadConfig({ ...env(), SITE_BASE_URL: "https://x.y/clan" })).toThrow(/bare origin/u);
    });
  });
```
(`env()` is whatever complete-environment helper the file already uses.) Remove the tests for `BOT_RESERVATION_TTL_MS`, `BOT_INVITE_TTL_MS`, `BOT_COOLDOWN_MS`, `BOT_RENAME_COOLDOWN_MS`, `BOT_REBIND_COOLDOWN_MS` ("defaults the roster durations", "accepts overridden roster durations", "defaults the reservation window", the two rebind-cooldown tests) — those fields go with the handlers that read them.
`apps/bot/test/discord.test.ts` — delete the `buildCommands` cases "declares link, unlink, whoami and faction", "registers every roster subcommand", "registers /link with a required autocompleting gamertag option", "truncates a choice name…"; delete the whole `describe("routeInteraction")` and `describe("playerSuggestions")`; keep "gives every command a description", `notifyCompleted`, `guardedRunner`, `createNicknameApplier`, "dormancy modules load…". Drop the now-unused imports (`routeInteraction`, `LINK_NEW_SEQUENCE_OPTION`, `playerSuggestions`, `CommandDeps` if unused).
`apps/bot/test/commands.test.ts` — delete every test of `handleLink`, `handleUnlink`, `handleWhoami` (the whole file if nothing else remains; `formatSequence` tests, if any, stay).
`apps/bot/test/vocabulary.test.ts`:
```ts
const PLAYER_FACING = [
  "feed-embed.ts", "ceremony-notify.ts", "dormancy-notify.ts", "notify.ts",
  // Increment 2c-b: the one reply every retired command gives.
  "retired-commands.ts",
];
```
and delete the `SLASH_COMMAND` constant, its comment, and `.replace(SLASH_COMMAND, "")` in `offendersIn`.

- [ ] **Step 2: Run to see them fail**

Run: `pnpm --filter @factions/bot exec tsc --noEmit -p .` → `retired-commands.js` missing; the vocabulary test's `faction-commands.ts` entry is gone so it passes trivially until Step 3 deletes the file — fine.

- [ ] **Step 3: Implement**

`apps/bot/src/retired-commands.ts`:
```ts
import type { Reply } from "./commands.js";

/**
 * Spec §9.1: every slash command is retired in one step and, until removed
 * from the application, answers ephemerally with one line and a link. The
 * names stay registered — bare, no options — so a client with a stale
 * command list gets this pointer and not Discord's "unknown command".
 */
export const RETIRED_COMMANDS = ["link", "unlink", "whoami", "faction"] as const;
export const RETIRED_DESCRIPTION = "Retired — manage this on the site.";

/** Where the thing this command used to do lives now. */
export function retiredPath(commandName: string, subcommand: string | null): string {
  if (commandName === "link") return "/link";
  if (commandName === "unlink" || commandName === "whoami") return "/me";
  switch (subcommand) {
    case "claim": case "invites": return "/me";
    case "info": case "roster": return "/clans";
    case "rename": case "transfer": case "disband": case "rebind": return "/clan/settings";
    default: return "/clan";
  }
}

export function retiredReply(siteBaseUrl: string, commandName: string, subcommand: string | null): Reply {
  return { content: `Manage this on the site: ${siteBaseUrl}${retiredPath(commandName, subcommand)}`, ephemeral: true };
}
```
`apps/bot/src/discord.ts`:
- `buildCommands()` becomes `return RETIRED_COMMANDS.map((name) => new SlashCommandBuilder().setName(name).setDescription(RETIRED_DESCRIPTION).toJSON());`.
- Delete: `LINK_GAMERTAG_OPTION`, `LINK_NEW_SEQUENCE_OPTION`, `INTERACTION_FAILURE_MESSAGE`, `apologiseForFailure`, `ApologisableInteraction`, `InteractionLike`, `routeInteraction`, `CLAIM_PREFIX`/`claimCustomId`/`parseClaimCustomId`, `ComponentLike`, `routeComponent`, `SelectInteractionLike`, `respondToClaimConfirm`, `MAX_PRUNE_OPTIONS`, `planClaimReply`, `flagSuggestions`, `playerSuggestions`, `serverChoices`, every `*_PREFIX`/`*CustomId`/`parse*CustomId` for invite/transfer/disband/rebind, `parseIdSuffix`, `ButtonInteractionLike`, `routeRosterButton`, `routeRebindButton`, `inviteButtons`, `planRosterButtons`, `RosterButtonSpec`, `deliverInviteDm`, `FollowUpLike`, and in `start()`: `renderFactionReply`, `renderRosterReply`, `rosterDeps`, `rebindDeps`, `factionDeps`, `rosterStore` if only they used it. Keep: `notifyCompleted` and its helpers (`lockedOutMessage`, `alreadyLinkedMessage`, `nicknameOutcomeSuffix`, `ORDINALS`), `createNicknameApplier`, `guardedRunner`, `createFeedPoster`, `start`, the tick wiring.
- The `interactionCreate` listener becomes:
  ```ts
  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isAutocomplete()) { await interaction.respond([]); return; }
      if (interaction.isChatInputCommand()) {
        const sub = interaction.options.getSubcommand(false);
        const reply = retiredReply(cfg.siteBaseUrl, interaction.commandName, sub);
        await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral });
        return;
      }
      // Buttons and selects on old DMs (invite accept, claim confirm, rebind confirm): the same pointer.
      if (interaction.isMessageComponent()) {
        const reply = retiredReply(cfg.siteBaseUrl, "faction", interaction.customId.startsWith("invite-") ? "invites" : null);
        await interaction.reply({ content: reply.content, flags: MessageFlags.Ephemeral });
      }
    } catch (err) {
      // ⚠️ discord.js does not await this listener; an uncaught throw is an unhandled rejection that takes the bot down. Log and drop the one interaction.
      console.error(`interaction failed`, err);
    }
  });
  ```
- The `deps: CommandDeps` object in `start()` shrinks to what `notifyCompleted` still reads (`store`, `now`, and `clearNickname`/renamer if it uses them — check `notifyCompleted`'s parameter list and pass exactly that).
`apps/bot/src/commands.ts`: delete `handleLink`, `handleUnlink`, `handleWhoami`, `LinkContext`, `challengeMessage`, `COUNT_WORDS`/`countWord` if only `challengeMessage` used them, and the `releaseBases`/`clearNickname`/`challengeTtlMs`/`rng` members of `CommandDeps` if nothing else reads them (`grep -n "deps\.\(rng\|challengeTtlMs\|releaseBases\|clearNickname\)" apps/bot/src` decides). Keep `Reply`, `CommandDeps`, `formatSequence`. `apps/bot/src/declaration-wiring.ts`'s `releaseSoloBasesFor` stays if any tick uses it; delete it and its test if only `/unlink` did (`grep -rn releaseSoloBasesFor apps/bot/src`).
`apps/bot/src/config.ts`: add to `BotConfig` `siteBaseUrl: string` and in `loadConfig` `siteBaseUrl: optionalHttpUrl(env, "SITE_BASE_URL") ?? "https://dayzclanwars.com",` (the existing validator already rejects a path; widen its error text from "The bot appends /flags/<texture>.png itself" to "The bot appends the page path itself"). Remove `reservationTtlMs`, `inviteTtlMs`, `cooldownMs`, `renameCooldownMs`, `rebindCooldownMs` and the `RELEASE_GRACE_MS` check block, together with their now-unused imports. Keep `challengeTtlMs` only if `grep -rn challengeTtlMs apps/bot/src` still finds a reader after the deletions; otherwise remove it and its config tests too.
`apps/bot/src/ceremony-notify.ts`: `formatCeremonyDm(c, siteBaseUrl)` — the line `"Any one of you can found the clan with `/faction claim`."` becomes `` `Any one of you can found the clan on the site: ${siteBaseUrl}/claim/${c.id}` `` (spec §9.4 `ceremony_detected`); `notifyCeremonies` gains a `siteBaseUrl: string` parameter and passes `c.id`; `discord.ts` passes `cfg.siteBaseUrl`. Mention `/link` in the "If someone is missing…" line as "had not linked on the site".
`apps/bot/README.md`: env table — add `| SITE_BASE_URL | no (default https://dayzclanwars.com) | Bare origin of the site. Every retired slash command and the ceremony DM point players here. |`; delete the rows for the removed variables. Under Running, replace "This registers the `/link`, `/unlink`, and `/whoami` commands…" with: "This registers `/link`, `/unlink`, `/whoami` and `/faction` as bare, retired commands — each answers with one line pointing at the site (spec §9.1) — logs in, and starts the tick loops…". Delete any remaining section documenting `/faction` subcommands.

- [ ] **Step 4: Delete the retired modules and run the bot suite**

```bash
git rm apps/bot/src/roster-commands.ts apps/bot/src/faction-commands.ts apps/bot/src/rebind-commands.ts apps/bot/src/roster-context.ts \
  apps/bot/test/roster-commands.test.ts apps/bot/test/faction-commands.test.ts apps/bot/test/rebind-commands.test.ts \
  apps/bot/test/rebind-discord.test.ts apps/bot/test/roster-context.test.ts apps/bot/test/faction-wiring.test.ts
```
Then `pnpm --filter @factions/bot exec tsc --noEmit -p .` — fix every dangling import it names (the compile is the checklist). Then `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" pnpm --filter @factions/bot test` → green. `grep -rn "faction claim\|/faction " apps/bot/src` → nothing.

⚠️ The store tests (`roster-invites`, `roster-lifecycle`, `roster-races`, `roster-requests`, `roster-roles`, `roster-departures`, `roster-store`, `feed-writers-*`, `rebind-store`, `rebind`, `presence-tick`, `ceremony-store`) stay: they test `@factions/roster/internal`, which the bot's ticks and the site both depend on.

- [ ] **Step 5: Commit**

```bash
git add -A apps/bot
git commit -m "feat(bot): retire every slash command — one line and a link; the ceremony DM points at /claim"
```

---

### Task 9: Runbook, CLAUDE.md, README, spec §15

**Files:**
- Create: `docs/deploy/2026-09-05-site-roster.md`
- Modify: `CLAUDE.md`, spec §15 (`docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md`), `docs/superpowers/plans/2026-09-05-roster-package.md` (only if it names `2026-09-xx-site-roster.md`)

- [ ] **Step 1: Runbook**

`docs/deploy/2026-09-05-site-roster.md`:
```markdown
# The site as the tool (increment 2c-b) — deploy runbook

No migration. Two deployables, **together**: the web image gains `/clans`, `/clans/{tag}`,
`/clan`, `/clan/settings`, `/claim/{ceremony}` and the fuller `/me`; the bot retires every
slash command in the same step (spec §15 ⚠️: never before the pages exist, so no capability
is lost between two deploys).

Prerequisites: 2b (`docs/deploy/2026-09-05-site-link-and-base.md`, migration 0021) and 2c-a
(`docs/deploy/2026-09-05-roster-package.md`, migration 0022) applied and running.

1. **Env.** Add `SITE_BASE_URL=https://dayzclanwars.com` to the bot's `.env` (optional; that
   is the default). Remove `BOT_RESERVATION_TTL_MS`, `BOT_INVITE_TTL_MS`, `BOT_COOLDOWN_MS`,
   `BOT_RENAME_COOLDOWN_MS`, `BOT_REBIND_COOLDOWN_MS` if set — nothing reads them now.
2. **Build the web image first** (`docker compose build web`) so the swap is one `up`.
3. **Swap.** `docker compose up -d web && sudo systemctl restart clan-wars-bot`. The bot
   re-registers its four command names bare on start; Discord clients pick the change up
   within a minute.
4. **Confirm the bot:** `journalctl -u clan-wars-bot -f` shows the registration and the
   ticks; in Discord, `/faction` (any) and `/link` answer `Manage this on the site: …`.
5. **Confirm the site:** `/clans` anonymously (public, live); `/clans/<tag>` shows the roster
   and no coordinates; signed in, `/clan` renders your roster; `/clan/settings` refuses a
   member and admits an officer.
6. **Acceptance.** From a test account: invite by gamertag on `/clan` → the invitee sees it
   on `/me` → Accept → pending on both pages → stand at the base → full within a tick.
   Rename with a held tag → refused with the hold sentence. Then the dormancy check from
   `docs/deploy/2026-09-05-declarations.md` step 9, with `select count(*) from factions`.
7. **What did not change.** No Discord role, channel or notice on any roster event
   (increment 3). The ceremony DM now links to `/claim/{id}`; every other DM is unchanged.
```

- [ ] **Step 2: CLAUDE.md**

- In the "Web app" bullet (around line 101–113): after "Since 2b the roster package also writes…" add: "Since 2c-b the site is the tool: `/clans`, `/clans/{tag}`, `/clan`, `/clan/settings`, `/claim/{ceremony}` and `/me` call the package's 34 exports through form POSTs to `apps/web/app/api/**` (`lib/form.ts`; codes looked up in `lib/clan-copy.ts`). Every Discord slash command is retired and answers with one line and a link (`apps/bot/src/retired-commands.ts`, `SITE_BASE_URL`)."
- The "Pole coordinates are a raid target" bullet (~233): replace "gated to faction members in `/faction info` and kept out of DMs. Every Discord command reply is ephemeral…" with "gated to the viewer's own `/base`; no clan page, DM or feed row carries one (`rebindCandidates` carry pole keys in hidden form fields, never rendered)."
- The "Roster membership is PUBLIC" bullet (~236): replace "`/faction roster name:<rival>` listing another faction's members to anyone" with "`/clans/{tag}` listing any clan's members (gamertag and rank) to anyone".
- The "website is a surface" bullet (~271): replace "(the `/me` read, and since 2c-a every roster write, through `packages/roster`)" with "(every roster read and write, since 2c-b from the pages themselves)".
- Current-state section: add a paragraph "**Increment 2c-b is merged.** The slash commands are retired; roster administration happens on the site. Not deployed until the runbook `docs/deploy/2026-09-05-site-roster.md` runs, together with 2b and 2c-a."
- Any remaining `/faction …` command reference in CLAUDE.md is rewritten to the page that replaced it (`grep -n "/faction\|/link\b\|/unlink\|/whoami" CLAUDE.md`).

- [ ] **Step 3: Spec §15 and the 2c-a plan**

In the spec's §15 table, row 2c-b: plan file `2026-09-xx-site-roster.md` → `2026-09-05-site-roster.md`. In `docs/superpowers/plans/2026-09-05-roster-package.md`, if it names `2026-09-xx-site-roster.md`, update it the same way.

- [ ] **Step 4: Gate and commit**

Run the full gate from the repo root: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` → 26 successful, 26 total.

```bash
git add docs/deploy/2026-09-05-site-roster.md CLAUDE.md docs/superpowers/specs/2026-09-04-clan-wars-target-state-design.md docs/superpowers/plans/2026-09-05-roster-package.md
git commit -m "docs: 2c-b runbook; CLAUDE.md and spec §15 for the site as the tool"
```

---

## Self-review

**Spec coverage.** §10.2 public `/clans` and `/clans/{tag}` (Task 3; season placements, Alpha weeks and stats columns wait for increments 4 and 6 — the page shows what exists: flag, tag, status, founded, roster, recruiting post, Request to join). §10.2 linked `/me` (Task 4: link, clan or solo base, unlink, open invites; "cooldowns" is expressed through the result copy, not a separate read — the package exposes no cooldown read and this plan adds no export), `/claim/{ceremony}` (Task 5). §10.2 clan `/clan` (Task 6: roster with last seen, pending, invites out and requests in, leave; votes and succession are increment 7), `/clan/settings` officer+ recruiting post and leader rename/transfer/rebind/disband with confirmations (Task 7; guest passes are increment 7). §9.1 retired commands with one line and a link (Task 8). §15 row 2c-b: `/faction` exclusion and the 1 h window removed (Tasks 8 and 1). §10.1 pending is not clan-level: `/clan` shows a pending member the roster and no actions (`officer`/`leader` require `me.status === "full"`), `/clan/settings` refuses them, and every write refuses through `actorFor`'s `"pending"`.

**Placeholders.** None: every route has its body and every page its markup; the copy table is complete for each outcome union by construction.

**Type consistency.** `invite(actor, { gamertag })` is introduced in Task 1 and consumed in Task 6. `code(action, outcome)` and `RESULT_COPY` are Task 2's and used by Tasks 3–7 with the action names Task 2's `TABLES` defines (`invite, revoke, accept, decline, request, withdraw, decide, leave, kick, role, transfer, disband, rename, recruiting, rebind, claim, input`). `formAction`'s `run` returns `string | { back; code }`; Tasks 5, 6 and 7 use both forms. `formatCeremonyDm(c, siteBaseUrl)` and `notifyCeremonies(…, siteBaseUrl)` agree between Task 8's source and test steps. `selectCandidates`' required `windowMs` (Task 1) is already passed by `writes.ts` and `reads.ts`.
