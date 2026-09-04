# Discord Login Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate every page of `dayzclanwars.com` except `/` behind a Discord login, with guild membership as the gate and a consented join path for non-members.

**Architecture:** OAuth authorization code flow via `arctic` (confidential client, no PKCE). The session is an encrypted JWE cookie holding identity only — there is no server-side session store and no database access. Middleware decrypts the cookie on every gated request and re-verifies guild membership against Discord at most every 15 minutes using our own bot token, so no user access token is ever persisted.

**Tech Stack:** Next.js 16.3.4 (App Router), TypeScript, `arctic@3.7.0`, `jose@6.2.10`, vitest (node environment, no jsdom).

**Spec:** `docs/superpowers/specs/2026-09-04-discord-login-design.md`

## Global Constraints

- **`apps/web` imports no database package and reads no `DATABASE_URL`.** `apps/web/test/smoke.test.ts` enforces this. It is the only thing keeping this app away from `factions_live`, which is one loopback port away.
- **No secret may be prefixed `NEXT_PUBLIC_`.** That prefix inlines the value into the client bundle.
- **The full gate is `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force`, and it must report 22/22 tasks, 0 cached.** A cached pass proves nothing — check the count, not the exit code.
- **Session cookie:** `cw_session`, JWE `dir` + `A256GCM`, `httpOnly`, `sameSite=lax`, 7-day life. `secure` only when `WEB_BASE_URL` is https (so `pnpm dev` on http://localhost:3000 still works).
- **Re-check cadence:** success → `nextCheckAt = now + 900`; failure → `now + 60`.
- **Deploy is `docker compose up -d web` and nothing else.** A bare `up -d` starts services this change has no business restarting.
- **Env vars, all already present in `/opt/clan-wars/.env`:** `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_JOIN_BOT_TOKEN`, `SESSION_SECRET` (base64 of 32 random bytes), `WEB_BASE_URL`, `DISCORD_GUILD_ID`.

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/lib/auth/cookies.ts` | Cookie names, lifetimes, attribute builders. No I/O. |
| `apps/web/lib/auth/next-path.ts` | Validates a `?next=` value is a site-relative path. Pure. |
| `apps/web/lib/auth/session.ts` | JWE encode/decode of the session payload. |
| `apps/web/lib/auth/membership.ts` | The re-check decision table. Pure — takes a status, returns an outcome. |
| `apps/web/lib/auth/discord.ts` | The arctic client and the two Discord REST calls. The only file that does network I/O. |
| `apps/web/lib/auth/gate.ts` | The public allowlist and the `pathIsPublic` predicate. Pure. |
| `apps/web/middleware.ts` | Wires gate + session + membership into the request path. |
| `apps/web/app/api/auth/discord/route.ts` | Starts OAuth. |
| `apps/web/app/api/auth/callback/route.ts` | Verifies state, exchanges, sets session. |
| `apps/web/app/api/auth/logout/route.ts` | Clears the session. POST only. |
| `apps/web/app/components/sign-in-card.tsx` | The card, shared by `/login` and the `/link` prototype. |
| `apps/web/app/login/page.tsx` | Sign-in screen. |
| `apps/web/app/join/page.tsx` | "Join and continue" screen. |

The `lib/auth/` split exists so the logic is testable without a browser: `cookies`, `next-path`, `membership` and `gate` are pure, `session` is pure-plus-crypto, and only `discord.ts` touches the network. `apps/web` tests are node-only with no jsdom, so anything not extracted this way is untestable.

---

### Task 1: Cookie constants, and close the smoke test's blind spot

⚠️ This task is first because of the blind spot, not because of the cookies. `smoke.test.ts` scans `app/` and `src/` only. Every file in this plan lands in `lib/` or at the package root, so today the guard would watch none of it. The cookie module is the smallest real file that proves the extension works.

**Files:**
- Create: `apps/web/lib/auth/cookies.ts`
- Modify: `apps/web/test/smoke.test.ts`
- Test: `apps/web/test/auth-cookies.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `SESSION_COOKIE: string`, `STATE_COOKIE: string`, `SESSION_MAX_AGE_SECONDS: number`, `STATE_MAX_AGE_SECONDS: number`, `type CookieAttributes`, `sessionCookieAttributes(baseUrl: string): CookieAttributes`, `stateCookieAttributes(baseUrl: string): CookieAttributes`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/auth-cookies.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  STATE_MAX_AGE_SECONDS,
  sessionCookieAttributes,
  stateCookieAttributes,
} from "../lib/auth/cookies";

describe("session cookie attributes", () => {
  it("is httpOnly and sameSite=lax", () => {
    const a = sessionCookieAttributes("https://dayzclanwars.com");
    // ⚠️ httpOnly is what stops any script on the page reading the session.
    expect(a.httpOnly).toBe(true);
    // ⚠️ lax, NOT strict: the OAuth callback is a cross-site top-level
    // navigation back from Discord, and strict drops the cookie on exactly
    // that redirect — the login would appear to succeed and then not.
    expect(a.sameSite).toBe("lax");
    expect(a.path).toBe("/");
  });

  it("is secure over https", () => {
    expect(sessionCookieAttributes("https://dayzclanwars.com").secure).toBe(true);
  });

  it("is not secure over plain-http localhost, or dev could never log in", () => {
    expect(sessionCookieAttributes("http://localhost:3000").secure).toBe(false);
  });

  it("lasts seven days", () => {
    expect(SESSION_MAX_AGE_SECONDS).toBe(60 * 60 * 24 * 7);
    expect(sessionCookieAttributes("https://x.test").maxAge).toBe(SESSION_MAX_AGE_SECONDS);
  });

  it("uses a short life for the state cookie", () => {
    expect(STATE_MAX_AGE_SECONDS).toBe(600);
    expect(stateCookieAttributes("https://x.test").maxAge).toBe(600);
  });

  it("names the cookies distinctly", () => {
    expect(SESSION_COOKIE).toBe("cw_session");
    expect(STATE_COOKIE).toBe("cw_oauth_state");
    expect(SESSION_COOKIE).not.toBe(STATE_COOKIE);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --root apps/web test/auth-cookies.test.ts
```

Expected: FAIL — `Cannot find module '../lib/auth/cookies'`.

- [ ] **Step 3: Write the module**

Create `apps/web/lib/auth/cookies.ts`:

```typescript
/**
 * Cookie names, lifetimes and attributes for the Discord login.
 *
 * ⚠️ No I/O and no environment reads. Everything is a parameter so the
 * attributes can be asserted directly — `apps/web` tests are node-only with no
 * browser, so a cookie flag that is not tested here is not tested anywhere.
 */

export const SESSION_COOKIE = "cw_session";
export const STATE_COOKIE = "cw_oauth_state";

/** Seven days. See spec §2.6 — roughly one login per active player per week. */
export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

/** Ten minutes: long enough to read a consent screen, short enough to not linger. */
export const STATE_MAX_AGE_SECONDS = 600;

export type CookieAttributes = {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax";
  path: string;
  maxAge: number;
};

/**
 * ⚠️ `secure` is derived from the origin rather than hardcoded true. A `secure`
 * cookie is silently dropped over plain http, so hardcoding it would make
 * `pnpm dev` on http://localhost:3000 unable to log in at all — and the
 * symptom is a login that redirects successfully and arrives signed out.
 */
function base(baseUrl: string, maxAge: number): CookieAttributes {
  return {
    httpOnly: true,
    secure: baseUrl.startsWith("https://"),
    // ⚠️ lax, never strict. The OAuth callback is a cross-site top-level
    // navigation back from Discord; strict withholds the cookie on it.
    sameSite: "lax",
    path: "/",
    maxAge,
  };
}

export function sessionCookieAttributes(baseUrl: string): CookieAttributes {
  return base(baseUrl, SESSION_MAX_AGE_SECONDS);
}

export function stateCookieAttributes(baseUrl: string): CookieAttributes {
  return base(baseUrl, STATE_MAX_AGE_SECONDS);
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd /opt/clan-wars && npx vitest run --root apps/web test/auth-cookies.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Prove the smoke test does NOT yet see `lib/`**

Add this test to `apps/web/test/smoke.test.ts`, inside the existing `describe`:

```typescript
  it("scans lib/ and the package root, where the auth code lives", () => {
    const scanned = sources.map((s) => s.file);
    expect(scanned.some((f) => f.includes(`${sep}lib${sep}auth${sep}cookies.ts`))).toBe(true);
  });
```

Add `sep` to the existing node:path import:

```typescript
import { join, sep } from "node:path";
```

Run it:

```bash
cd /opt/clan-wars && npx vitest run --root apps/web test/smoke.test.ts
```

Expected: FAIL — the new test returns false, because `ROOTS` covers only `app/` and `src/`.

- [ ] **Step 6: Extend the roots so the guard covers the new code**

In `apps/web/test/smoke.test.ts`, replace the `ROOTS` constant and the `sources` builder:

```typescript
// ⚠️ Every directory that can hold app code, not just `app/`. `src/` didn't
// exist when this test was written; `lib/` and the package root didn't exist
// when the auth code was added, and Next puts `middleware.ts` at the package
// ROOT — outside every directory this used to scan. A directory added later
// that isn't listed here is scanned by nothing, silently.
const ROOTS = [
  join(import.meta.dirname, "..", "app"),
  join(import.meta.dirname, "..", "src"),
  join(import.meta.dirname, "..", "lib"),
];

/** Root-level source files (middleware.ts, next.config.ts) — not a directory walk. */
const ROOT_FILES = readdirSync(join(import.meta.dirname, ".."), { encoding: "utf8" })
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts"))
  .map((f) => join(import.meta.dirname, "..", f));
```

Then replace the `sources` assignment with one that includes them:

```typescript
  const sources = [
    ...ROOTS.filter((root) => existsSync(root)).flatMap((root) =>
      readdirSync(root, { recursive: true, encoding: "utf8" })
        .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
        .map((f) => join(root, f)),
    ),
    ...ROOT_FILES,
  ].map((file) => ({ file, text: readFileSync(file, "utf8") }));
```

- [ ] **Step 7: Run the whole web suite**

```bash
cd /opt/clan-wars && npx vitest run --root apps/web
```

Expected: PASS. `smoke.test.ts` now reports more source files than before and the new assertion passes.

- [ ] **Step 8: Commit**

```bash
cd /opt/clan-wars
git add apps/web/lib/auth/cookies.ts apps/web/test/auth-cookies.test.ts apps/web/test/smoke.test.ts
git commit -m "feat(web): auth cookie constants, and close the smoke test's blind spot

⚠️ smoke.test.ts scanned app/ and src/ only, and Next puts middleware.ts at the
package root. Every server-side file the Discord login adds would have landed
where the one guard keeping this app away from factions_live does not look.
Its own docblock warns that a directory added later is scanned by nothing,
silently; this is that, having happened to the test itself.

The cookie module is the smallest real file that proves the extension works.
secure is derived from the origin rather than hardcoded, because a secure
cookie is dropped over plain http and pnpm dev would be unable to log in --
presenting as a login that redirects fine and arrives signed out."
```

---

### Task 2: `next` path validation

**Files:**
- Create: `apps/web/lib/auth/next-path.ts`
- Test: `apps/web/test/auth-next-path.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `safeNextPath(raw: string | null | undefined): string` — returns a site-relative path, or `"/"` when the input is anything else.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/auth-next-path.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { safeNextPath } from "../lib/auth/next-path";

describe("safeNextPath", () => {
  it("keeps an ordinary site-relative path", () => {
    expect(safeNextPath("/mobile")).toBe("/mobile");
    expect(safeNextPath("/link")).toBe("/link");
    expect(safeNextPath("/mobile?tab=map")).toBe("/mobile?tab=map");
  });

  it("falls back to / for nothing", () => {
    expect(safeNextPath(null)).toBe("/");
    expect(safeNextPath(undefined)).toBe("/");
    expect(safeNextPath("")).toBe("/");
  });

  // ⚠️ The whole point of this module. An unchecked ?next= turns the login
  // endpoint into an open redirect: a link to our own domain that lands the
  // player on someone else's, having just been asked to trust us.
  it("refuses absolute URLs", () => {
    expect(safeNextPath("https://evil.example/x")).toBe("/");
    expect(safeNextPath("http://evil.example")).toBe("/");
  });

  it("refuses protocol-relative URLs", () => {
    // Browsers read //evil.example as https://evil.example.
    expect(safeNextPath("//evil.example")).toBe("/");
    expect(safeNextPath("//evil.example/path")).toBe("/");
  });

  it("refuses backslash variants some browsers normalise to slashes", () => {
    expect(safeNextPath("\\\\evil.example")).toBe("/");
    expect(safeNextPath("/\\evil.example")).toBe("/");
  });

  it("refuses anything not starting with a single slash", () => {
    expect(safeNextPath("mobile")).toBe("/");
    expect(safeNextPath("javascript:alert(1)")).toBe("/");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /opt/clan-wars && npx vitest run --root apps/web test/auth-next-path.test.ts
```

Expected: FAIL — `Cannot find module '../lib/auth/next-path'`.

- [ ] **Step 3: Write the module**

Create `apps/web/lib/auth/next-path.ts`:

```typescript
/**
 * Validates the `?next=` value the login flow carries around.
 *
 * ⚠️ This is the open-redirect guard. `?next=` is attacker-controlled: it
 * arrives in a URL anyone can send to anyone. Without this, a link to
 * dayzclanwars.com bounces the player to an attacker's site immediately after
 * we have asked them to trust us with a Discord consent screen, which is the
 * best possible moment to phish someone.
 *
 * Allow exactly one shape: a single leading slash NOT followed by another
 * slash or a backslash. Everything else becomes "/".
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  // ⚠️ "//host" is protocol-relative and browsers treat it as absolute.
  // "/\host" is normalised to "//host" by some browsers. Both are off-site.
  if (raw.startsWith("//") || raw.startsWith("/\\")) return "/";
  return raw;
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd /opt/clan-wars && npx vitest run --root apps/web test/auth-next-path.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
cd /opt/clan-wars
git add apps/web/lib/auth/next-path.ts apps/web/test/auth-next-path.test.ts
git commit -m "feat(web): validate the ?next= redirect target

⚠️ The open-redirect guard. ?next= arrives in an attacker-controllable URL, and
an unchecked one bounces a player off-site immediately after we asked them to
trust us with a Discord consent screen. Allows a single leading slash only:
//host is protocol-relative and /\\host is normalised to it by some browsers."
```

---

### Task 3: The session cookie payload

**Files:**
- Create: `apps/web/lib/auth/session.ts`
- Test: `apps/web/test/auth-session.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type Session = { sub: string; name: string; avatar: string | null; guild: boolean; nextCheckAt: number }`, `sessionKey(secret: string): Uint8Array`, `encodeSession(session: Session, key: Uint8Array): Promise<string>`, `decodeSession(token: string, key: Uint8Array): Promise<Session | null>`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/auth-session.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { EncryptJWT } from "jose";
import { sessionKey, encodeSession, decodeSession, type Session } from "../lib/auth/session";

// 32 random bytes, base64 — the shape `openssl rand -base64 32` produces.
const SECRET = "5S9y0kZ0Yb0k7t0mQ0nT0pV0sX0uZ0wA0yC0eF0gH0k=";
const OTHER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

const session: Session = {
  sub: "1545252643155353640",
  name: "SubatomicRacer",
  avatar: "a1b2c3",
  guild: true,
  nextCheckAt: 1_800_000_000,
};

describe("sessionKey", () => {
  it("decodes a 32-byte base64 secret", () => {
    expect(sessionKey(SECRET)).toHaveLength(32);
  });

  it("refuses a secret that is not 32 bytes", () => {
    // ⚠️ A short key silently weakens A256GCM instead of failing, so this
    // throws rather than padding. A truncated SESSION_SECRET in .env is the
    // realistic way this happens.
    expect(() => sessionKey("dG9vLXNob3J0")).toThrow(/32 bytes/);
  });
});

describe("session round trip", () => {
  it("decodes what it encoded", async () => {
    const key = sessionKey(SECRET);
    const decoded = await decodeSession(await encodeSession(session, key), key);
    expect(decoded).toEqual(session);
  });

  it("returns null for a token encrypted with a different key", async () => {
    const token = await encodeSession(session, sessionKey(SECRET));
    expect(await decodeSession(token, sessionKey(OTHER))).toBeNull();
  });

  it("returns null for garbage", async () => {
    expect(await decodeSession("not-a-token", sessionKey(SECRET))).toBeNull();
    expect(await decodeSession("", sessionKey(SECRET))).toBeNull();
  });

  it("returns null for an expired token", async () => {
    const key = sessionKey(SECRET);
    const expired = await new EncryptJWT({ ...session })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt(1_600_000_000)
      .setExpirationTime(1_600_000_001)
      .encrypt(key);
    expect(await decodeSession(expired, key)).toBeNull();
  });

  it("returns null when the payload is missing a required field", async () => {
    // ⚠️ A token from an older payload shape decrypts fine and then has holes.
    // Treating it as signed out is right; trusting it would mean `guild`
    // reading undefined and a non-member being let through.
    const key = sessionKey(SECRET);
    const partial = await new EncryptJWT({ sub: "123" })
      .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
      .setIssuedAt()
      .setExpirationTime("7d")
      .encrypt(key);
    expect(await decodeSession(partial, key)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --root apps/web test/auth-session.test.ts
```

Expected: FAIL — `Cannot find module '../lib/auth/session'`.

- [ ] **Step 3: Add the dependencies**

```bash
cd /opt/clan-wars && pnpm --filter @factions/web add jose@6.2.10 arctic@3.7.0
```

- [ ] **Step 4: Write the module**

Create `apps/web/lib/auth/session.ts`:

```typescript
import { EncryptJWT, jwtDecrypt } from "jose";

/**
 * The session cookie's payload.
 *
 * ⚠️ Identity ONLY. Nothing about factions, rosters or entitlement may be
 * cached here. The cookie is written once and read for seven days with no
 * transaction updating it, so any faction fact stored here is a second source
 * of truth that is wrong the moment the first one changes.
 */
export type Session = {
  /** Discord user id (snowflake). */
  sub: string;
  name: string;
  avatar: string | null;
  /** Whether the player is in the Clan Wars guild, as of `nextCheckAt` minus the cadence. */
  guild: boolean;
  /** Epoch seconds after which membership must be re-verified. */
  nextCheckAt: number;
};

/**
 * ⚠️ Decoded with `atob`, not `Buffer`. Middleware runs on the edge runtime
 * where `Buffer` is not guaranteed; this file is imported by middleware.
 */
export function sessionKey(secret: string): Uint8Array {
  const binary = atob(secret);
  if (binary.length !== 32) {
    throw new Error(`SESSION_SECRET must decode to 32 bytes, got ${binary.length}`);
  }
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export async function encodeSession(session: Session, key: Uint8Array): Promise<string> {
  return new EncryptJWT({ ...session })
    .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
    .setIssuedAt()
    .setExpirationTime("7d")
    .encrypt(key);
}

/**
 * ⚠️ Returns null for every failure and never throws or distinguishes them.
 * Tampering, an expired token and a rotated SESSION_SECRET are all just
 * "signed out" to the caller. Reporting which one it was would tell an
 * attacker whether their forgery decrypted.
 */
export async function decodeSession(token: string, key: Uint8Array): Promise<Session | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtDecrypt(token, key);
    if (
      typeof payload.sub !== "string" ||
      typeof payload.name !== "string" ||
      typeof payload.guild !== "boolean" ||
      typeof payload.nextCheckAt !== "number"
    ) {
      return null;
    }
    return {
      sub: payload.sub,
      name: payload.name,
      avatar: typeof payload.avatar === "string" ? payload.avatar : null,
      guild: payload.guild,
      nextCheckAt: payload.nextCheckAt,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run it and watch it pass**

```bash
cd /opt/clan-wars && npx vitest run --root apps/web test/auth-session.test.ts
```

Expected: PASS, 7 tests.

- [ ] **Step 6: Commit**

```bash
cd /opt/clan-wars
git add apps/web/lib/auth/session.ts apps/web/test/auth-session.test.ts apps/web/package.json pnpm-lock.yaml
git commit -m "feat(web): encrypted session cookie payload

JWE, dir + A256GCM, identity only. decodeSession returns null for every
failure without distinguishing them -- tamper, expiry and a rotated
SESSION_SECRET are all just 'signed out', because saying which would tell an
attacker whether their forgery decrypted.

⚠️ A payload missing a field is rejected rather than trusted: an older token
decrypts fine and then has holes, and a missing 'guild' would read undefined
and let a non-member through.

⚠️ The key is decoded with atob rather than Buffer -- middleware runs on the
edge runtime and imports this file."
```

---

### Task 4: The membership decision table, and the Discord calls

**Files:**
- Create: `apps/web/lib/auth/membership.ts`
- Create: `apps/web/lib/auth/discord.ts`
- Test: `apps/web/test/auth-membership.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MembershipOutcome = "member" | "notMember" | "unknown"`
  - `RECHECK_OK_SECONDS = 900`, `RECHECK_BACKOFF_SECONDS = 60`
  - `outcomeForStatus(status: number | "network-error"): MembershipOutcome`
  - `nextCheckAfter(outcome: MembershipOutcome, nowSeconds: number): number`
  - From `discord.ts`: `discordClient(): Discord`, `guildMemberStatus(userId: string): Promise<number | "network-error">`, `addGuildMember(userId: string, accessToken: string): Promise<number | "network-error">`, `currentUser(accessToken: string): Promise<{ id: string; username: string; avatar: string | null } | null>`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/auth-membership.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import {
  outcomeForStatus,
  nextCheckAfter,
  RECHECK_OK_SECONDS,
  RECHECK_BACKOFF_SECONDS,
} from "../lib/auth/membership";

describe("outcomeForStatus", () => {
  it("200 is a member", () => {
    expect(outcomeForStatus(200)).toBe("member");
  });

  it("404 is not a member", () => {
    expect(outcomeForStatus(404)).toBe("notMember");
  });

  // ⚠️ Everything below is "unknown", and unknown NEVER logs anyone out.
  // Spec §2.7: a Discord outage must not become a site outage.
  it("rate limiting is unknown, not a refusal", () => {
    expect(outcomeForStatus(429)).toBe("unknown");
  });

  it("server errors are unknown", () => {
    for (const s of [500, 502, 503, 504]) expect(outcomeForStatus(s)).toBe("unknown");
  });

  it("a network error is unknown", () => {
    expect(outcomeForStatus("network-error")).toBe("unknown");
  });

  // ⚠️ 401/403 mean OUR bot token is wrong or lost its access — our fault, not
  // the player's. Treating them as notMember would log out every player at
  // once the moment someone edited the bot's role.
  it("auth failures against our own bot token are unknown, not notMember", () => {
    expect(outcomeForStatus(401)).toBe("unknown");
    expect(outcomeForStatus(403)).toBe("unknown");
  });
});

describe("nextCheckAfter", () => {
  const now = 1_800_000_000;

  it("waits the full cadence after a definite answer", () => {
    expect(nextCheckAfter("member", now)).toBe(now + RECHECK_OK_SECONDS);
    expect(nextCheckAfter("notMember", now)).toBe(now + RECHECK_OK_SECONDS);
    expect(RECHECK_OK_SECONDS).toBe(900);
  });

  // ⚠️ Backs off rather than leaving the session stale. If a failure left
  // nextCheckAt in the past, every subsequent request would retry and we would
  // hammer a Discord that is already struggling.
  it("backs off briefly after an unknown", () => {
    expect(nextCheckAfter("unknown", now)).toBe(now + RECHECK_BACKOFF_SECONDS);
    expect(RECHECK_BACKOFF_SECONDS).toBe(60);
  });

  it("always moves the check forward", () => {
    for (const o of ["member", "notMember", "unknown"] as const) {
      expect(nextCheckAfter(o, now)).toBeGreaterThan(now);
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /opt/clan-wars && npx vitest run --root apps/web test/auth-membership.test.ts
```

Expected: FAIL — `Cannot find module '../lib/auth/membership'`.

- [ ] **Step 3: Write the decision table**

Create `apps/web/lib/auth/membership.ts`:

```typescript
/**
 * What a guild-membership check means, and when to check again.
 *
 * ⚠️ Pure, and separated from the fetch on purpose. This is where spec §2.7
 * actually lives — "a Discord outage does not log anyone out" is one line of
 * policy that is impossible to test through a network call and trivial to test
 * as a table.
 */

export type MembershipOutcome = "member" | "notMember" | "unknown";

/** Fifteen minutes: a kick takes effect within that, and Discord is not hammered. */
export const RECHECK_OK_SECONDS = 900;

/** One minute: quick recovery from an outage without a retry storm. */
export const RECHECK_BACKOFF_SECONDS = 60;

export function outcomeForStatus(status: number | "network-error"): MembershipOutcome {
  if (status === 200) return "member";
  if (status === 404) return "notMember";
  // ⚠️ 401/403 are about OUR bot token, not the player. If the token is revoked
  // or its role loses access, treating that as "not a member" would sign out
  // every player simultaneously and look exactly like a mass ban.
  return "unknown";
}

export function nextCheckAfter(outcome: MembershipOutcome, nowSeconds: number): number {
  return nowSeconds + (outcome === "unknown" ? RECHECK_BACKOFF_SECONDS : RECHECK_OK_SECONDS);
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd /opt/clan-wars && npx vitest run --root apps/web test/auth-membership.test.ts
```

Expected: PASS, 9 tests.

- [ ] **Step 5: Write the Discord calls**

Create `apps/web/lib/auth/discord.ts`:

```typescript
import { Discord } from "arctic";

/**
 * The only file here that touches the network.
 *
 * ⚠️ Everything it returns is a raw status code, decided elsewhere. The policy
 * lives in `membership.ts` so it can be tested without a network.
 */

const API = "https://discord.com/api/v10";

function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export function discordClient(): Discord {
  return new Discord(
    env("DISCORD_CLIENT_ID"),
    env("DISCORD_CLIENT_SECRET"),
    `${env("WEB_BASE_URL")}/api/auth/callback`,
  );
}

/**
 * ⚠️ Authenticated with OUR bot token, not the player's. This is what lets the
 * 15-minute re-check work forever from a user id alone — no user access token
 * is stored, so there is none to expire or leak.
 */
export async function guildMemberStatus(userId: string): Promise<number | "network-error"> {
  try {
    const res = await fetch(`${API}/guilds/${env("DISCORD_GUILD_ID")}/members/${userId}`, {
      headers: { Authorization: `Bot ${env("DISCORD_JOIN_BOT_TOKEN")}` },
      cache: "no-store",
    });
    return res.status;
  } catch {
    return "network-error";
  }
}

/**
 * Adds the player to the guild. Requires the bot to hold CREATE_INSTANT_INVITE
 * and the access token to carry the `guilds.join` scope.
 *
 * ⚠️ Discord requires the bot token and the access token to belong to the SAME
 * application — which is why the web app has its own Discord application
 * rather than borrowing the game bot's token.
 *
 * 201 = added, 204 = already a member, 403 = banned from the guild.
 */
export async function addGuildMember(
  userId: string,
  accessToken: string,
): Promise<number | "network-error"> {
  try {
    const res = await fetch(`${API}/guilds/${env("DISCORD_GUILD_ID")}/members/${userId}`, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${env("DISCORD_JOIN_BOT_TOKEN")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ access_token: accessToken }),
    });
    return res.status;
  } catch {
    return "network-error";
  }
}

/** Reads the player's identity, then the caller discards the token. */
export async function currentUser(
  accessToken: string,
): Promise<{ id: string; username: string; avatar: string | null } | null> {
  try {
    const res = await fetch(`${API}/users/@me`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const u = (await res.json()) as { id: string; username: string; avatar: string | null };
    return { id: u.id, username: u.username, avatar: u.avatar ?? null };
  } catch {
    return null;
  }
}
```

- [ ] **Step 6: Typecheck and commit**

```bash
cd /opt/clan-wars/apps/web && npx tsc --noEmit
cd /opt/clan-wars
git add apps/web/lib/auth/membership.ts apps/web/lib/auth/discord.ts apps/web/test/auth-membership.test.ts
git commit -m "feat(web): guild membership check and its decision table

The policy is split from the fetch so it can be tested as a table: spec §2.7
('a Discord outage does not log anyone out') is one line of policy that is
impossible to test through a network call.

⚠️ 401 and 403 map to unknown, not notMember. Those statuses are about OUR bot
token -- revoked, or its role edited -- and calling them 'not a member' would
sign out every player at once and look exactly like a mass ban.

⚠️ Membership is checked with our bot token, never the player's. That is what
lets the re-check work from a user id alone, so no user access token is
persisted and none can expire or leak."
```

---

### Task 5: The gate — allowlist and middleware

**Files:**
- Create: `apps/web/lib/auth/gate.ts`
- Create: `apps/web/middleware.ts`
- Test: `apps/web/test/auth-gate.test.ts`

**Interfaces:**
- Consumes: `pathIsPublic` from this task; `SESSION_COOKIE`, `sessionCookieAttributes` (Task 1); `safeNextPath` (Task 2); `decodeSession`, `encodeSession`, `sessionKey`, `Session` (Task 3); `guildMemberStatus` (Task 4); `outcomeForStatus`, `nextCheckAfter` (Task 4).
- Produces: `PUBLIC_PATHS: readonly string[]`, `PUBLIC_PREFIXES: readonly string[]`, `AUTH_PAGES: readonly string[]`, `pathIsPublic(pathname: string): boolean`.

- [ ] **Step 1: Write the failing test**

Create `apps/web/test/auth-gate.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { PUBLIC_PATHS, PUBLIC_PREFIXES, AUTH_PAGES, pathIsPublic } from "../lib/auth/gate";

/**
 * ⚠️ A drift test on the gate. These three lists ARE the security boundary:
 * adding an entry makes a page reachable by anyone on the internet, and it is
 * a one-line change that reads as harmless in review. Pinning them exactly
 * means widening the gate fails a test that names what was added — a silently
 * widened gate is not something anyone reports.
 */
describe("the public allowlist is exactly this", () => {
  it("pins the public paths", () => {
    expect([...PUBLIC_PATHS]).toEqual(["/"]);
  });

  it("pins the public prefixes", () => {
    expect([...PUBLIC_PREFIXES]).toEqual(["/api/auth/", "/flags/"]);
  });

  it("pins the auth pages", () => {
    expect([...AUTH_PAGES]).toEqual(["/login", "/join"]);
  });
});

describe("pathIsPublic", () => {
  it("lets the landing page through", () => {
    expect(pathIsPublic("/")).toBe(true);
  });

  it("lets the auth endpoints and static flags through", () => {
    expect(pathIsPublic("/api/auth/discord")).toBe(true);
    expect(pathIsPublic("/api/auth/callback")).toBe(true);
    expect(pathIsPublic("/flags/Flag_Wolf.png")).toBe(true);
  });

  it("gates the prototypes", () => {
    expect(pathIsPublic("/mobile")).toBe(false);
    expect(pathIsPublic("/link")).toBe(false);
  });

  // ⚠️ The auth pages are NOT public — middleware handles them specially,
  // because whether they should render depends on the session they are for.
  it("does not treat the auth pages as public", () => {
    expect(pathIsPublic("/login")).toBe(false);
    expect(pathIsPublic("/join")).toBe(false);
  });

  it("is not fooled by a prefix that only looks like one", () => {
    expect(pathIsPublic("/api/authorise-me")).toBe(false);
    expect(pathIsPublic("/flagsomething")).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
npx vitest run --root apps/web test/auth-gate.test.ts
```

Expected: FAIL — `Cannot find module '../lib/auth/gate'`.

- [ ] **Step 3: Write the allowlist**

Create `apps/web/lib/auth/gate.ts`:

```typescript
/**
 * What is reachable without a session.
 *
 * ⚠️ These lists are the security boundary. `test/auth-gate.test.ts` pins them
 * exactly, so adding an entry is a deliberate act that fails a test naming it.
 */

/** The landing page, and only the landing page. */
export const PUBLIC_PATHS = ["/"] as const;

/**
 * ⚠️ Trailing slashes are load-bearing: "/api/auth/" must not match
 * "/api/authorise-me". Every prefix here ends with one.
 *
 * Static flags stay public on purpose — they are the same 33 images the bot
 * already posts publicly, and gating them would break caching for every page.
 */
export const PUBLIC_PREFIXES = ["/api/auth/", "/flags/"] as const;

/**
 * Handled by middleware rather than by this predicate: whether these should
 * render depends on the session, so they are neither public nor gated.
 */
export const AUTH_PAGES = ["/login", "/join"] as const;

export function pathIsPublic(pathname: string): boolean {
  if ((PUBLIC_PATHS as readonly string[]).includes(pathname)) return true;
  return (PUBLIC_PREFIXES as readonly string[]).some((p) => pathname.startsWith(p));
}
```

- [ ] **Step 4: Run it and watch it pass**

```bash
cd /opt/clan-wars && npx vitest run --root apps/web test/auth-gate.test.ts
```

Expected: PASS, 8 tests.

- [ ] **Step 5: Write the middleware**

Create `apps/web/middleware.ts`:

```typescript
import { NextResponse, type NextRequest } from "next/server";
import { pathIsPublic } from "./lib/auth/gate";
import { SESSION_COOKIE, sessionCookieAttributes } from "./lib/auth/cookies";
import { decodeSession, encodeSession, sessionKey, type Session } from "./lib/auth/session";
import { guildMemberStatus } from "./lib/auth/discord";
import { nextCheckAfter, outcomeForStatus } from "./lib/auth/membership";
import { safeNextPath } from "./lib/auth/next-path";

/**
 * The gate.
 *
 * ⚠️ Gated pages stay STATICALLY rendered. This intercepts the request; it does
 * not make the page dynamic. Nothing about how the pages build changes.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|robots.txt).*)"],
};

function redirectTo(req: NextRequest, pathname: string, next?: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = pathname;
  url.search = next ? `?next=${encodeURIComponent(next)}` : "";
  return NextResponse.redirect(url);
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname, search } = req.nextUrl;
  if (pathIsPublic(pathname)) return NextResponse.next();

  const baseUrl = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const key = sessionKey(process.env.SESSION_SECRET ?? "");
  const here = safeNextPath(pathname + search);
  const wanted = safeNextPath(req.nextUrl.searchParams.get("next"));

  const existing = await decodeSession(req.cookies.get(SESSION_COOKIE)?.value ?? "", key);

  // ⚠️ /login and /join redirect away when they have nothing to ask for.
  // Rendering /join to a member would send a "Join servers for you" consent
  // screen to someone already in the guild.
  if (pathname === "/login") {
    return existing?.guild ? redirectTo(req, wanted) : NextResponse.next();
  }
  if (pathname === "/join") {
    if (!existing) return redirectTo(req, "/login", "/join");
    return existing.guild ? redirectTo(req, wanted) : NextResponse.next();
  }

  if (!existing) return redirectTo(req, "/login", here);

  let session: Session = existing;
  const now = Math.floor(Date.now() / 1000);
  if (now >= session.nextCheckAt) {
    const outcome = outcomeForStatus(await guildMemberStatus(session.sub));
    session = {
      ...session,
      // ⚠️ "unknown" leaves `guild` exactly as it was — last-known-good. This
      // one expression is spec §2.7: a Discord outage must not log anyone out.
      guild: outcome === "unknown" ? session.guild : outcome === "member",
      nextCheckAt: nextCheckAfter(outcome, now),
    };
  }

  if (!session.guild) return redirectTo(req, "/join", here);

  const res = NextResponse.next();
  // Only re-issue when the re-check actually ran, so a normal request sets no
  // cookie and the 7-day expiry is not silently extended on every page view.
  if (session !== existing) {
    res.cookies.set(SESSION_COOKIE, await encodeSession(session, key), sessionCookieAttributes(baseUrl));
  }
  return res;
}
```

- [ ] **Step 6: Typecheck, run the suite, commit**

```bash
cd /opt/clan-wars/apps/web && npx tsc --noEmit
cd /opt/clan-wars && npx vitest run --root apps/web
```

Expected: all suites PASS. `smoke.test.ts` now scans `middleware.ts` too (Task 1) and still reports no database imports.

```bash
git add apps/web/lib/auth/gate.ts apps/web/middleware.ts apps/web/test/auth-gate.test.ts
git commit -m "feat(web): the gate — public allowlist and middleware

⚠️ The allowlist is pinned by a drift test. Those lists are the security
boundary: adding an entry makes a page reachable by anyone, and it is a
one-line change that reads as harmless in review.

⚠️ Trailing slashes in the prefixes are load-bearing -- '/api/auth/' must not
match '/api/authorise-me'.

/login and /join redirect away when they have nothing to ask for: rendering
/join to a member would fire a 'Join servers for you' consent screen at
someone already in the guild.

⚠️ On an unknown membership result the session keeps its previous guild flag.
That single expression is the whole of 'a Discord outage does not log anyone
out'. The cookie is only re-issued when a re-check ran, so a normal page view
does not silently extend the 7-day expiry."
```

---

### Task 6: The OAuth endpoints

**Files:**
- Create: `apps/web/app/api/auth/discord/route.ts`
- Create: `apps/web/app/api/auth/callback/route.ts`
- Create: `apps/web/app/api/auth/logout/route.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–4.
- Produces: the three routes. No exported values other than the Next route handlers.

- [ ] **Step 1: Write the start endpoint**

Create `apps/web/app/api/auth/discord/route.ts`:

```typescript
import { NextResponse, type NextRequest } from "next/server";
import { generateState } from "arctic";
import { discordClient } from "@/lib/auth/discord";
import { STATE_COOKIE, stateCookieAttributes } from "@/lib/auth/cookies";
import { safeNextPath } from "@/lib/auth/next-path";

/**
 * Begins the OAuth round.
 *
 * ⚠️ Two tiers of consent. The default round asks for `identify` only;
 * `guilds.join` renders on Discord's screen as "Join servers for you", which
 * is the most alarming line a player will read and is irrelevant to everyone
 * already in the guild. It is requested only by ?mode=join.
 *
 * ⚠️ No PKCE: this is a confidential client and arctic's Discord provider
 * refuses a code verifier for one. The state cookie is therefore the ENTIRE
 * CSRF defence.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const baseUrl = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const mode = req.nextUrl.searchParams.get("mode") === "join" ? "join" : "login";
  const next = safeNextPath(req.nextUrl.searchParams.get("next"));

  const state = generateState();
  const scopes = mode === "join" ? ["identify", "guilds.join"] : ["identify"];
  const url = discordClient().createAuthorizationURL(state, null, scopes);

  const res = NextResponse.redirect(url);
  // mode and next travel in the signed-off cookie, not the URL, so neither can
  // be swapped between the redirect to Discord and the callback.
  res.cookies.set(
    STATE_COOKIE,
    JSON.stringify({ state, mode, next }),
    stateCookieAttributes(baseUrl),
  );
  return res;
}
```

- [ ] **Step 2: Write the callback**

Create `apps/web/app/api/auth/callback/route.ts`:

```typescript
import { NextResponse, type NextRequest } from "next/server";
import { addGuildMember, currentUser, discordClient, guildMemberStatus } from "@/lib/auth/discord";
import { SESSION_COOKIE, STATE_COOKIE, sessionCookieAttributes } from "@/lib/auth/cookies";
import { encodeSession, sessionKey, type Session } from "@/lib/auth/session";
import { nextCheckAfter, outcomeForStatus } from "@/lib/auth/membership";
import { safeNextPath } from "@/lib/auth/next-path";

type StateCookie = { state: string; mode: "login" | "join"; next: string };

function readState(raw: string | undefined): StateCookie | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as StateCookie;
    if (typeof v.state !== "string" || (v.mode !== "login" && v.mode !== "join")) return null;
    return { state: v.state, mode: v.mode, next: safeNextPath(v.next) };
  } catch {
    return null;
  }
}

function fail(req: NextRequest, reason: string): NextResponse {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = `?error=${encodeURIComponent(reason)}`;
  const res = NextResponse.redirect(url);
  res.cookies.delete(STATE_COOKIE);
  return res;
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const baseUrl = process.env.WEB_BASE_URL ?? req.nextUrl.origin;
  const code = req.nextUrl.searchParams.get("code");
  const returnedState = req.nextUrl.searchParams.get("state");
  const saved = readState(req.cookies.get(STATE_COOKIE)?.value);

  // ⚠️ Refuse outright. With no PKCE this comparison is the only thing
  // standing between us and a login CSRF, so a missing or mismatched state
  // must never fall through to the exchange.
  if (!code || !saved || !returnedState || returnedState !== saved.state) {
    return fail(req, "state");
  }

  let accessToken: string;
  try {
    accessToken = (await discordClient().validateAuthorizationCode(code)).accessToken();
  } catch {
    return fail(req, "discord");
  }

  const user = await currentUser(accessToken);
  if (!user) return fail(req, "discord");

  let outcome = outcomeForStatus(await guildMemberStatus(user.id));

  if (saved.mode === "join" && outcome !== "member") {
    const status = await addGuildMember(user.id, accessToken);
    // 201 added, 204 already a member. 403 means banned — say so plainly
    // rather than offering a retry that cannot succeed.
    if (status === 201 || status === 204) outcome = "member";
    else if (status === 403) return fail(req, "banned");
  }

  // ⚠️ The access token is used for nothing else and is not stored anywhere.
  // Everything after this point works from the user id alone.
  const now = Math.floor(Date.now() / 1000);
  const session: Session = {
    sub: user.id,
    name: user.username,
    avatar: user.avatar,
    guild: outcome === "member",
    nextCheckAt: nextCheckAfter(outcome, now),
  };

  const url = req.nextUrl.clone();
  url.pathname = session.guild ? saved.next : "/join";
  url.search = session.guild ? "" : `?next=${encodeURIComponent(saved.next)}`;

  const res = NextResponse.redirect(url);
  res.cookies.set(
    SESSION_COOKIE,
    await encodeSession(session, sessionKey(process.env.SESSION_SECRET ?? "")),
    sessionCookieAttributes(baseUrl),
  );
  res.cookies.delete(STATE_COOKIE);
  return res;
}
```

- [ ] **Step 3: Write logout**

Create `apps/web/app/api/auth/logout/route.ts`:

```typescript
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth/cookies";

/**
 * ⚠️ POST only, and deliberately no GET export. A GET logout can be triggered
 * by any <img> tag on any page on the internet, which turns logging players
 * out into a drive-by.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const url = req.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  const res = NextResponse.redirect(url, { status: 303 });
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
```

- [ ] **Step 4: Typecheck and commit**

```bash
cd /opt/clan-wars/apps/web && npx tsc --noEmit
cd /opt/clan-wars
git add apps/web/app/api/auth
git commit -m "feat(web): the OAuth endpoints

⚠️ A missing or mismatched state refuses outright. With no PKCE (confidential
client) that comparison is the only thing between us and a login CSRF, so it
must never fall through to the code exchange.

The access token is used to read the user id -- and, on the join round, to add
the member -- and is then discarded. Nothing persists it, so nothing can leak
or expire it.

⚠️ Logout is POST with no GET export: a GET logout can be fired by any image
tag on any page on the internet."
```

---

### Task 7: The sign-in and join screens

⚠️ The stylesheet moves out of the prototype directory first. `/login` is a real product screen and cannot import its CSS from `app/link/`, or deleting the prototype later breaks the login. Moving it is a rename, not a rewrite — no rule changes.

**Files:**
- Rename: `apps/web/app/link/link.module.css` → `apps/web/app/auth.module.css`
- Modify: every `.tsx` in `apps/web/app/link/` (import path only)
- Modify: `apps/web/test/palette-drift.test.ts` (the path it pins)
- Create: `apps/web/app/components/sign-in-card.tsx`
- Create: `apps/web/app/login/page.tsx`
- Create: `apps/web/app/join/page.tsx`
- Modify: `apps/web/app/link/signed-out.tsx` (use the shared card)

**Interfaces:**
- Consumes: nothing from earlier tasks at runtime; links to `/api/auth/discord` (Task 6).
- Produces: `SignInCard(props: { step: string; heading: string; body: string; action: string; actionHref: string; footnote: string; error?: string })`.

- [ ] **Step 1: Move the stylesheet and repoint every import**

```bash
cd /opt/clan-wars
git mv apps/web/app/link/link.module.css apps/web/app/auth.module.css
sed -i 's|from "./link.module.css"|from "../auth.module.css"|' apps/web/app/link/*.tsx
sed -i 's|"app", "link", "link.module.css"|"app", "auth.module.css"|' apps/web/test/palette-drift.test.ts
# ⚠️ The docblock names the path too — a comment that lies about where a file
# lives is how the next person loses ten minutes.
sed -i 's|`app/link/link.module.css`|`app/auth.module.css`|' apps/web/test/palette-drift.test.ts
grep -rn "link\.module\.css" apps/web/ || echo "no stale references"
```

- [ ] **Step 2: Run the suite to prove the move changed nothing**

```bash
npx vitest run --root apps/web
```

Expected: PASS, including `palette-drift.test.ts` against the new path.

- [ ] **Step 3: Write the shared card**

Create `apps/web/app/components/sign-in-card.tsx`:

```tsx
import s from "../auth.module.css";

/**
 * The sign-in card, from the `Clan Wars Gamertag Link.dc.html` design canvas.
 *
 * ⚠️ Shared by the real `/login` and the `/link` prototype's step 1. The
 * prototype supplies its own fixture copy; the two share the component, not
 * the state — so the demo keeps reading end-to-end while the real screen is
 * the one that actually starts an OAuth round.
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
  /** Where the button goes. `#` in the prototype, a real endpoint at /login. */
  actionHref: string;
  footnote: string;
  error?: string;
}) {
  return (
    <div className={s.card}>
      <div className={`${s.stepLabel} ${s.mono}`}>{step}</div>
      <h1 className={`${s.headline} ${s.display}`}>{heading}</h1>
      <p className={`${s.body} ${s.bodyWide}`}>{body}</p>
      {error && (
        <div className={s.refusal} role="alert">
          <div className={`${s.refusalLabel} ${s.mono}`}>Sign-in failed</div>
          <div className={s.refusalBody}>{error}</div>
        </div>
      )}
      <a className={`${s.primary} ${s.display}`} href={actionHref}>
        {action}
      </a>
      <div className={`${s.footnote} ${s.mono}`}>{footnote}</div>
    </div>
  );
}
```

- [ ] **Step 4: Point the prototype at the shared card**

Replace the whole body of `apps/web/app/link/signed-out.tsx`:

```tsx
import { SignInCard } from "../components/sign-in-card";

/**
 * State 01 of the prototype. ⚠️ `actionHref="#"` and the onSignIn handler are
 * what keep this a fixture: the real screen at /login uses the same card with
 * a real endpoint behind it.
 */
export function SignedOut({ onSignIn }: { onSignIn: () => void }) {
  return (
    <div onClick={onSignIn}>
      <SignInCard
        step="Step 1 of 3 — sign in"
        heading="Link your character"
        body="Sign in with the Discord account you use on the server. Your faction, roster and map all hang off this one link."
        action="Continue with Discord"
        actionHref="#"
        footnote="One character per account. Signing in shows nothing you could not already see — the map and roster need the link."
      />
    </div>
  );
}
```

- [ ] **Step 5: Write the login page**

Create `apps/web/app/login/page.tsx`:

```tsx
import type { Metadata } from "next";
import { SignInCard } from "../components/sign-in-card";
import { archivo, archivoBlack, spaceMono } from "../fonts";
import { safeNextPath } from "@/lib/auth/next-path";
import s from "../auth.module.css";

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
  const rawNext = typeof params.next === "string" ? params.next : null;
  const next = safeNextPath(rawNext);
  const rawError = typeof params.error === "string" ? params.error : "";

  return (
    <div className={`${s.page} ${archivo.variable} ${archivoBlack.variable} ${spaceMono.variable}`}>
      <SignInCard
        step="Sign in"
        heading="Link your character"
        body="Sign in with the Discord account you use on the server. Your faction, roster and map all hang off this one link."
        action="Continue with Discord"
        actionHref={`/api/auth/discord?next=${encodeURIComponent(next)}`}
        footnote="One character per account. You need to be in the Clan Wars Discord — we will offer to add you if you are not."
        error={ERRORS[rawError]}
      />
    </div>
  );
}
```

- [ ] **Step 6: Write the join page**

Create `apps/web/app/join/page.tsx`:

```tsx
import type { Metadata } from "next";
import { SignInCard } from "../components/sign-in-card";
import { archivo, archivoBlack, spaceMono } from "../fonts";
import { safeNextPath } from "@/lib/auth/next-path";
import s from "../auth.module.css";

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
    <div className={`${s.page} ${archivo.variable} ${archivoBlack.variable} ${spaceMono.variable}`}>
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

- [ ] **Step 7: Typecheck, test, build**

```bash
cd /opt/clan-wars/apps/web && npx tsc --noEmit
cd /opt/clan-wars && npx vitest run --root apps/web
pnpm --filter @factions/web build
```

Expected: typecheck clean, all suites pass, build succeeds and lists `/login` and `/join` as routes.

- [ ] **Step 8: Commit**

```bash
cd /opt/clan-wars
git add apps/web/app apps/web/test/palette-drift.test.ts
git commit -m "feat(web): the sign-in and join screens

⚠️ The stylesheet moves out of app/link/ first. /login is a real product
screen and must not import its CSS from a prototype directory -- deleting the
prototype later would break the login. The move is a rename; no rule changes,
and palette-drift.test.ts follows it.

The card is shared by /login and the prototype's step 1: the two share the
component, not the state, so the fixture demo still reads end to end.

⚠️ The ?error= value is mapped through a lookup table, never echoed. It is
attacker-supplied and lands in a page we just asked someone to trust."
```

---

### Task 8: Wire the secrets into the container and deploy

**Files:**
- Modify: `docker-compose.yml` (the `web` service's `environment`)
- Modify: `apps/web/test/deployment-config.test.ts`
- Create: `docs/deploy/2026-09-04-discord-login.md`
- Modify: `CLAUDE.md` (the web app bullet)

**Interfaces:**
- Consumes: everything.
- Produces: a deployed, gated site.

- [ ] **Step 1: Write the failing deployment-config test**

Add to `apps/web/test/deployment-config.test.ts`:

```typescript
  it("passes every auth secret to the web container", () => {
    // ⚠️ A missing var does not fail the build — it fails at the first login,
    // in production, as a 500 from `env()`. This is the only cheap place to
    // catch a compose file that forgot one.
    for (const key of [
      "WEB_BASE_URL",
      "SESSION_SECRET",
      "DISCORD_CLIENT_ID",
      "DISCORD_CLIENT_SECRET",
      "DISCORD_JOIN_BOT_TOKEN",
      "DISCORD_GUILD_ID",
    ]) {
      expect(COMPOSE).toContain(`${key}: \${${key}}`);
    }
  });

  it("marks no auth secret NEXT_PUBLIC_", () => {
    // ⚠️ NEXT_PUBLIC_ inlines a value into the client bundle. For
    // DISCORD_CLIENT_SECRET that means publishing it.
    expect(COMPOSE).not.toMatch(/NEXT_PUBLIC_[A-Z_]*(SECRET|TOKEN)/);
  });
```

⚠️ The file already reads the compose text into a const named `COMPOSE` (capitalised). Use that name — do not introduce a second reader.

- [ ] **Step 2: Run it and watch it fail**

```bash
cd /opt/clan-wars && npx vitest run --root apps/web test/deployment-config.test.ts
```

Expected: FAIL — the compose file has only `NODE_ENV`.

- [ ] **Step 3: Add the variables to the web service**

In `docker-compose.yml`, replace the `web` service's `environment:` block:

```yaml
    environment:
      NODE_ENV: production
      # ⚠️ Discord login. All six are read at RUNTIME by server code only.
      # None may ever be prefixed NEXT_PUBLIC_ — that inlines the value into
      # the client bundle, which for the client secret means publishing it.
      WEB_BASE_URL: ${WEB_BASE_URL}
      SESSION_SECRET: ${SESSION_SECRET}
      DISCORD_CLIENT_ID: ${DISCORD_CLIENT_ID}
      DISCORD_CLIENT_SECRET: ${DISCORD_CLIENT_SECRET}
      DISCORD_JOIN_BOT_TOKEN: ${DISCORD_JOIN_BOT_TOKEN}
      DISCORD_GUILD_ID: ${DISCORD_GUILD_ID}
```

- [ ] **Step 4: Run the full gate**

```bash
cd /opt/clan-wars
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force 2>&1 | tail -6
```

Expected: **22/22 tasks, 0 cached.** Check the count, not the exit code.

- [ ] **Step 5: Verify the deploy prerequisites BEFORE deploying**

```bash
cd /opt/clan-wars && set -a && . ./.env && set +a
curl -s -H "Authorization: Bot $DISCORD_JOIN_BOT_TOKEN" \
  https://discord.com/api/v10/users/@me/guilds |
python3 -c "
import json,sys,os
gs=json.load(sys.stdin)
g=[x for x in gs if x['id']==os.environ['DISCORD_GUILD_ID']][0]
p=int(g['permissions'])
print('guild:', g['name'])
print('CREATE_INSTANT_INVITE:', bool(p & 0x1))
print('ADMINISTRATOR:', bool(p & 0x8))
"
```

⚠️ **Stop if `ADMINISTRATOR` is True.** The whole reason the web app has its own Discord application is so a compromised web container can add guild members and nothing else. With Administrator, that token can kick, ban and post — strictly worse than sharing the game bot's token, because it is a second unrestricted key. Fix the role in Discord (Server Settings → Roles → Clan Wars Web → Administrator off, Create Invite on) and re-run this before continuing.

- [ ] **Step 6: Build and deploy**

```bash
cd /opt/clan-wars
sudo docker compose build web
sudo docker compose up -d web     # ⚠️ named service only, never a bare `up -d`
```

- [ ] **Step 7: Verify against production**

```bash
# The landing page is still public and still 200.
curl -s -o /dev/null -w 'landing  %{http_code}\n' https://dayzclanwars.com/

# Gated pages now redirect to /login instead of serving.
for p in /mobile /link; do
  printf '%-8s %s -> %s\n' "$p" \
    "$(curl -s -o /dev/null -w '%{http_code}' https://dayzclanwars.com$p)" \
    "$(curl -s -o /dev/null -w '%{redirect_url}' https://dayzclanwars.com$p)"
done

# The neighbours on this nginx are untouched.
for h in dayzonelife.com manicdotes.com regime.fi; do
  printf '%-18s %s\n' "$h" "$(curl -s -o /dev/null -w '%{http_code}' https://$h/)"
done
```

Expected: `/` is 200; `/mobile` and `/link` are 307/308 to `/login?next=…`; all three neighbours 200.

- [ ] **Step 8: Walk a real login in a browser**

⚠️ This is the only step that can verify the redirect URI, which no shell check can (Discord validates it at the consent screen). Open `https://dayzclanwars.com/mobile`, expect a bounce to `/login`, press Continue with Discord, and confirm: the consent screen appears (not "Invalid OAuth2 redirect_uri"), it asks for **identify only** — no "Join servers for you" — and you land back on `/mobile`.

- [ ] **Step 9: Write the runbook and update CLAUDE.md**

Create `docs/deploy/2026-09-04-discord-login.md` recording what was actually observed: the gate count, the permission check output, the HTTP codes before and after, and whether the browser walk found anything. Record what is NOT covered — a banned user's 403 path, for instance, is untested unless someone banned is available to try it.

In `CLAUDE.md`, update the web app bullet to say the site is gated, that `/` is the only public page, that sessions are 7-day cookies with a 15-minute membership re-check, and — the operationally important one — that **rotating `SESSION_SECRET` logs every player out at once and is the only revocation lever that exists.**

- [ ] **Step 10: Commit**

```bash
cd /opt/clan-wars
git add docker-compose.yml apps/web/test/deployment-config.test.ts docs/deploy CLAUDE.md
git commit -m "feat(deploy): gate the site behind Discord login

⚠️ A missing env var does not fail the build; it fails at the first login, in
production, as a 500. deployment-config.test.ts now asserts all six are passed
to the web container and that none is NEXT_PUBLIC_ -- that prefix would inline
the client secret into the browser bundle.

Records that rotating SESSION_SECRET logs every player out simultaneously and
is the only revocation lever a cookie session has."
```

---

## Self-Review

**Spec coverage.** §2.1 guild gate → Tasks 4, 5. §2.2 join button → Tasks 6, 7. §2.3 two-tier consent → Task 6 Step 1. §2.4 no stored access token → Task 6 Step 2. §2.5 cookie session → Task 3. §2.6 seven days / fifteen minutes → Tasks 1, 4. §2.7 outage behaviour → Task 4 table + Task 5 middleware. §2.8 `/` public → Task 5 allowlist. §2.9 own application and its permission → Task 8 Step 5. §4.1 routes → Tasks 6, 7. §4.2 cookie → Tasks 1, 3. §4.3 state, no PKCE → Task 6. §4.4 middleware → Task 5. §5 failure table → Tasks 4, 6. §6 testing → every task; the `smoke.test.ts` extension is Task 1, first, as the spec requires. §7 deployment → Task 8.

**Not covered, deliberately:** the spec's §8 carried-forward items are future work by definition.

**Placeholders:** none — every step has runnable commands or complete code.

**Type consistency:** `Session` (Task 3) is consumed unchanged by Tasks 5 and 6. `MembershipOutcome` values `"member" | "notMember" | "unknown"` are used identically in Tasks 4, 5 and 6. `safeNextPath` (Task 2) is used in Tasks 5, 6 and 7. `sessionCookieAttributes(baseUrl)` takes the base URL in Task 1 and is called that way in Tasks 5 and 6. `guildMemberStatus`/`addGuildMember`/`currentUser`/`discordClient` (Task 4) match their uses in Tasks 5 and 6.

**One known gap:** middleware itself has no automated test — `apps/web` has no jsdom and no Next test harness, so the wiring is verified by Task 8's browser walk rather than by a unit test. Every decision it makes is tested in isolation (`pathIsPublic`, `outcomeForStatus`, `nextCheckAfter`, `decodeSession`, `safeNextPath`); what is untested is only that they are wired together correctly.
