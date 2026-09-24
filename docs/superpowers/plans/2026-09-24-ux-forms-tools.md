# Forms & Signed-in Tools UX Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix every finding in the 2026-09-24 forms & signed-in tools UX review. Players should not be able to double-submit, lose what they typed, get stranded by focus, race a debounce, or read the same notification twice.

**Architecture:**
- Every plain form POST on the signed-in pages goes through one of two client islands, `SubmitButton` (new) or `ConfirmButton`. Both use one pure submit guard, `lib/submit-guard.ts`, which lets the first `submit` event through and cancels the rest.
- A refused form's non-secret values travel back on the 303 as `kept.<name>` query parameters, built and read in exactly one place (`lib/form.ts`). A deny-list there makes `code` impossible to echo.
- The roster changes are read-side only:
  - a dedupe inside `notificationsForDb`'s `VISIBLE` union
  - a SQL kind filter
  - a guest's gamertag on `OpenGuestPass`

  No write path, lock or export changes.

**Tech Stack:** Next.js (App Router) + React 19 + Tailwind v4 in `apps/web`; drizzle-orm over postgres.js in `packages/roster`; vitest (node environment, no DOM — client logic is extracted into pure modules and markup is tested with `renderToStaticMarkup`).

**Spec:** UX review of 2026-09-24 — the findings list is reproduced in this plan's appendix; each task cites its finding ids.

**Before Task 1:** branch with `keel:start-work` (e.g. `fix/ux-forms-tools`). `main` is protected.

## Global Constraints

- Colours, faces and spacing come only from the tokens in `apps/web/app/globals.css` (`--color-*`, `--font-*`, `--spacing-bar`). No hex literals in components.
- `--color-rust` / `rust-2` mean an outstanding obligation (a pending or expired challenge) and nothing else. A refusal or failure is `border-rule-3` + `text-ink`, never rust.
- Nothing a player reads is smaller than 11px (`text-[11px]`).
- Every control is at least 44px tall (`min-h-[44px]`, or a `btn*` constant from `ui.tsx`).
- A vault code never goes into a URL, a query string, a DM or a feed. Preserving rejected input excludes `code`, and this is enforced in `lib/form.ts` (`NEVER_KEEP`) as well as at every call site.
- `apps/web` may call only what `packages/roster` exports. `packages/roster/test/exports.test.ts` (via `test/roster-exports.ts`) and `apps/web/test/smoke.test.ts` pin that allowlist. This plan adds **no** export. It adds one optional parameter to `notificationsFor` and one field to `OpenGuestPass`. Any executor who does add an export updates both tests.
- No web source contains the substring "faction" (`apps/web/test/copy-vocabulary.test.ts`). Use `clanId`, `clan`, and so on.
- Lock order (CLAUDE.md) applies to any roster write. This plan changes no write: D1, M5 and M8 are reads.
- Comments explain WHY, with `⚠️` where a wrong edit fails silently. Match the density of the file being edited.
- ⚠️ `app/(site)/kit/*.tsx` must contain **no em dash**, in copy or comments (`test/kit.test.ts`).
- Out of scope, owned by sibling plans:
  - the map (`app/(site)/map/**`)
  - `SegNav`
  - the site bar and menu
  - the notifications-bell panel
  - `server-strip`, `timer-bar`, `install-strip`
  - public pages, the guide, flags, awards

  This plan only **adds** one export to `ui.tsx` (`SubmitButton`).
- Gate: `TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx turbo run typecheck test --concurrency=1 --force` from the repo root. Expect **30/30 tasks**. Never run two test runs at once: they share `factions_test_<package>`.

## Review Focus

These five failure modes are the likeliest to hurt a player, and nothing but the named tests would catch them:

1. **A triple-tap on an armed `ConfirmButton`.** Tap 1 arms it and tap 2 posts. Tap 3 must post nothing, including when React state has not caught up and tap 3 still sees `armed`. Pinned in Task 3: "a triple-tap posts once" and "even with stale state".
2. **A rejected value containing `&`, `=`, `+`, unicode, or over the length cap, echoed back.** It must round-trip exactly, must not split the query string, and must be dropped rather than truncated when too long. Pinned in Task 5 (`resultQuery` tests) and Task 6 (the value reaches the field HTML-escaped).
3. **The vault code leaking into a redirect.** An Add form refused for a bad name must not put the typed code in `Location`. A crafted `?kept.code=1234` must not render. Pinned in Task 5 ("never carries a vault code", "refuses `code` even from a crafted URL") and Task 8 (the Add route never lists `code`, and the field carries no value).
4. **JavaScript disabled, or a Back into the bfcache.** `SubmitButton` must server-render as a plain, enabled `<button type="submit">`. A page restored from the back/forward cache must not leave the button dead. Pinned in Task 2.
5. **The founder who double-taps "Found the clan".** The first POST founds the clan. The second gets `no-such-ceremony` and used to land on a 404. It must land on `/clan`. Pinned in Task 4 (`claimLanding`).

---

### Task 1: D1 — one unlock listed twice in notifications (investigation + dedupe)

**Conclusion of the investigation (code reading):**
- `apps/bot/src/achievements/tick.ts` `queueUnlockNoticesTx` handles a **player** owner in a clan. In one transaction, with one `base` object, it writes two rows:
  - `noticeClanTx(tx, { ...base, factionId })`: a `channel` row for the clan
  - `noticeUserTx(tx, { ...base, factionId, discordId: names.memberDiscordId })`: a `dm` row to the player

  The two rows share `kind = 'achievement'`, `occurred_at = earnedAt`, `faction_id` and `payload`.
- For a **clan** owner the function writes one `channel` row, plus a `dm` row to **every full member** (`noticeFullMembersTx`).
- `packages/roster/src/notifications.ts` `VISIBLE` is a `union all` of the viewer's DMs and their clans' channel rows. The unlocking player, a full member of their clan, therefore sees both copies. For a team unlock, every member sees both.
- This matches the live report exactly: "Unlocked: Veteran — RonaldRaygun552 unlocked it" twice, both 3 d old.
- It is **a duplicate, not two events**. Other writers produce the same shape too. `flag_down`, for example, sends a channel notice plus a full-members DM with one payload.
- The fix belongs in the read, not the bot. Discord legitimately gets both: a DM and a channel post are two places. Only the site's union merges them into one inbox.
- The public-wall row (`factionId: null`, `payload.public = true`) never matches the channel branch's join, so it is already invisible here.

**Decision:** In `VISIBLE`, a channel row is hidden when the same viewer holds a DM with the same `kind`, `occurred_at`, `faction_id` and `payload`, compared as jsonb equality, which ignores key order. The DM is the copy kept: it is the one addressed to the viewer. `unreadNoticeCountDb`, `markAllNoticesReadDb` and `markNoticeReadDb` all read `VISIBLE`, so the count, the watermark and the list stay in agreement.

**Files:**
- Modify: `packages/roster/src/notifications.ts:30-57` (the `VISIBLE` doc comment and query)
- Test: `packages/roster/test/notifications.test.ts` (append inside the outer `describe("notificationsForDb", …)`, directly after the `it("is empty, not an error, for a player with nothing", …)` test and before the nested `describe("marking read", …)`)

**Interfaces:**
- Consumes: `clan_notices` (existing columns), `faction_members`.
- Produces: no signature change. `notificationsForDb`, `unreadNoticeCountDb`, `markAllNoticesReadDb` and `markNoticeReadDb` keep their types. Their visible set loses exact channel duplicates of the viewer's own DMs.

- [ ] **Step 1: Write the failing test**

```ts
  /**
   * ⚠️ D1 (UX review 2026-09-24). The achievements tick queues ONE unlock as a
   * clan-channel row AND a DM to the unlocker (a team unlock: to every full
   * member), with one payload. Discord is right to post both; the site's inbox
   * is a union of the two, so it listed the unlock twice.
   */
  it("⚠️ lists a transition once when it was both DM'd to you and posted to your clan", async () => {
    const f = await faction("NTE");
    await member(f, AT("2026-09-01T00:00:00Z"));
    const at = AT("2026-09-21T10:00:00Z").toISOString();
    const payload = JSON.stringify({ key: "veteran", name: "Veteran", description: "Play for 100 hours.", ownerKind: "player", ownerId: `dz-${YOU}`, ownerName: YOU, gamertag: "RonaldRaygun552", clanTag: "NTE" });
    await db.execute(sql`insert into clan_notices (server_id, faction_id, target, discord_target_id, kind, occurred_at, payload)
                         values (941, ${f}, 'channel', null, 'achievement', ${at}, ${payload}::jsonb)`);
    await db.execute(sql`insert into clan_notices (server_id, faction_id, target, discord_target_id, kind, occurred_at, payload)
                         values (941, ${f}, 'dm', ${YOU}, 'achievement', ${at}, ${payload}::jsonb)`);

    const p = await notificationsForDb(db, YOU, 1);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0]!.target).toBe("dm");
    expect(await unreadNoticeCountDb(db, YOU)).toBe(1);
  });

  it("still shows the clan's copy of a clanmate's unlock — the DM went to them, not you", async () => {
    const f = await faction("NTF");
    await member(f, AT("2026-09-01T00:00:00Z"));
    const at = AT("2026-09-21T10:00:00Z").toISOString();
    const payload = JSON.stringify({ key: "veteran", name: "Veteran", ownerKind: "player", ownerId: "dz-u-mate", gamertag: "Mate" });
    await db.execute(sql`insert into clan_notices (server_id, faction_id, target, discord_target_id, kind, occurred_at, payload)
                         values (941, ${f}, 'channel', null, 'achievement', ${at}, ${payload}::jsonb)`);
    await db.execute(sql`insert into clan_notices (server_id, faction_id, target, discord_target_id, kind, occurred_at, payload)
                         values (941, ${f}, 'dm', 'u-mate', 'achievement', ${at}, ${payload}::jsonb)`);

    const p = await notificationsForDb(db, YOU, 1);
    expect(p.rows.map((r) => r.target)).toEqual(["channel"]);
  });

  it("keeps two notices of one kind and instant that say different things", async () => {
    const f = await faction("NTG");
    await member(f, AT("2026-09-01T00:00:00Z"));
    const at = AT("2026-09-21T10:00:00Z").toISOString();
    await db.execute(sql`insert into clan_notices (server_id, faction_id, target, discord_target_id, kind, occurred_at, payload)
                         values (941, ${f}, 'channel', null, 'achievement', ${at}, '{"key":"veteran"}'::jsonb)`);
    await db.execute(sql`insert into clan_notices (server_id, faction_id, target, discord_target_id, kind, occurred_at, payload)
                         values (941, ${f}, 'dm', ${YOU}, 'achievement', ${at}, '{"key":"first-blood"}'::jsonb)`);

    expect((await notificationsForDb(db, YOU, 1)).rows).toHaveLength(2);
  });
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/notifications.test.ts`
Expected: the first new test FAILS with `expected [ { …(7) }, { …(7) } ] to have a length of 1 but got 2`. The other two new tests pass.

- [ ] **Step 3: Implement**

In `packages/roster/src/notifications.ts`, replace the `VISIBLE` doc comment's last paragraph and the query (lines 40–57) with:

```ts
 * ⚠️ Membership is read live, so leaving a clan removes its rows from this
 * page. The notices themselves are untouched; rejoining restores visibility
 * from the new joined_at forward. Stated here because it will be reported as
 * data loss otherwise.
 *
 * ⚠️ One transition is often written TWICE: a clan-channel row and a DM to
 * the member it is about, with one kind, one instant and one payload (an
 * achievement unlock — apps/bot/src/achievements/tick.ts queueUnlockNoticesTx
 * — or a flag_down to every full member). Discord is right to post both; this
 * inbox is the union of the two places, so the channel copy is dropped when
 * the SAME viewer holds the DM. The DM is kept because it is the one addressed
 * to them. Every function below reads VISIBLE, so the list, the bell's count
 * and the mark-all watermark agree on what exists (D1, UX review 2026-09-24).
 */
const VISIBLE = (discordId: string) => sql`
  select n.id, n.kind, n.target, n.occurred_at, n.payload, n.faction_id
    from clan_notices n
   where n.target = 'dm' and n.discord_target_id = ${discordId}
  union all
  select n.id, n.kind, n.target, n.occurred_at, n.payload, n.faction_id
    from clan_notices n
    join faction_members m
      on m.faction_id = n.faction_id
     and m.discord_id = ${discordId}
     and m.status = 'full'
   where n.target = 'channel' and n.occurred_at >= m.joined_at
     and not exists (
       select 1 from clan_notices d
        where d.target = 'dm' and d.discord_target_id = ${discordId}
          and d.kind = n.kind
          and d.occurred_at = n.occurred_at
          and d.faction_id is not distinct from n.faction_id
          and d.payload = n.payload
     )
`;
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/notifications.test.ts` — all pass.
Run: `cd packages/roster && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add packages/roster/src/notifications.ts packages/roster/test/notifications.test.ts
git commit -m "$(cat <<'EOF'
fix(roster): list a notice once when it was both DM'd to you and posted to your clan

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: H1 — `SubmitButton` and the submit guard

**Files:**
- Create: `apps/web/lib/submit-guard.ts`
- Create: `apps/web/app/components/submit-button.tsx`
- Modify: `apps/web/app/components/ui.tsx:160-161` (add one re-export after the `ConfirmButton` export — the only `ui.tsx` change in this plan)
- Test: `apps/web/test/submit-button.test.tsx`

**Interfaces:**
- Produces:
  - `type SubmitTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">`
  - `guardFormSubmit(form: SubmitTarget, win: SubmitTarget, onChange: (pending: boolean) => void): () => void`
  - `SubmitButton(props: { className: string; children: React.ReactNode; pending?: React.ReactNode; disabled?: boolean })`, re-exported from `@/app/components/ui`

- [ ] **Step 1: Write the failing test** — `apps/web/test/submit-button.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { guardFormSubmit } from "../lib/submit-guard";
import { SubmitButton } from "../app/components/ui";

/** Dispatches a cancelable submit; true means the form would post. */
const submit = (form: EventTarget) => form.dispatchEvent(new Event("submit", { cancelable: true }));
const pageshow = (win: EventTarget, persisted: boolean) => win.dispatchEvent(Object.assign(new Event("pageshow"), { persisted }));

describe("guardFormSubmit", () => {
  it("lets the first submit through and cancels every one after it", () => {
    const form = new EventTarget(); const win = new EventTarget(); const seen: boolean[] = [];
    guardFormSubmit(form, win, (p) => seen.push(p));
    expect(submit(form)).toBe(true);
    expect(submit(form)).toBe(false);
    expect(submit(form)).toBe(false);
    expect(seen).toEqual([true]);
  });

  /**
   * ⚠️ Review focus 4. Back from the next page restores this one from the
   * bfcache with its JS state intact: without the reset the button is dead.
   */
  it("⚠️ re-opens when the page comes back from the back/forward cache", () => {
    const form = new EventTarget(); const win = new EventTarget(); const seen: boolean[] = [];
    guardFormSubmit(form, win, (p) => seen.push(p));
    submit(form);
    pageshow(win, true);
    expect(seen).toEqual([true, false]);
    expect(submit(form)).toBe(true);
  });

  it("ignores a pageshow that is a fresh load", () => {
    const form = new EventTarget(); const win = new EventTarget();
    guardFormSubmit(form, win, () => {});
    submit(form);
    pageshow(win, false);
    expect(submit(form)).toBe(false);
  });

  it("leaves alone a submit another handler already cancelled", () => {
    const form = new EventTarget(); const win = new EventTarget(); const seen: boolean[] = [];
    form.addEventListener("submit", (e) => e.preventDefault());
    guardFormSubmit(form, win, (p) => seen.push(p));
    submit(form);
    expect(seen).toEqual([]);
  });

  it("stops guarding once disposed", () => {
    const form = new EventTarget(); const win = new EventTarget();
    const dispose = guardFormSubmit(form, win, () => {});
    submit(form);
    dispose();
    expect(submit(form)).toBe(true);
  });
});

describe("SubmitButton", () => {
  /** ⚠️ Review focus 4: with JavaScript off this is the whole button, so it must post. */
  it("⚠️ server-renders as a plain, enabled submit button", () => {
    const html = renderToStaticMarkup(<form action="/api/x" method="post"><SubmitButton className="btn">Found the clan</SubmitButton></form>);
    expect(html).toContain('<button type="submit" class="btn');
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("aria-busy");
    expect(html).toContain("Found the clan");
  });

  it("passes a real disabled through", () => {
    const html = renderToStaticMarkup(<SubmitButton className="btn" disabled>Declare</SubmitButton>);
    expect(html).toContain('disabled=""');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/submit-button.test.tsx`
Expected: FAIL — `Failed to resolve import "../lib/submit-guard"`.

- [ ] **Step 3: Implement**

`apps/web/lib/submit-guard.ts`:

```ts
/** The two things the guard listens to: the form, and the window for pageshow. */
export type SubmitTarget = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/**
 * Let a form post once (H1, UX review 2026-09-24).
 *
 * Every signed-in page posts plain HTML forms, so a second tap while the first
 * POST is in flight is a second POST — and some are not idempotent in effect:
 * the second "Found the clan" found no ceremony left and 404'd a founder whose
 * clan had just been created.
 *
 * ⚠️ Listens for `submit`, not `click`. `submit` fires only after the browser's
 * own validation passes (a required box left unticked fires nothing), and it
 * also catches Enter in a field, which a click handler never sees.
 *
 * ⚠️ `pageshow` with `persisted` resets it. Back from the next page restores
 * this one from the bfcache with its script state intact; without the reset
 * the button would stay dead until a reload.
 */
export function guardFormSubmit(form: SubmitTarget, win: SubmitTarget, onChange: (pending: boolean) => void): () => void {
  let sent = false;
  const onSubmit = (e: Event) => {
    if (e.defaultPrevented) return;
    if (sent) { e.preventDefault(); return; }
    sent = true;
    onChange(true);
  };
  const onShow = (e: Event) => {
    if ((e as Event & { persisted?: boolean }).persisted !== true) return;
    sent = false;
    onChange(false);
  };
  form.addEventListener("submit", onSubmit);
  win.addEventListener("pageshow", onShow);
  return () => {
    form.removeEventListener("submit", onSubmit);
    win.removeEventListener("pageshow", onShow);
  };
}
```

`apps/web/app/components/submit-button.tsx`:

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { guardFormSubmit } from "@/lib/submit-guard";

/**
 * The submit button for every plain form POST on the signed-in pages: it
 * sends its form once, then says it is busy until the next page arrives.
 *
 * ⚠️ `aria-disabled`, never `disabled`, once pending. A disabled submitter is
 * left out of the form's data if it disables before the entry list is built,
 * and a disabled button drops keyboard focus to <body>. The guard is what
 * stops the second POST; the attribute only says so.
 *
 * ⚠️ Server-rendered as a bare `<button type="submit">`. With JavaScript off
 * that is all there is, and the form still posts.
 */
export function SubmitButton({ className, children, pending: pendingLabel, disabled = false }: {
  className: string; children: React.ReactNode; pending?: React.ReactNode; disabled?: boolean;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const [pending, setPending] = useState(false);
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return undefined;
    return guardFormSubmit(form, window, setPending);
  }, []);
  return (
    <button ref={ref} type="submit" className={`${className} aria-disabled:opacity-40`} disabled={disabled}
      aria-disabled={pending || undefined} aria-busy={pending || undefined}>
      {pending && pendingLabel !== undefined ? pendingLabel : children}
    </button>
  );
}
```

In `apps/web/app/components/ui.tsx`, after line 161 (`export { ConfirmButton } from "./confirm-button";`) add:

```ts
/** The submit button for a plain form POST: sends its form once (H1, UX review 2026-09-24). */
export { SubmitButton } from "./submit-button";
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/submit-button.test.tsx` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/submit-guard.ts apps/web/app/components/submit-button.tsx apps/web/app/components/ui.tsx apps/web/test/submit-button.test.tsx
git commit -m "$(cat <<'EOF'
feat(web): SubmitButton, a submit that sends its form once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: H1 + M4 — `ConfirmButton` posts once, looks armed, and says so

**Files:**
- Create: `apps/web/lib/confirm-press.ts`
- Modify: `apps/web/app/components/confirm-button.tsx` (whole file)
- Modify (armed labels only):
  - `apps/web/app/(site)/clan/page.tsx` lines 97, 98, 100, 121, 167, 183, 209
  - `apps/web/app/(site)/clan/settings/page.tsx:74`
  - `apps/web/app/(site)/clan/vault/page.tsx` lines 116, 121, 151
  - `apps/web/app/(site)/notifications/actions.tsx:31`
  - `apps/web/app/(site)/base/page.tsx:119`
- Test: `apps/web/test/confirm-button.test.tsx`

**Interfaces:**
- Consumes: `guardFormSubmit` (Task 2).
- Produces:
  - `type ConfirmPhase = "idle" | "armed" | "pending"`
  - `confirmPress(phase: ConfirmPhase): { next: ConfirmPhase; submit: boolean }`
  - `confirmBlur(phase: ConfirmPhase): ConfirmPhase`
  - `confirmExpire(phase: ConfirmPhase): ConfirmPhase`
  - `ARM_MS`
  - `ARMED_CLASS`
  - `ConfirmButton(props: { confirm: string; className: string; children: React.ReactNode; disabled?: boolean; pending?: React.ReactNode })`

- [ ] **Step 1: Write the failing test** — `apps/web/test/confirm-button.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { confirmBlur, confirmExpire, confirmPress, type ConfirmPhase } from "../lib/confirm-press";
import { guardFormSubmit } from "../lib/submit-guard";
import { ARMED_CLASS, ConfirmButton } from "../app/components/confirm-button";

const submitEvent = () => new Event("submit", { cancelable: true });

describe("confirmPress", () => {
  it("arms on the first press and sends nothing", () => expect(confirmPress("idle")).toEqual({ next: "armed", submit: false }));
  it("lets the second press submit", () => expect(confirmPress("armed")).toEqual({ next: "armed", submit: true }));
  it("sends nothing on a press while the post is in flight", () => expect(confirmPress("pending")).toEqual({ next: "pending", submit: false }));

  /** ⚠️ Review focus 1. */
  it("⚠️ a triple-tap posts once", () => {
    const form = new EventTarget();
    let phase: ConfirmPhase = "idle";
    let posts = 0;
    guardFormSubmit(form, new EventTarget(), (p) => { if (p) phase = "pending"; });
    for (let tap = 0; tap < 3; tap++) {
      const r = confirmPress(phase);
      phase = r.next;
      if (r.submit && form.dispatchEvent(submitEvent())) posts += 1;
    }
    expect(posts).toBe(1);
  });

  /** ⚠️ Review focus 1: React has not re-rendered yet, so tap three still reads "armed". */
  it("⚠️ a triple-tap posts once even with stale state — the form guard refuses the second POST", () => {
    const form = new EventTarget();
    let posts = 0;
    guardFormSubmit(form, new EventTarget(), () => {});
    for (const phase of ["idle", "armed", "armed"] as ConfirmPhase[]) {
      if (confirmPress(phase).submit && form.dispatchEvent(submitEvent())) posts += 1;
    }
    expect(posts).toBe(1);
  });

  it("disarms on blur and on expiry, but never un-sends", () => {
    expect(confirmBlur("armed")).toBe("idle");
    expect(confirmBlur("pending")).toBe("pending");
    expect(confirmExpire("armed")).toBe("idle");
    expect(confirmExpire("pending")).toBe("pending");
    expect(confirmExpire("idle")).toBe("idle");
  });
});

describe("ConfirmButton", () => {
  it("server-renders unarmed: the plain label, no hint, a real submit", () => {
    const html = renderToStaticMarkup(<form><ConfirmButton confirm="Press again to remove" className="btn">Remove</ConfirmButton></form>);
    expect(html).toContain('type="submit"');
    expect(html).toContain(">Remove</button>");
    expect(html).not.toContain("aria-describedby");
    expect(html).not.toContain("sr-only");
  });

  /** M4: armed must LOOK different, and not in rust — rust is an obligation, not "careful". */
  it("has an armed look in gold, never rust", () => {
    expect(ARMED_CLASS).toContain("border-gold");
    expect(ARMED_CLASS).not.toContain("rust");
  });
});

describe("armed labels say what the second press does (M4)", () => {
  const dirs = ["clan", "base", "notifications"].map((d) => join(import.meta.dirname, "..", "app", "(site)", d));
  const sources = dirs.flatMap((d) => readdirSync(d, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx")).map((f) => readFileSync(join(d, f), "utf8")));
  const labels = sources.flatMap((s) => [...s.matchAll(/confirm="([^"]*)"/gu)].map((m) => m[1]!));
  it("finds them", () => expect(labels.length).toBeGreaterThan(8));
  it.each(labels)("%s starts with 'Press again to'", (label) => expect(label.startsWith("Press again to ")).toBe(true));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/confirm-button.test.tsx`
Expected: FAIL — `Failed to resolve import "../lib/confirm-press"`.

- [ ] **Step 3: Implement**

`apps/web/lib/confirm-press.ts`:

```ts
/** Where a two-press button is: waiting, armed for the second press, or posted. */
export type ConfirmPhase = "idle" | "armed" | "pending";

/**
 * What one press does. `submit: false` means the click's default action (the
 * form submit) must be prevented.
 *
 * ⚠️ The armed press submits but stays "armed": the phase becomes "pending"
 * only when the form's `submit` event actually fires (guardFormSubmit). If the
 * browser's own validation stops the post — a required field left empty —
 * the button must not be stranded in "pending" with nothing sent.
 */
export function confirmPress(phase: ConfirmPhase): { next: ConfirmPhase; submit: boolean } {
  if (phase === "idle") return { next: "armed", submit: false };
  if (phase === "armed") return { next: "armed", submit: true };
  return { next: "pending", submit: false };
}

/** Looking away disarms; it never un-sends a post already in flight. */
export const confirmBlur = (phase: ConfirmPhase): ConfirmPhase => (phase === "pending" ? "pending" : "idle");
/** The arm window ran out. */
export const confirmExpire = (phase: ConfirmPhase): ConfirmPhase => (phase === "armed" ? "idle" : phase);
```

`apps/web/app/components/confirm-button.tsx` (whole file):

```tsx
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { guardFormSubmit } from "@/lib/submit-guard";
import { confirmBlur, confirmExpire, confirmPress, type ConfirmPhase } from "@/lib/confirm-press";

export const ARM_MS = 4_000;

/**
 * The armed look (M4): the same button inverted to gold, so "press again" is
 * visible and not just a relabel. ⚠️ Gold, never rust — rust means an
 * obligation the player owes the server (globals.css), not "careful".
 */
export const ARMED_CLASS = "!border-2 !border-gold !bg-ground !text-gold";

/**
 * A submit button for the one-click removals — kick, demote, withdraw an
 * invite, revoke a pass — that need a confirmation but not a checkbox: the
 * first press arms it and swaps the label for `confirm` ("Press again to
 * remove"), the second press within four seconds submits the form it sits in.
 * Nothing happens if the player looks away; it disarms itself.
 *
 * No dialog: a `confirm()` blocks the page and reads badly on a phone, and
 * the site's forms otherwise never need script to submit.
 *
 * ⚠️ H1: once the form has posted, further presses do nothing. Before this a
 * third tap posted again: `armed` stayed true and every tap after the first
 * submitted. The form guard (lib/submit-guard.ts) refuses a second `submit`
 * even when this component's state has not caught up.
 */
export function ConfirmButton({ confirm, className, children, disabled = false, pending: pendingLabel }: {
  confirm: string; className: string; children: React.ReactNode; disabled?: boolean; pending?: React.ReactNode;
}) {
  const [phase, setPhase] = useState<ConfirmPhase>("idle");
  const ref = useRef<HTMLButtonElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hint = useId();
  const clear = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  useEffect(() => () => clear(), []);
  useEffect(() => {
    const form = ref.current?.form;
    if (!form) return undefined;
    return guardFormSubmit(form, window, (p) => { clear(); setPhase(p ? "pending" : "idle"); });
  }, []);

  return (
    <>
      <button ref={ref} type="submit" className={`${className} ${phase === "armed" ? ARMED_CLASS : ""} aria-disabled:opacity-40`}
        aria-live="polite" disabled={disabled}
        aria-describedby={phase === "armed" ? hint : undefined}
        aria-disabled={phase === "pending" || undefined} aria-busy={phase === "pending" || undefined}
        onClick={(e) => {
          const { next, submit } = confirmPress(phase);
          if (!submit) e.preventDefault();
          else clear();
          setPhase(next);
          if (phase === "idle") timer.current = setTimeout(() => setPhase(confirmExpire), ARM_MS);
        }}
        onBlur={() => { clear(); setPhase(confirmBlur); }}>
        {phase === "armed" ? confirm : phase === "pending" && pendingLabel !== undefined ? pendingLabel : children}
      </button>
      {/* M4: the second press, explained to a screen reader while it is armed. Visually the gold look and the "Press again to …" label say it. */}
      {phase === "armed" && <span id={hint} className="sr-only">{`Press again within ${ARM_MS / 1000} seconds to confirm. Wait, or move away, and it cancels itself.`}</span>}
    </>
  );
}
```

Label replacements (exact old → new, `replace_all` where the same string repeats in a file):

| File | Old | New |
|---|---|---|
| `app/(site)/clan/page.tsx` (lines 97, 98) | `confirm="Remove them?"` | `confirm="Press again to remove"` |
| `app/(site)/clan/page.tsx:100` | `confirm="Demote them?"` | `confirm="Press again to demote"` |
| `app/(site)/clan/page.tsx:121` | `confirm="Withdraw it?"` | `confirm="Press again to withdraw"` |
| `app/(site)/clan/page.tsx:167` | `confirm="Claim it?"` | `confirm="Press again to claim"` |
| `app/(site)/clan/page.tsx:183` | `confirm="Cast it?"` | `confirm="Press again to vote"` |
| `app/(site)/clan/page.tsx:209` | `confirm="Open the vote?"` | `confirm="Press again to open the vote"` |
| `app/(site)/clan/settings/page.tsx:74` | `confirm="Revoke it?"` | `confirm="Press again to revoke"` |
| `app/(site)/clan/vault/page.tsx:116` | `confirm="Rotate it?"` | `confirm="Press again to rotate"` |
| `app/(site)/clan/vault/page.tsx:121` | `confirm="Delete it?"` | `confirm="Press again to delete"` |
| `app/(site)/clan/vault/page.tsx:151` | `confirm="Rotate every lock?"` | `confirm="Press again to rotate all"` |
| `app/(site)/notifications/actions.tsx:31` | `confirm="Cast it?"` | `confirm="Press again to vote"` |
| `app/(site)/base/page.tsx:119` | `confirm="Release it?"` | `confirm="Press again to release"` |

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/confirm-button.test.tsx test/notification-actions.test.ts` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/confirm-press.ts apps/web/app/components/confirm-button.tsx apps/web/test/confirm-button.test.tsx "apps/web/app/(site)/clan/page.tsx" "apps/web/app/(site)/clan/settings/page.tsx" "apps/web/app/(site)/clan/vault/page.tsx" "apps/web/app/(site)/notifications/actions.tsx" "apps/web/app/(site)/base/page.tsx"
git commit -m "$(cat <<'EOF'
fix(web): ConfirmButton posts once, looks armed, and says to press again

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: H1 — every signed-in form sends once; a repeated claim lands on `/clan`

**Files:**
- Create: `apps/web/lib/claim-landing.ts`
- Modify: `apps/web/app/api/claim/route.ts:5,28`
- Modify: `apps/web/app/(site)/claim/[ceremony]/page.tsx:12,97`
- Modify: `apps/web/app/(site)/clan/page.tsx:11,28,112,142,143,224`
- Modify: `apps/web/app/(site)/clan/settings/page.tsx:11,56,66,89,104,120,134`
- Modify: `apps/web/app/(site)/clan/vault/page.tsx:14,93,110,145`
- Modify: `apps/web/app/(site)/base/page.tsx:11,141`
- Modify: `apps/web/app/(site)/notifications/actions.tsx:2,51`
- Modify: `apps/web/app/(site)/notifications/page.tsx:7,56`
- Test: `apps/web/test/submit-once.test.ts`

**Interfaces:**
- Consumes: `SubmitButton` (Task 2).
- Produces: `claimLanding(ceremonyId: number, outcome: string): string`.

- [ ] **Step 1: Write the failing test** — `apps/web/test/submit-once.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { claimLanding } from "../lib/claim-landing";

/**
 * H1: every form on the signed-in tool pages posts through SubmitButton or
 * ConfirmButton, which send once. A bare `<button type="submit">` is a
 * double-tap waiting to happen. New files in these folders are covered
 * automatically.
 */
const ROOTS = ["claim", "clan", "base", "notifications"].map((d) => join(import.meta.dirname, "..", "app", "(site)", d));
const files = ROOTS.flatMap((r) => readdirSync(r, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".tsx")).map((f) => join(r, f)));

describe("signed-in forms send once", () => {
  it("finds the pages", () => expect(files.length).toBeGreaterThan(5));
  it.each(files)("%s has no bare submit button", (f) => {
    expect(readFileSync(f, "utf8")).not.toContain('type="submit"');
  });
});

/** ⚠️ Review focus 5. */
describe("claimLanding", () => {
  it("sends a founded clan to /clan", () => expect(claimLanding(7, "ok")).toBe("/clan"));
  it("⚠️ sends a second POST for an already-claimed ceremony to /clan, not back to the 404 its ceremony page now is", () => {
    expect(claimLanding(7, "no-such-ceremony")).toBe("/clan");
    expect(claimLanding(7, "ceremony-taken")).toBe("/clan");
  });
  it("keeps a fixable refusal on the claim page", () => {
    expect(claimLanding(7, "name-taken")).toBe("/claim/7");
    expect(claimLanding(7, "too-close")).toBe("/claim/7");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/submit-once.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/claim-landing"`.

- [ ] **Step 3: Implement**

`apps/web/lib/claim-landing.ts`:

```ts
/**
 * Where a claim POST lands.
 *
 * ⚠️ H1 (UX review 2026-09-24): /claim/{id} renders only an OPEN ceremony and
 * is notFound() otherwise. The first "Found the clan" consumes the ceremony,
 * so a second POST (a double tap, a retry) came back with no-such-ceremony
 * and put a founder whose clan had just been created on a 404. Every outcome
 * that means "this ceremony is spent" lands on /clan instead, which shows the
 * clan if they are in it and the refusal if they are not.
 */
const SPENT = new Set(["ok", "no-such-ceremony", "ceremony-taken"]);

export function claimLanding(ceremonyId: number, outcome: string): string {
  return SPENT.has(outcome) ? "/clan" : `/claim/${ceremonyId}`;
}
```

`apps/web/app/api/claim/route.ts`:
- Add after line 5: `import { claimLanding } from "@/lib/claim-landing";`
- Replace line 28, `return outcome === "ok" ? { back: "/clan", code: code("claim", "ok") } : { back, code: code("claim", outcome) };`, with:

```ts
    return { back: claimLanding(ceremonyId, outcome), code: code("claim", outcome) };
```

Then replace the submit buttons, adding `SubmitButton` to each file's `@/app/components/ui` import:
- `claim/[ceremony]/page.tsx` line 12 — add `SubmitButton` to the ui import. Line 97 becomes:
  ```tsx
            <SubmitButton className={btnCta} pending={<>Founding… <span className="font-mono normal-case">→</span></>}>Found the clan <span className="font-mono normal-case">→</span></SubmitButton>
  ```
- `clan/page.tsx` line 11 — add `SubmitButton` to the ui import.
  - line 28: `: <button className={`${style} !px-3.5`} type="submit">{children}</button>}` → `: <SubmitButton className={`${style} !px-3.5`}>{children}</SubmitButton>}`
  - line 112: `<button className={`${btnPrimary} min-h-[52px] flex-none`} type="submit">Invite</button>` → `<SubmitButton className={`${btnPrimary} min-h-[52px] flex-none`}>Invite</SubmitButton>`
  - line 142: `<button className={`${btnPrimary} !px-3.5`} type="submit">Accept</button>` → `<SubmitButton className={`${btnPrimary} !px-3.5`}>Accept</SubmitButton>`
  - line 143: `<button className={`${btnSecondary} !px-3.5`} type="submit">Decline</button>` → `<SubmitButton className={`${btnSecondary} !px-3.5`}>Decline</SubmitButton>`
  - line 224: `<button className={`mt-3.5 ${btnDanger}`} type="submit">Leave the clan</button>` → `<SubmitButton className={`mt-3.5 ${btnDanger}`} pending="Leaving…">Leave the clan</SubmitButton>`
- `clan/settings/page.tsx` line 11 — add `SubmitButton` to the ui import.
  - line 56: `<button className={`${btnPrimary} self-start`} type="submit">Save</button>` → `<SubmitButton className={`${btnPrimary} self-start`}>Save</SubmitButton>`
  - line 66: `<button className={`${btnPrimary} self-start`} type="submit">Grant pass</button>` → `<SubmitButton className={`${btnPrimary} self-start`}>Grant pass</SubmitButton>`
  - line 89: `<button className={`${btnSecondary} self-start`} type="submit">Rename</button>` → `<SubmitButton className={`${btnSecondary} self-start`}>Rename</SubmitButton>`
  - line 104: `<button className={`${btnDanger} self-start`} type="submit">Transfer</button>` → `<SubmitButton className={`${btnDanger} self-start`} pending="Transferring…">Transfer</SubmitButton>`
  - line 120: `<button className={`${btnPrimary} !px-3.5`} type="submit">Move here</button>` → `<SubmitButton className={`${btnPrimary} !px-3.5`}>Move here</SubmitButton>` (Task 14 turns this into a two-press)
  - line 134: `<button className={`mt-3 ${btnDanger}`} type="submit">Disband the clan</button>` → `<SubmitButton className={`mt-3 ${btnDanger}`} pending="Disbanding…">Disband the clan</SubmitButton>`
- `clan/vault/page.tsx` line 14 — add `SubmitButton` to the ui import.
  - line 93: `<button className="flex min-h-[48px] items-center px-4 font-mono text-[11px] uppercase tracking-[0.18em] text-gold hover:text-ink" type="submit">Confirm changed</button>` → `<SubmitButton className="flex min-h-[48px] items-center px-4 font-mono text-[11px] uppercase tracking-[0.18em] text-gold hover:text-ink">Confirm changed</SubmitButton>`
  - line 110: `<button className={`${btnSecondary} self-start`} type="submit">Save</button>` → `<SubmitButton className={`${btnSecondary} self-start`}>Save</SubmitButton>`
  - line 145: `<button className={`${btnPrimary} self-start`} type="submit">Add lock</button>` → `<SubmitButton className={`${btnPrimary} self-start`}>Add lock</SubmitButton>`
- `base/page.tsx` line 11 — add `SubmitButton` to the ui import.
  - line 141: `<button className={btnPrimary} type="submit" disabled={view.declaration !== null}>Declare</button>` → `<SubmitButton className={btnPrimary} disabled={view.declaration !== null}>Declare</SubmitButton>`
- `notifications/actions.tsx`
  - line 2: `import { ConfirmButton } from "@/app/components/ui";` → `import { ConfirmButton, SubmitButton } from "@/app/components/ui";`
  - line 51: `<button type="submit" className={btn(tone)}>{label}</button>` → `<SubmitButton className={btn(tone)}>{label}</SubmitButton>`
- `notifications/page.tsx`
  - line 7: `import { Pager, Notice } from "@/app/components/ui";` → `import { Pager, Notice, SubmitButton } from "@/app/components/ui";`
  - line 56: `<button type="submit" className="flex min-h-[38px] items-center border border-rule-3 px-3.5 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-2 hover:border-ink hover:text-ink">Mark all read</button>` → `<SubmitButton className="flex min-h-[38px] items-center border border-rule-3 px-3.5 font-mono text-[11px] uppercase tracking-[0.18em] text-ink-2 hover:border-ink hover:text-ink">Mark all read</SubmitButton>` (Task 15 fixes its height)

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/submit-once.test.ts test/notification-actions.test.ts test/base-report.test.ts` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/claim-landing.ts apps/web/app/api/claim/route.ts "apps/web/app/(site)/claim/[ceremony]/page.tsx" "apps/web/app/(site)/clan/page.tsx" "apps/web/app/(site)/clan/settings/page.tsx" "apps/web/app/(site)/clan/vault/page.tsx" "apps/web/app/(site)/base/page.tsx" "apps/web/app/(site)/notifications/actions.tsx" "apps/web/app/(site)/notifications/page.tsx" apps/web/test/submit-once.test.ts
git commit -m "$(cat <<'EOF'
fix(web): signed-in forms send once; a repeated claim lands on /clan, not a 404

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: H2 — refused forms carry back what was typed (`lib/form.ts`)

**The mechanism, chosen once, used everywhere:** non-secret values ride back as `kept.<name>` query parameters on the same 303 that already carries `?result=`. The query is built by `resultQuery`, called only from `formAction`. Pages read it back only through `readKept`.

Why this and not a flash cookie or client-side state:
- It uses the channel every form already uses. It works with JavaScript off, survives a reload, needs no server state, and both halves are pure functions tested without a request context.
- The cost is that values appear in the URL: in history, and in nginx's access log. That is why a deny-list, `NEVER_KEEP = {"code"}`, sits in **both** `resultQuery` and `readKept`. A vault code can reach neither a `Location` header nor a rendered page, even if a future route passes it or a crafted link carries it.
- Values are length-capped (`KEEP_VALUE_MAX`, and each field's own limit through `keepFrom`). An over-long value is **dropped, not truncated**: a silently cut value is worse than an empty field.
- Kept values only ever fill a field's `defaultValue`, or re-check an option the page already lists. They are never rendered as text. The copy rule "the code is looked up, never echoed" stands.

**Files:**
- Modify: `apps/web/lib/form.ts:6,30-38` (type, `formAction`) plus new exports appended
- Test: `apps/web/test/form.test.ts` (extend the import on line 2; append three `describe` blocks)

**Interfaces:**
- Produces:
  - `type Keep = Record<string, string | readonly string[]>`
  - `type Redirect = { back: string; code: string; keep?: Keep }`
  - `KEEP_PREFIX = "kept."`
  - `KEEP_VALUE_MAX = 200`
  - `KEEP_LIST_MAX = 16`
  - `resultQuery(code: string, keep?: Keep): string`
  - `keepFrom(form: FormData, fields: Record<string, number>): Record<string, string>`
  - `type Kept = { get(name: string): string | undefined; all(name: string): string[] }`
  - `readKept(params: Record<string, string | string[] | undefined>): Kept`

- [ ] **Step 1: Write the failing test** — in `apps/web/test/form.test.ts` change line 2 to

```ts
import { text, id, confirmed, redirectTo, optionalText, resultQuery, keepFrom, readKept, KEEP_VALUE_MAX, KEEP_LIST_MAX } from "../lib/form";
```

and append:

```ts
describe("resultQuery: a refusal carries back what was typed (H2)", () => {
  it("is only the result when nothing is kept", () => {
    expect(resultQuery("kick.ok")).toBe("?result=kick.ok");
  });

  /** ⚠️ Review focus 2. */
  it("⚠️ round-trips &, =, + and unicode without breaking the query", () => {
    const typed = "Bread & Roses = +1 ✦ Ñandú";
    const back = new URLSearchParams(resultQuery("rename.name-taken", { name: typed }).slice(1));
    expect(back.get("result")).toBe("rename.name-taken");
    expect(back.get("kept.name")).toBe(typed);
    expect([...back.keys()]).toEqual(["result", "kept.name"]);
  });

  /** ⚠️ Review focus 3. */
  it("⚠️ never carries a vault code, whatever the caller passes", () => {
    const q = resultQuery("add.bad-name", { name: "Gate", code: "1234" });
    expect(q).not.toContain("1234");
    expect(q).not.toContain("kept.code");
  });

  it("⚠️ drops an over-long value rather than cutting it", () => {
    const back = new URLSearchParams(resultQuery("claim.bad-name", { name: "x".repeat(KEEP_VALUE_MAX + 1), tag: "IRON" }).slice(1));
    expect(back.get("kept.name")).toBeNull();
    expect(back.get("kept.tag")).toBe("IRON");
  });

  it("repeats a list, capped", () => {
    const q = resultQuery("claim.bad-roster", { member: Array.from({ length: KEEP_LIST_MAX + 4 }, (_, i) => `p${i}`) });
    expect(new URLSearchParams(q.slice(1)).getAll("kept.member")).toHaveLength(KEEP_LIST_MAX);
  });
});

describe("keepFrom", () => {
  it("keeps only the named fields, trimmed, within their own limits", () => {
    const f = form({ name: "  Iron  ", tag: "TOOLONG", code: "1234", note: "" });
    expect(keepFrom(f, { name: 32, tag: 5, note: 140 })).toEqual({ name: "Iron" });
  });

  it("⚠️ refuses code even when a caller lists it", () => {
    expect(keepFrom(form({ code: "1234" }), { code: 4 })).toEqual({});
  });
});

describe("readKept", () => {
  it("reads single and repeated values", () => {
    const k = readKept({ "kept.name": "Iron", "kept.member": ["a", "b"], result: "claim.bad-name" });
    expect(k.get("name")).toBe("Iron");
    expect(k.all("member")).toEqual(["a", "b"]);
    expect(k.get("tag")).toBeUndefined();
  });

  /** ⚠️ Review focus 3: a crafted link cannot put a code into the page. */
  it("⚠️ refuses `code` even from a crafted URL", () => {
    expect(readKept({ "kept.code": "1234" }).get("code")).toBeUndefined();
  });

  it("refuses over-long values and prototype keys", () => {
    expect(readKept({ "kept.name": "x".repeat(KEEP_VALUE_MAX + 1) }).get("name")).toBeUndefined();
    expect(readKept({}).get("constructor")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/form.test.ts`
Expected: FAIL — `resultQuery is not a function` (the import resolves to undefined).

- [ ] **Step 3: Implement** — in `apps/web/lib/form.ts`

Replace line 6, `export type Redirect = { back: string; code: string };`, with:

```ts
/** Non-secret values a refused form sends back, so the player does not retype them (H2). */
export type Keep = Record<string, string | readonly string[]>;
export type Redirect = { back: string; code: string; keep?: Keep };
```

Replace lines 35–37 (the tail of `formAction`):

```ts
  const out = await run(session, form);
  const { back: target, code, keep } = typeof out === "string" ? { back, code: out, keep: undefined } : out;
  return redirectTo(origin, target, resultQuery(code, keep));
```

Append at the end of the file:

```ts
/** Query-string prefix for kept values: `?result=…&kept.name=…`. */
export const KEEP_PREFIX = "kept.";
/** No kept value is longer than this, whatever the field's own limit. */
export const KEEP_VALUE_MAX = 200;
/** No kept list (the claim roster) is longer than this. */
export const KEEP_LIST_MAX = 16;

/**
 * ⚠️ Never kept, never read back. A vault code must never enter a URL
 * (CLAUDE.md, the vault); a kept value is in the address bar, the history and
 * the access log. Enforced here, in BOTH directions, so a future route that
 * passes it — or a crafted link that carries it — still cannot leak one.
 */
const NEVER_KEEP = new Set(["code"]);

const keepable = (v: string) => v.length > 0 && v.length <= KEEP_VALUE_MAX;

/**
 * The query a form redirect carries: the result code, then any kept values.
 *
 * ⚠️ URLSearchParams, never string concatenation: a typed "&" or "=" would
 * otherwise split the query and a kept name would come back as two fields.
 * An over-long value is DROPPED, not cut — a silently truncated name in the
 * field is worse than an empty one.
 */
export function resultQuery(code: string, keep?: Keep): string {
  const q = new URLSearchParams({ result: code });
  for (const [name, value] of Object.entries(keep ?? {})) {
    if (NEVER_KEEP.has(name)) continue;
    const values = typeof value === "string" ? [value] : value.slice(0, KEEP_LIST_MAX);
    for (const v of values) if (keepable(v)) q.append(KEEP_PREFIX + name, v);
  }
  return `?${q.toString()}`;
}

/**
 * The fields of a refused form worth handing back, trimmed, each within its
 * own limit. Only the fields named in `fields` — a route lists what it keeps,
 * so nothing is kept by accident.
 */
export function keepFrom(form: FormData, fields: Record<string, number>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, max] of Object.entries(fields)) {
    if (NEVER_KEEP.has(name)) continue;
    const v = form.get(name);
    if (typeof v !== "string") continue;
    const t = v.trim();
    if (t.length > 0 && t.length <= Math.min(max, KEEP_VALUE_MAX)) out[name] = t;
  }
  return out;
}

export type Kept = { get(name: string): string | undefined; all(name: string): string[] };

/**
 * A page's view of its kept values. ⚠️ Attacker-suppliable like every query
 * value, so the page only ever puts one into a field's defaultValue or
 * re-checks an option it already lists — never renders it as text.
 */
export function readKept(params: Record<string, string | string[] | undefined>): Kept {
  const all = (name: string): string[] => {
    const key = KEEP_PREFIX + name;
    if (NEVER_KEEP.has(name) || !Object.hasOwn(params, key)) return [];
    const v = params[key];
    const list = typeof v === "string" ? [v] : Array.isArray(v) ? v : [];
    return list.filter(keepable).slice(0, KEEP_LIST_MAX);
  };
  return { get: (name) => all(name)[0], all };
}
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/form.test.ts` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/form.ts apps/web/test/form.test.ts
git commit -m "$(cat <<'EOF'
feat(web): a refused form can carry its non-secret values back on the redirect

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: H2 + H3 + L4 — the claim form keeps its input, focuses its error, marks its flag

**Files:**
- Create: `apps/web/app/(site)/claim/[ceremony]/claim-form.tsx`
- Modify: `apps/web/app/(site)/claim/[ceremony]/page.tsx` (whole file, below)
- Modify: `apps/web/app/api/claim/route.ts` (whole file, below)
- Test: `apps/web/test/claim-form.test.tsx`

**Interfaces:**
- Consumes:
  - `readKept`, `keepFrom`, `Redirect` (Task 5)
  - `claimLanding` (Task 4)
  - `SubmitButton` (Task 2)
  - `FieldError` type from `@/lib/field-errors`
- Produces:
  - `type ClaimKept = { name?: string; tag?: string; texture?: string; members: string[] }`
  - `ClaimForm(props: { ceremonyId: number; freeFlags: string[]; participants: { dayzId: string; gamertag: string }[]; meDayzId: string | null; err: FieldError | null; kept: ClaimKept })`

- [ ] **Step 1: Write the failing test** — `apps/web/test/claim-form.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ClaimForm, type ClaimKept } from "../app/(site)/claim/[ceremony]/claim-form";
import type { FieldError } from "../lib/field-errors";

const PARTS = [{ dayzId: "me", gamertag: "Ronald" }, { dayzId: "p2", gamertag: "Ada" }, { dayzId: "p3", gamertag: "Bo" }];
const render = (o: { err?: FieldError | null; kept?: ClaimKept } = {}) => renderToStaticMarkup(
  <ClaimForm ceremonyId={7} freeFlags={["Flag_Bear", "Flag_Wolf"]} participants={PARTS} meDayzId="me" err={o.err ?? null} kept={o.kept ?? { members: [] }} />,
);
/** The one <input …/> tag containing `needle`. */
const input = (html: string, needle: string) => html.match(new RegExp(`<input[^>]*${needle}[^>]*/>`, "u"))?.[0] ?? "";

describe("the claim form keeps what the founder typed (H2)", () => {
  /** ⚠️ Review focus 2: the typed value reaches the field escaped, and whole. */
  it("⚠️ refills name and tag, HTML-escaped", () => {
    const html = render({ kept: { name: "Iron & Ash ✦", tag: "IRON", members: [] } });
    expect(input(html, 'name="name"')).toContain('value="Iron &amp; Ash ✦"');
    expect(input(html, 'name="tag"')).toContain('value="IRON"');
  });

  it("re-picks the kept flag while it is still free", () => {
    const html = render({ kept: { texture: "Flag_Wolf", members: [] } });
    expect(input(html, 'value="Flag_Wolf"')).toContain('checked=""');
    expect(input(html, 'value="Flag_Bear"')).not.toContain('checked=""');
  });

  it("picks nothing when the kept flag has been taken since", () => {
    expect(render({ kept: { texture: "Flag_Gone", members: [] } })).not.toMatch(/<input type="radio"[^>]*checked=""/u);
  });

  it("keeps an unticked founder unticked", () => {
    const html = render({ kept: { members: ["me", "p2"] } });
    expect(input(html, 'value="p2"')).toContain('checked=""');
    expect(input(html, 'value="p3"')).not.toContain('checked=""');
  });

  it("ticks everyone when there is nothing to restore", () => {
    const html = render();
    expect(input(html, 'value="p2"')).toContain('checked=""');
    expect(input(html, 'value="p3"')).toContain('checked=""');
  });
});

describe("a flag or roster refusal takes focus (H3)", () => {
  it("focuses the first flag and ties the group to the sentence", () => {
    const html = render({ err: { field: "texture", message: "Pick one of the free flags." } });
    expect(input(html, 'value="Flag_Bear"')).toContain('autofocus=""');
    expect(html).toContain('aria-describedby="err-texture"');
    expect(html).toContain("Pick one of the free flags.");
  });

  it("focuses the first founder the claimant can untick, never their own locked box", () => {
    const html = render({ err: { field: "member", message: "The roster must be people who were at the ceremony, and must include you." } });
    expect(input(html, 'value="p2"')).toContain('autofocus=""');
    expect(input(html, 'type="checkbox"[^>]*value="me"')).not.toContain("autofocus");
  });
});

describe("L4", () => {
  it("puts the legend first in the roster fieldset", () => {
    expect(render({ err: { field: "member", message: "x" } })).toMatch(/<fieldset aria-describedby="err-member"><legend/u);
  });
  it("gives the flag picture an empty alt — the name is printed under it", () => {
    const html = render();
    expect(html).not.toContain('alt="Flag_Bear"');
    expect(html).toContain('alt=""');
  });
  it("marks the chosen flag with a glyph as well as a colour", () => {
    expect(render()).toContain("group-has-[:checked]:flex");
  });
});

describe("the claim route", () => {
  const ROUTE = readFileSync(join(import.meta.dirname, "..", "app", "api", "claim", "route.ts"), "utf8");
  it("keeps the roster it was sent on every refusal", () => expect(ROUTE).toContain("member: members"));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/claim-form.test.tsx`
Expected: FAIL — `Failed to resolve import "../app/(site)/claim/[ceremony]/claim-form"`.

- [ ] **Step 3: Implement**

`apps/web/app/(site)/claim/[ceremony]/claim-form.tsx`:

```tsx
import { ACTIVATION_WINDOW_MS, CLAN_NAME_LENGTH, CLAN_SIZE_CAP, CLAN_TAG_LENGTH, MIN_BASE_SPACING_M } from "@factions/domain";
import { days } from "@/lib/format";
import { flagImagePath } from "@/src/flag-images";
import type { FieldError as FieldErrorT } from "@/lib/field-errors";
import { Panel, PanelBody, FieldError, SubmitButton, invalid, btnCta, field, fieldLabel, checkbox, kickerSm } from "@/app/components/ui";

/** What a refused claim sent back (lib/form.ts readKept). */
export type ClaimKept = { name?: string; tag?: string; texture?: string; members: string[] };

/**
 * The four panels of /claim/{ceremony}: name and tag, flag, roster, and the
 * button.
 *
 * H2: a refusal ("name taken") used to cost the founder all four panels,
 * and brought unticked founders back ticked. Every field now comes back as
 * it was sent.
 *
 * H3: a flag or roster refusal focuses the first control of that group, which
 * is described by the sentence, so it is announced where it is fixed.
 */
export function ClaimForm({ ceremonyId, freeFlags, participants, meDayzId, err, kept }: {
  ceremonyId: number; freeFlags: string[]; participants: { dayzId: string; gamertag: string }[]; meDayzId: string | null; err: FieldErrorT | null; kept: ClaimKept;
}) {
  // ⚠️ A kept flag is re-picked only while it is still free: "flag-taken" means
  // someone else holds it now, and re-checking it would re-send a refusal.
  const keptFlag = kept.texture !== undefined && freeFlags.includes(kept.texture) ? kept.texture : undefined;
  // ⚠️ Empty means "nothing to restore", not "nobody ticked": the claimant's own
  // hidden field always posts, so a refused roster that came back is never empty.
  const keptMembers = kept.members.length > 0 ? new Set(kept.members) : null;
  const flagErr = err?.field === "texture";
  const memberErr = err?.field === "member";
  const firstOther = participants.find((p) => p.dayzId !== meDayzId)?.dayzId;

  return (
    <form className="flex flex-col gap-4 lg:gap-6" action="/api/claim" method="post">
      <input type="hidden" name="ceremonyId" value={ceremonyId} />

      <Panel num="01" title="Name and tag">
        <PanelBody className="flex flex-col gap-3">
          <label className="block"><span className={fieldLabel}>Name</span>
            <input {...invalid(err, "name")} className={`${field} ${invalid(err, "name").className ?? ""}`} name="name" defaultValue={kept.name} required minLength={CLAN_NAME_LENGTH.min} maxLength={CLAN_NAME_LENGTH.max} autoComplete="off" />
            <FieldError err={err} name="name" />
          </label>
          <label className="block"><span className={fieldLabel}>Tag — {CLAN_TAG_LENGTH.min} to {CLAN_TAG_LENGTH.max} letters or digits</span>
            <input {...invalid(err, "tag")} className={`${field} uppercase ${invalid(err, "tag").className ?? ""}`} name="tag" defaultValue={kept.tag} required minLength={CLAN_TAG_LENGTH.min} maxLength={CLAN_TAG_LENGTH.max} pattern="[A-Za-z0-9]+" title={`${CLAN_TAG_LENGTH.min} to ${CLAN_TAG_LENGTH.max} letters or digits`} autoComplete="off" />
            <FieldError err={err} name="tag" />
          </label>
        </PanelBody>
      </Panel>

      <Panel num="02" title="Flag" aside={`${freeFlags.length} free`} tone={flagErr ? "rust" : "plain"}>
        <PanelBody>
          <fieldset aria-describedby={flagErr ? "err-texture" : undefined}>
            <legend className="sr-only">Flag</legend>
            <FieldError err={err} name="texture" />
            <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6">
              {freeFlags.map((f, i) => (
                <li key={f}>
                  <label className="group relative flex cursor-pointer flex-col items-center gap-1 border-2 border-rule-3 p-2 has-[:checked]:border-gold has-[:checked]:bg-surface has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-gold">
                    <input type="radio" name="texture" value={f} required className="sr-only" defaultChecked={f === keptFlag}
                      aria-invalid={flagErr || undefined} autoFocus={flagErr && i === 0 ? true : undefined} />
                    {/* L4: the pick is marked by a glyph as well as the edge colour, so it never rests on colour alone. */}
                    <span aria-hidden="true" className="absolute right-1 top-1 hidden h-4 w-4 items-center justify-center bg-gold font-mono text-[11px] leading-none text-ground group-has-[:checked]:flex">✓</span>
                    {/* L4: alt="" — the flag's name is the text right under it; alt={f} made a reader say it twice. */}
                    <img src={`/${flagImagePath(f)}`} alt="" width={48} height={48} className="h-12 w-12 object-contain" />
                    <span className="font-mono text-[11px] text-muted">{f.replace(/^Flag_/u, "")}</span>
                  </label>
                </li>
              ))}
            </ul>
          </fieldset>
        </PanelBody>
      </Panel>

      <Panel num="03" title="Roster" aside={`at most ${CLAN_SIZE_CAP}`} tone={memberErr ? "rust" : "plain"}>
        <PanelBody>
          <fieldset aria-describedby={memberErr ? "err-member" : undefined}>
            {/* L4: the legend must be the fieldset's first child, or it is not its name. */}
            <legend className="text-sm leading-relaxed text-ink-2">Untick anyone who should not be in. Only people at the ceremony can be founding members.</legend>
            <FieldError err={err} name="member" />
            <ul className="mt-2 flex flex-col">
              {participants.map((p) => {
                const self = p.dayzId === meDayzId;
                return (
                  <li key={p.dayzId}>
                    <label className="flex min-h-[44px] items-center gap-3 text-ink">
                      <input type="checkbox" name="member" value={p.dayzId} disabled={self} className={checkbox}
                        defaultChecked={self || (keptMembers ? keptMembers.has(p.dayzId) : true)}
                        aria-invalid={memberErr || undefined} autoFocus={memberErr && p.dayzId === firstOther ? true : undefined} />
                      <span className="font-mono">{p.gamertag}</span>
                      {self && <span className={`${kickerSm} !text-gold`}>you — leader</span>}
                    </label>
                  </li>
                );
              })}
            </ul>
            {/* A disabled checkbox does not post; the claimant must be on the roster, so carry them explicitly. */}
            {meDayzId && <input type="hidden" name="member" value={meDayzId} />}
          </fieldset>
        </PanelBody>
      </Panel>

      <p className="text-sm leading-relaxed text-ink-2">Claiming reserves the name, tag, flag and pole. Raise your flag at the pole within {days(ACTIVATION_WINDOW_MS)} to activate. No two bases sit within {MIN_BASE_SPACING_M} m of each other — if the pole is too close to one you cannot see, the claim is refused.</p>
      <SubmitButton className={btnCta} pending={<>Founding… <span className="font-mono normal-case">→</span></>}>Found the clan <span className="font-mono normal-case">→</span></SubmitButton>
    </form>
  );
}
```

`apps/web/app/(site)/claim/[ceremony]/page.tsx` (whole file):

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { claimContext } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { readKept } from "@/lib/form";
import { when, ago } from "@/lib/format";
import { guideLinkFor } from "@/lib/guide-links";
import { fieldError } from "@/lib/field-errors";
import { Page, PageHead, Body, Notice, BackLine, SessionLost } from "@/app/components/ui";
import { ClaimForm } from "./claim-form";

export const metadata: Metadata = { title: "Clan Wars — found your clan", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

export default async function ClaimPage({ params, searchParams }: { params: Promise<{ ceremony: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { ceremony: raw } = await params;
  const q = await searchParams;
  const result = typeof q.result === "string" ? q.result : undefined;
  const session = await currentSession();
  if (!session) return <SessionLost next={`/claim/${raw}`} />;
  // ⚠️ The package returns the VIEWER's open ceremony; the id in the URL must be that one, or it is not theirs to see.
  const ctx = await claimContext(session.sub);
  if (!ctx || String(ctx.ceremony.id) !== raw) notFound();
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  // A refusal about one field — name, tag, flag or roster — is shown at that field too, which takes focus instead of the notice.
  const err = fieldError(result, RESULT_COPY);
  const kept = readKept(q);
  const me = ctx.ceremony.participants.find((p) => p.discordId === session.sub);

  return (
    <Page>
      <PageHead guide={guideLinkFor("/claim/[ceremony]")} kicker="Found your clan" title={`${ctx.ceremony.participants.length} of you raised the flag`}
        sub={<>Witnessed {ago(ctx.ceremony.detectedAt)}. Claim it before {when(ctx.ceremony.expiresAt)}. Whoever claims becomes leader.</>} />
      <Body className="flex max-w-[44rem] flex-col gap-4 lg:gap-6">
        {notice && <Notice focus={err === null}>{notice}</Notice>}
        <ClaimForm ceremonyId={ctx.ceremony.id} freeFlags={ctx.freeFlags} participants={ctx.ceremony.participants} meDayzId={me?.dayzId ?? null} err={err}
          kept={{ name: kept.get("name"), tag: kept.get("tag"), texture: kept.get("texture"), members: kept.all("member") }} />
        <BackLine href="/me">Your page</BackLine>
      </Body>
    </Page>
  );
}
```

`apps/web/app/api/claim/route.ts` (whole file):

```ts
import type { NextRequest, NextResponse } from "next/server";
import { claimCeremony } from "@factions/roster";
import { CLAN_NAME_LENGTH, CLAN_TAG_LENGTH } from "@factions/domain";
import { formAction, id, keepFrom, text, type Redirect } from "@/lib/form";
import { claimLanding } from "@/lib/claim-landing";
import { code } from "@/lib/clan-copy";

const DAYZ_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;
const TAG_RE = new RegExp(`^[A-Z0-9]{${CLAN_TAG_LENGTH.min},${CLAN_TAG_LENGTH.max}}$`, "u");
/** Flag textures are `Flag_*` class names; this only bounds what a refused form sends back. */
const TEXTURE_MAX = 64;

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
    const members = form.getAll("member").filter((m): m is string => typeof m === "string" && DAYZ_ID_RE.test(m));
    // H2: every refusal below carries back what the founder picked — name, tag,
    // flag and exactly who they ticked — so "name taken" costs one field, not four panels.
    const refuse = (c: string): Redirect => ({
      back, code: c,
      keep: { ...keepFrom(form, { name: CLAN_NAME_LENGTH.max, tag: CLAN_TAG_LENGTH.max, texture: TEXTURE_MAX }), member: members },
    });
    const name = text(form, "name", CLAN_NAME_LENGTH.max);
    if (!name || name.length < CLAN_NAME_LENGTH.min) return refuse(code("claim", "bad-name"));
    const tag = text(form, "tag", CLAN_TAG_LENGTH.max)?.toUpperCase() ?? null;
    if (!tag || !TAG_RE.test(tag)) return refuse(code("claim", "bad-tag"));
    const texture = text(form, "texture", TEXTURE_MAX);
    if (!texture) return refuse(code("claim", "bad-flag"));
    const outcome = await claimCeremony(session.sub, ceremonyId, { name, tag, texture, memberDayzIds: members });
    const landing = claimLanding(ceremonyId, outcome);
    return landing === back ? refuse(code("claim", outcome)) : { back: landing, code: code("claim", outcome) };
  });
}
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/claim-form.test.tsx test/submit-once.test.ts test/request-time-rendering.test.ts test/copy-vocabulary.test.ts` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/claim/[ceremony]/claim-form.tsx" "apps/web/app/(site)/claim/[ceremony]/page.tsx" apps/web/app/api/claim/route.ts apps/web/test/claim-form.test.tsx
git commit -m "$(cat <<'EOF'
fix(web): a refused claim keeps name, tag, flag and roster, and focuses the field at fault

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: H2 — rename, invite and guest pass keep what was typed

**Files:**
- Create: `apps/web/app/(site)/clan/settings/rename-form.tsx`
- Modify:
  - `apps/web/app/api/clan/rename/route.ts` (whole file)
  - `apps/web/app/api/clan/invite/route.ts` (whole file)
  - `apps/web/app/api/clan/guest/route.ts` (whole file)
- Modify: `apps/web/app/(site)/clan/settings/page.tsx` at:
  - line 12 (imports)
  - lines 19–20 (signature)
  - line 65 (guest field)
  - lines 84–91 (the rename panel body)
- Modify: `apps/web/app/(site)/clan/page.tsx` at:
  - line 13 (imports)
  - lines 35–36 (signature)
  - line 111 (invite field)
- Test: `apps/web/test/rename-form.test.tsx`

**Interfaces:**
- Consumes: `keepFrom`, `readKept`, `Redirect` (Task 5); `SubmitButton`.
- Produces: `RenameForm(props: { name: string; tag: string; err: FieldError | null; kept: { name?: string; tag?: string } })`.

- [ ] **Step 1: Write the failing test** — `apps/web/test/rename-form.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { RenameForm } from "../app/(site)/clan/settings/rename-form";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", ...p), "utf8");
const input = (html: string, needle: string) => html.match(new RegExp(`<input[^>]*${needle}[^>]*/>`, "u"))?.[0] ?? "";

describe("rename keeps the refused name under its refusal (H2)", () => {
  it("shows the typed name, not the current one, beside 'Another clan has that name.'", () => {
    const html = renderToStaticMarkup(<RenameForm name="Bears" tag="BEAR" err={{ field: "name", message: "Another clan has that name." }} kept={{ name: "Wolves & Co", tag: "WOLF" }} />);
    expect(input(html, 'name="name"')).toContain('value="Wolves &amp; Co"');
    expect(input(html, 'name="name"')).toContain('aria-invalid="true"');
    expect(input(html, 'name="tag"')).toContain('value="WOLF"');
    expect(html).toContain("Another clan has that name.");
  });

  it("shows the clan's own name and tag when nothing was refused", () => {
    const html = renderToStaticMarkup(<RenameForm name="Bears" tag="BEAR" err={null} kept={{}} />);
    expect(input(html, 'name="name"')).toContain('value="Bears"');
    expect(input(html, 'name="tag"')).toContain('value="BEAR"');
  });
});

describe("invite and guest pass keep their gamertag (H2)", () => {
  it("the invite field is refilled", () => expect(read("app", "(site)", "clan", "page.tsx")).toContain('defaultValue={kept.get("gamertag")}'));
  it("the guest field is refilled", () => expect(read("app", "(site)", "clan", "settings", "page.tsx")).toContain('defaultValue={kept.get("target")}'));
  it("the routes send it back only on a refusal", () => {
    expect(read("app", "api", "clan", "invite", "route.ts")).toContain('outcome === "ok" ? code("invite", outcome) : { back: "/clan", code: code("invite", outcome), keep: { gamertag } }');
    expect(read("app", "api", "clan", "guest", "route.ts")).toContain('outcome === "ok" ? code("guest", outcome) : { back: "/clan/settings", code: code("guest", outcome), keep: { target } }');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/rename-form.test.tsx`
Expected: FAIL — `Failed to resolve import "../app/(site)/clan/settings/rename-form"`.

- [ ] **Step 3: Implement**

`apps/web/app/(site)/clan/settings/rename-form.tsx`:

```tsx
import { CLAN_NAME_LENGTH, CLAN_TAG_LENGTH } from "@factions/domain";
import type { FieldError as FieldErrorT } from "@/lib/field-errors";
import { FieldError, SubmitButton, invalid, btnSecondary, field, fieldLabel } from "@/app/components/ui";

/**
 * The leader's rename form.
 *
 * H2: a refused rename comes back with what was typed. Before, the fields
 * reset to the clan's current name, so "Another clan has that name." sat
 * under the name the clan already has — the one name it was plainly not about.
 */
export function RenameForm({ name, tag, err, kept }: { name: string; tag: string; err: FieldErrorT | null; kept: { name?: string; tag?: string } }) {
  return (
    <form className="flex flex-col gap-3" action="/api/clan/rename" method="post">
      <label className="block"><span className={fieldLabel}>Name</span><input {...invalid(err, "name")} className={`${field} ${invalid(err, "name").className ?? ""}`} name="name" defaultValue={kept.name ?? name} required minLength={CLAN_NAME_LENGTH.min} maxLength={CLAN_NAME_LENGTH.max} /><FieldError err={err} name="name" /></label>
      <label className="block"><span className={fieldLabel}>Tag</span><input name="tag" defaultValue={kept.tag ?? tag} minLength={CLAN_TAG_LENGTH.min} maxLength={CLAN_TAG_LENGTH.max} pattern="[A-Za-z0-9]+" title={`${CLAN_TAG_LENGTH.min} to ${CLAN_TAG_LENGTH.max} letters or digits`} {...invalid(err, "tag")} className={`${field} uppercase ${invalid(err, "tag").className ?? ""}`} aria-describedby={err?.field === "tag" ? "err-tag rename-note" : "rename-note"} /><FieldError err={err} name="tag" /></label>
      <p id="rename-note" className="text-xs text-muted">The old name and tag stay held — nobody else can take them.</p>
      <SubmitButton className={`${btnSecondary} self-start`}>Rename</SubmitButton>
    </form>
  );
}
```

`apps/web/app/api/clan/rename/route.ts` (whole file):

```ts
import type { NextRequest, NextResponse } from "next/server";
import { rename } from "@factions/roster";
import { CLAN_NAME_LENGTH, CLAN_TAG_LENGTH } from "@factions/domain";
import { formAction, keepFrom, text, type Redirect } from "@/lib/form";
import { code } from "@/lib/clan-copy";

const TAG_RE = new RegExp(`^[A-Z0-9]{${CLAN_TAG_LENGTH.min},${CLAN_TAG_LENGTH.max}}$`, "u");

/** POST from /clan/settings. Leader only; the package enforces the cooldown and uniqueness. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session, form) => {
    // H2: a refusal comes back with what was typed, so the sentence sits under the name it is about.
    const refuse = (c: string): Redirect => ({ back: "/clan/settings", code: c, keep: keepFrom(form, { name: CLAN_NAME_LENGTH.max, tag: CLAN_TAG_LENGTH.max }) });
    const name = text(form, "name", CLAN_NAME_LENGTH.max);
    if (!name || name.length < CLAN_NAME_LENGTH.min) return refuse(code("rename", "bad-name"));
    const rawTag = form.get("tag");
    const tag = typeof rawTag === "string" && rawTag.trim() !== "" ? rawTag.trim().toUpperCase() : undefined;
    if (tag !== undefined && !TAG_RE.test(tag)) return refuse(code("rename", "bad-tag"));
    const outcome = await rename(session.sub, tag ? { name, tag } : { name });
    return outcome === "ok" ? code("rename", outcome) : refuse(code("rename", outcome));
  });
}
```

`apps/web/app/api/clan/invite/route.ts` (whole file):

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
    // H2: a refused invite keeps the gamertag, so a mistyped capital is one edit, not a retype.
    return outcome === "ok" ? code("invite", outcome) : { back: "/clan", code: code("invite", outcome), keep: { gamertag } };
  });
}
```

`apps/web/app/api/clan/guest/route.ts` (whole file):

```ts
import type { NextRequest, NextResponse } from "next/server";
import { grantGuestPass } from "@factions/roster";
import { formAction, text } from "@/lib/form";
import { GAMERTAG_MAX } from "@/lib/clan-limits";
import { code } from "@/lib/clan-copy";

const DISCORD_ID_RE = /^\d+$/u;

/** POST from /clan/settings. Officer+; `target` is a Discord user id (digits) or a linked gamertag. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session, form) => {
    const target = text(form, "target", GAMERTAG_MAX);
    if (!target) return code("input", "bad-input");
    const ref = DISCORD_ID_RE.test(target) ? { discordId: target } : { gamertag: target };
    const { outcome } = await grantGuestPass(session.sub, ref);
    // H2: a refused grant keeps what was typed.
    return outcome === "ok" ? code("guest", outcome) : { back: "/clan/settings", code: code("guest", outcome), keep: { target } };
  });
}
```

`apps/web/app/(site)/clan/settings/page.tsx`:

- After line 12 (`import { fieldError } from "@/lib/field-errors";`) add:
  ```tsx
  import { readKept } from "@/lib/form";
  import { RenameForm } from "./rename-form";
  ```
- Lines 19–20 become:
  ```tsx
  export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const q = await searchParams;
    const result = typeof q.result === "string" ? q.result : undefined;
    const kept = readKept(q);
  ```
- Line 65: inside the `GamertagField`, after `name="target"`, add `defaultValue={kept.get("target")}`.
- Lines 85–90 (the `<form className="flex flex-col gap-3" action="/api/clan/rename" …>…</form>` inside the Rename panel's `PanelBody`) become:
  ```tsx
                  <RenameForm name={clan.name} tag={clan.tag} err={err} kept={{ name: kept.get("name"), tag: kept.get("tag") }} />
  ```

`apps/web/app/(site)/clan/page.tsx`:

- After line 13 (`import { fieldError } from "@/lib/field-errors";`) add `import { readKept } from "@/lib/form";`.
- Lines 35–36 become:
  ```tsx
  export default async function ClanPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
    const q = await searchParams;
    const result = typeof q.result === "string" ? q.result : undefined;
    const kept = readKept(q);
  ```
- Line 111: inside the invite `GamertagField`, after `name="gamertag"`, add `defaultValue={kept.get("gamertag")}`.

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/rename-form.test.tsx test/submit-once.test.ts test/field-errors.test.ts` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/clan/settings/rename-form.tsx" "apps/web/app/(site)/clan/settings/page.tsx" "apps/web/app/(site)/clan/page.tsx" apps/web/app/api/clan/rename/route.ts apps/web/app/api/clan/invite/route.ts apps/web/app/api/clan/guest/route.ts apps/web/test/rename-form.test.tsx
git commit -m "$(cat <<'EOF'
fix(web): refused rename, invite and guest pass keep what was typed

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: H2 + M10 + M11 — vault forms: refusals keep input in place, the code field is never remembered

These three findings share one extraction: the Add and Edit forms move out of the page into `lock-forms.tsx`. They are one task so that the vault page is rewritten once.

**Files:**
- Create: `apps/web/app/(site)/clan/vault/lock-forms.tsx`
- Modify: `apps/web/lib/vault-form.ts` (append `MIN_ROLE_MAX`, `roleOr`)
- Modify: `apps/web/app/api/vault/add/route.ts` (whole file)
- Modify: `apps/web/app/api/vault/edit/route.ts` (whole file)
- Modify: `apps/web/app/(site)/clan/vault/page.tsx` (whole file)
- Test: `apps/web/test/vault-forms.test.tsx`

**Interfaces:**
- Consumes: `keepFrom`, `readKept`, `Redirect` (Task 5); `SubmitButton`, `ConfirmButton`, `Notice`.
- Produces:
  - `MIN_ROLE_MAX: number`
  - `roleOr(v: string | undefined, fallback: string): string`
  - `type KeptLock = { name?: string; note?: string; minRole?: string }`
  - `fold: string`
  - `Chevron()`
  - `VaultCodeField(props: { err: FieldError | null })`
  - `AddLockForm(props: { err: FieldError | null; kept: KeptLock; open: boolean })`
  - `LockEditor(props: { lock: { id: number; name: string; note: string | null; minRole: string }; open: boolean; error?: string; kept?: KeptLock })`

- [ ] **Step 1: Write the failing test** — `apps/web/test/vault-forms.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { AddLockForm, LockEditor, VaultCodeField } from "../app/(site)/clan/vault/lock-forms";
import { readKept } from "../lib/form";

const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", ...p), "utf8");
const input = (html: string, needle: string) => html.match(new RegExp(`<input[^>]*${needle}[^>]*/>`, "u"))?.[0] ?? "";
const LOCK = { id: 5, name: "Main gate", note: "north wall", minRole: "member" };

describe("the code field (M10)", () => {
  /** ⚠️ The page hides codes behind a tap so a stream never sees one; form history would offer it on focus. */
  it("⚠️ is never remembered by the browser or a password manager", () => {
    const tag = input(renderToStaticMarkup(<VaultCodeField err={null} />), 'name="code"');
    expect(tag).toContain('autocomplete="off"');
    expect(tag).toContain('data-1p-ignore="true"');
    expect(tag).toContain('data-lpignore="true"');
  });

  it("⚠️ carries no value, ever", () => {
    expect(input(renderToStaticMarkup(<VaultCodeField err={null} />), 'name="code"')).not.toMatch(/ value=/u);
  });
});

describe("a refused add keeps its input (H2)", () => {
  it("reopens with name, note and rank", () => {
    const html = renderToStaticMarkup(<AddLockForm err={null} open kept={{ name: "Gate & Co", note: "by the well", minRole: "officer" }} />);
    expect(html).toMatch(/<details[^>]*open=""/u);
    expect(input(html, 'name="name"')).toContain('value="Gate &amp; Co"');
    expect(input(html, 'name="note"')).toContain('value="by the well"');
    expect(html).toContain('<option value="officer" selected="">');
  });

  /** ⚠️ Review focus 3: a crafted ?kept.code= never reaches the page. */
  it("⚠️ a crafted kept.code never renders", () => {
    const k = readKept({ "kept.code": "1234", "kept.name": "Gate" });
    const html = renderToStaticMarkup(<AddLockForm err={null} open kept={{ name: k.get("name"), note: k.get("note"), minRole: k.get("minRole") }} />);
    expect(k.get("code")).toBeUndefined();
    expect(html).not.toContain("1234");
  });

  /** ⚠️ Review focus 3: the route never lists the code among what it keeps. */
  it("⚠️ the add route keeps name, note and rank — never the code", () => {
    const route = read("app", "api", "vault", "add", "route.ts");
    expect(route).toContain("keepFrom(form, { name: VAULT_NAME_MAX, note: VAULT_NOTE_MAX, minRole: MIN_ROLE_MAX })");
    expect(route).not.toMatch(/keepFrom\([^)]*code/u);
  });

  it("ignores a kept rank that is not a rank", () => {
    expect(renderToStaticMarkup(<AddLockForm err={null} open kept={{ minRole: "admin" }} />)).toContain('<option value="member" selected="">');
  });
});

describe("a refused edit opens its own lock (M11)", () => {
  it("opens that lock's editor with the sentence and the typed values inside it", () => {
    const html = renderToStaticMarkup(<LockEditor lock={LOCK} open error="A lock name is 1 to 40 characters." kept={{ name: "Back gate" }} />);
    expect(html).toMatch(/<details class="group border-t border-rule-2" open="">/u);
    expect(html).toContain("A lock name is 1 to 40 characters.");
    expect(input(html, 'name="name"')).toContain('value="Back gate"');
    expect(input(html, 'name="note"')).toContain('value="north wall"');
  });

  it("stays folded, with the lock's own values, otherwise", () => {
    const html = renderToStaticMarkup(<LockEditor lock={LOCK} open={false} />);
    expect(html).not.toContain('open=""');
    expect(input(html, 'name="name"')).toContain('value="Main gate"');
  });

  it("the edit route names its lock on every refusal", () => {
    expect(read("app", "api", "vault", "edit", "route.ts")).toContain("keep: { lock: String(lockId),");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/vault-forms.test.tsx`
Expected: FAIL — `Failed to resolve import "../app/(site)/clan/vault/lock-forms"`.

- [ ] **Step 3: Implement**

Append to `apps/web/lib/vault-form.ts`:

```ts
/** The longest `minRole` a refused form may send back — the longest rank name. */
export const MIN_ROLE_MAX = Math.max(...VAULT_ROLES.map((r) => r.length));

/** A kept rank, but only if it is one; anything else falls back. The query is attacker-suppliable. */
export function roleOr(v: string | undefined, fallback: string): string {
  return v !== undefined && (VAULT_ROLES as readonly string[]).includes(v) ? v : fallback;
}
```

`apps/web/app/(site)/clan/vault/lock-forms.tsx`:

```tsx
import { VAULT_CODE_DIGITS, VAULT_NAME_MAX, VAULT_NOTE_MAX } from "@factions/domain";
import type { FieldError as FieldErrorT } from "@/lib/field-errors";
import { VAULT_ROLES, roleOr } from "@/lib/vault-form";
import { ConfirmButton, FieldError, Notice, SubmitButton, invalid, btnDanger, btnPrimary, btnSecondary, field, fieldLabel } from "@/app/components/ui";

/** What a refused add or edit sent back (lib/form.ts readKept). ⚠️ Never a code: readKept cannot return one. */
export type KeptLock = { name?: string; note?: string; minRole?: string };

const CODE_PATTERN = `\\d{${VAULT_CODE_DIGITS}}`;
/** A fold's head: the mono caption with a chevron, 48px, full width. */
export const fold = "flex min-h-[48px] cursor-pointer list-none items-center justify-between gap-3 px-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink [&::-webkit-details-marker]:hidden";
export const Chevron = () => <><span aria-hidden="true" className="group-open:hidden">▾</span><span aria-hidden="true" className="hidden group-open:inline">▴</span></>;

/**
 * The one field a player types a vault code into.
 *
 * ⚠️ M10: autocomplete off, and the two password-manager opt-outs. The vault
 * hides codes behind a tap so a stream catches nothing; a browser that saved
 * this field would offer the last code in a dropdown the moment it takes
 * focus — on stream. It takes no value prop at all: nothing ever refills it.
 */
export function VaultCodeField({ err }: { err: FieldErrorT | null }) {
  return (
    <label className="block"><span className={fieldLabel}>Code</span>
      <input {...invalid(err, "code")} className={`${field} ${invalid(err, "code").className ?? ""}`} name="code" pattern={CODE_PATTERN} inputMode="numeric"
        title={`${VAULT_CODE_DIGITS} digits`} aria-describedby={err?.field === "code" ? "err-code code-note" : "code-note"}
        autoComplete="off" spellCheck={false} data-1p-ignore="true" data-lpignore="true" />
      <FieldError err={err} name="code" />
    </label>
  );
}

/** "+ Add lock". H2: a refused add reopens with name, note and rank as typed — never the code. */
export function AddLockForm({ err, kept, open }: { err: FieldErrorT | null; kept: KeptLock; open: boolean }) {
  return (
    <details className="group border-2 border-rule-2 bg-frame sm:col-span-2" open={open}>
      <summary className={`${fold} !text-ink`}>+ Add lock <Chevron /></summary>
      <form className="flex flex-col gap-3 border-t-2 border-rule-2 p-4 lg:p-5" action="/api/vault/add" method="post">
        <label className="block"><span className={fieldLabel}>Name</span><input {...invalid(err, "name")} className={`${field} ${invalid(err, "name").className ?? ""}`} name="name" defaultValue={kept.name} required maxLength={VAULT_NAME_MAX} /><FieldError err={err} name="name" /></label>
        <label className="block"><span className={fieldLabel}>Note</span><input {...invalid(err, "note")} className={`${field} ${invalid(err, "note").className ?? ""}`} name="note" defaultValue={kept.note} maxLength={VAULT_NOTE_MAX} /><FieldError err={err} name="note" /></label>
        <label className="block"><span className={fieldLabel}>Minimum rank</span>
          <select className={field} name="minRole" defaultValue={roleOr(kept.minRole, "member")} required>
            {VAULT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
        </label>
        <VaultCodeField err={err} />
        <p id="code-note" className="-mt-1 text-xs text-muted">{VAULT_CODE_DIGITS} digits. Leave it blank and one is generated.</p>
        <SubmitButton className={`${btnPrimary} self-start`}>Add lock</SubmitButton>
      </form>
    </details>
  );
}

/**
 * One lock's folded "Edit": rename / re-note / re-gate, Rotate, Delete.
 *
 * M11: a refused edit reopens THIS lock's fold with the sentence inside it
 * and the values as typed. Before, the refusal went to the notice at the top
 * of the page and the lock came back folded and reverted, so the officer had
 * to find which lock it was about and retype it.
 */
export function LockEditor({ lock, open, error, kept }: { lock: { id: number; name: string; note: string | null; minRole: string }; open: boolean; error?: string; kept?: KeptLock }) {
  return (
    <details className="group border-t border-rule-2" open={open}>
      <summary className={fold}>Edit <Chevron /></summary>
      <div className="flex flex-col gap-4 border-t-2 border-rule-2 bg-surface p-4 lg:p-5">
        {error && <Notice>{error}</Notice>}
        <form className="flex flex-col gap-3" action="/api/vault/edit" method="post">
          <input type="hidden" name="lockId" value={lock.id} />
          <label className="block"><span className={fieldLabel}>Name</span><input className={field} name="name" defaultValue={kept?.name ?? lock.name} required maxLength={VAULT_NAME_MAX} /></label>
          <label className="block"><span className={fieldLabel}>Note</span><input className={field} name="note" defaultValue={kept?.note ?? lock.note ?? ""} maxLength={VAULT_NOTE_MAX} /></label>
          <label className="block"><span className={fieldLabel}>Minimum rank</span>
            <select className={field} name="minRole" defaultValue={roleOr(kept?.minRole, lock.minRole)} required>
              {VAULT_ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
            </select>
          </label>
          <SubmitButton className={`${btnSecondary} self-start`}>Save</SubmitButton>
        </form>
        <div className="grid grid-cols-2 gap-2 border-t border-rule-2 pt-4">
          <form action="/api/vault/rotate" method="post" className="contents">
            <input type="hidden" name="lockId" value={lock.id} />
            <input type="hidden" name="confirm" value="yes" />
            <ConfirmButton confirm="Press again to rotate" className={`${btnSecondary} w-full`}>Rotate code</ConfirmButton>
          </form>
          <form action="/api/vault/delete" method="post" className="contents">
            <input type="hidden" name="lockId" value={lock.id} />
            <input type="hidden" name="confirm" value="yes" />
            <ConfirmButton confirm="Press again to delete" className={`${btnDanger} w-full`}>Delete</ConfirmButton>
          </form>
        </div>
        <p className="m-0 font-mono text-[11px] leading-relaxed text-muted">Rotate and Delete are two-press: the first tap arms, the second within 4 s does it. Rotating here does not change the lock in the game.</p>
      </div>
    </details>
  );
}
```

`apps/web/app/api/vault/add/route.ts` (whole file):

```ts
import type { NextRequest, NextResponse } from "next/server";
import { addLock, VAULT_NAME_MAX, VAULT_NOTE_MAX } from "@factions/roster";
import { VAULT_CODE_DIGITS } from "@factions/domain";
import { formAction, keepFrom, text, optionalText, type Redirect } from "@/lib/form";
import { MIN_ROLE_MAX, minRoleFrom } from "@/lib/vault-form";
import { vaultCode } from "@/lib/vault-copy";

const CODE_RE = new RegExp(`^\\d{${VAULT_CODE_DIGITS}}$`, "u");

/** POST from /clan/vault. Officer+; the code is caller-supplied or generated ("leave blank to generate"). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/vault", async (session, form) => {
    // H2: a refused add comes back with name, note and rank.
    // ⚠️ NEVER the code — it is not in this list and must never be added to it:
    // a kept value lands in the URL, and a code never may (lib/form.ts NEVER_KEEP
    // refuses it too, but this list is the first line).
    const keep = keepFrom(form, { name: VAULT_NAME_MAX, note: VAULT_NOTE_MAX, minRole: MIN_ROLE_MAX });
    const refuse = (c: string): Redirect => ({ back: "/clan/vault", code: c, keep });
    const name = text(form, "name", VAULT_NAME_MAX);
    if (!name) return refuse(vaultCode("add", "bad-name"));
    const note = optionalText(form, "note", VAULT_NOTE_MAX);
    if (note === "too-long") return refuse(vaultCode("add", "bad-note"));
    const minRole = minRoleFrom(form);
    if (!minRole) return refuse(vaultCode("input", "bad-input"));
    const rawCode = form.get("code");
    let code: string | undefined;
    if (typeof rawCode === "string" && rawCode.trim() !== "") {
      if (!CODE_RE.test(rawCode.trim())) return refuse(vaultCode("add", "bad-code"));
      code = rawCode.trim();
    }
    const { outcome } = await addLock(session.sub, { name, note, minRole, code });
    return outcome === "ok" ? vaultCode("add", outcome) : refuse(vaultCode("add", outcome));
  });
}
```

`apps/web/app/api/vault/edit/route.ts` (whole file):

```ts
import type { NextRequest, NextResponse } from "next/server";
import { editLock, VAULT_NAME_MAX, VAULT_NOTE_MAX } from "@factions/roster";
import { formAction, keepFrom, text, optionalText, id, type Redirect } from "@/lib/form";
import { MIN_ROLE_MAX, minRoleFrom } from "@/lib/vault-form";
import { vaultCode } from "@/lib/vault-copy";

/** POST from /clan/vault. Officer+; renames/re-describes/re-gates a lock. The code is untouched. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/vault", async (session, form) => {
    const lockId = id(form, "lockId");
    if (lockId === null) return vaultCode("input", "bad-input");
    // M11: every refusal names its lock, so the page reopens THAT lock's editor with the
    // sentence inside it; H2: with what was typed. The edit form has no code field.
    const refuse = (c: string): Redirect => ({
      back: "/clan/vault", code: c,
      keep: { lock: String(lockId), ...keepFrom(form, { name: VAULT_NAME_MAX, note: VAULT_NOTE_MAX, minRole: MIN_ROLE_MAX }) },
    });
    const name = text(form, "name", VAULT_NAME_MAX);
    if (!name) return refuse(vaultCode("edit", "bad-name"));
    const note = optionalText(form, "note", VAULT_NOTE_MAX);
    if (note === "too-long") return refuse(vaultCode("edit", "bad-note"));
    const minRole = minRoleFrom(form);
    if (!minRole) return refuse(vaultCode("input", "bad-input"));
    const outcome = await editLock(session.sub, { lockId, name, note, minRole });
    return outcome === "ok" ? vaultCode("edit", outcome) : refuse(vaultCode("edit", outcome));
  });
}
```

`apps/web/app/(site)/clan/vault/page.tsx` (whole file):

```tsx
import type { Metadata } from "next";
import { clanFor, vaultFor } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { REFUSAL } from "@/lib/clan-copy";
import { VAULT_INTRO, VAULT_RESULT_COPY } from "@/lib/vault-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { readKept } from "@/lib/form";
import { when, ago } from "@/lib/format";
import { RevealButton } from "./reveal-button";
import { AddLockForm, Chevron, LockEditor, fold } from "./lock-forms";
import { guideLinkFor } from "@/lib/guide-links";
import { fieldError } from "@/lib/field-errors";
import { OwnClanHero } from "@/app/components/own-clan-hero";
import { Page, PageHead, Body, PanelBody, Notice, BackLine, SessionLost, ConfirmButton, SubmitButton, btnSecondary, link } from "@/app/components/ui";

export const metadata: Metadata = { title: "Clan Wars — vault", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const badge = "border px-2 py-0.5 font-mono text-[11px] uppercase tracking-[0.14em]";
const num = (i: number) => String(i).padStart(2, "0");
const ID_RE = /^\d{1,12}$/u;

/**
 * The vault (App Review §02): every lock is a collapsed card — name, rank,
 * flags, Reveal in front — with the officer's edit form folded behind
 * "Edit". Rotate and Delete are two-press. Add lock and History fold too,
 * so five locks is one screen, not five.
 */
export default async function VaultPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const result = typeof q.result === "string" ? q.result : undefined;
  const session = await currentSession();
  if (!session) return <SessionLost next="/clan/vault" />;
  const notice = result ? lookupCopy(VAULT_RESULT_COPY, result) : undefined;
  // Only the Add form's refusals name a field; an edit's refusal is shown inside its own lock (M11).
  const err = fieldError(result, VAULT_RESULT_COPY);
  // ⚠️ readKept never returns `code` (lib/form.ts NEVER_KEEP): nothing on this page can refill one.
  const kept = readKept(q);
  const view = await vaultFor(session.sub);

  if (typeof view === "string") {
    return (
      <Page>
        <PageHead guide={guideLinkFor("/clan/vault")} kicker="Vault" title="No vault yet" />
        <Body className="flex max-w-[40rem] flex-col gap-4">
          {notice && <Notice>{notice}</Notice>}
          <p className="text-ink-2">{REFUSAL[view]} <a className={link} href="/clan">Your clan</a>.</p>
        </Body>
      </Page>
    );
  }

  const clan = await clanFor(session.sub);
  const officer = typeof clan !== "string" && clan.me.status === "full" && (clan.me.role === "officer" || clan.me.role === "leader");
  const { locks, history } = view;
  const keptLock = { name: kept.get("name"), note: kept.get("note"), minRole: kept.get("minRole") };
  // H2: the Add form stays open, with what was typed, after any refusal of an add.
  const addRefused = result !== undefined && result.startsWith("add.") && result !== "add.ok";
  const addOpen = err !== null || addRefused;
  // M11: an edit's refusal carries its lock id. That lock's editor opens with the sentence
  // inside it; a lock that has since gone (deleted by another officer) falls back to the top notice.
  const lockParam = kept.get("lock");
  const editRefused = result !== undefined && /^(edit|input)\./u.test(result) && lockParam !== undefined && ID_RE.test(lockParam);
  const editingId = editRefused && locks.some((l) => l.id === Number(lockParam)) ? Number(lockParam) : null;

  return (
    <Page wide>
      {typeof clan === "string"
        ? <PageHead guide={guideLinkFor("/clan/vault")} kicker="Vault" title={<>Your clan&rsquo;s vault</>} sub={VAULT_INTRO} />
        : <OwnClanHero view={clan} current="vault" guide={guideLinkFor("/clan/vault")} />}
      <Body className="flex max-w-[44rem] flex-col gap-3 lg:gap-4">
        <div>
          <h2 className="font-display text-sm uppercase tracking-[0.06em] text-ink">Your clan&rsquo;s vault</h2>
          <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{VAULT_INTRO}</p>
        </div>
        {notice && editingId === null && <Notice focus={err === null}>{notice}</Notice>}

        {locks.length === 0 && <p className="text-sm text-ink-2">No locks your rank can see yet.</p>}
        {locks.map((lock, i) => (
          <section key={lock.id} className="border-2 border-rule-2 bg-frame" aria-label={lock.name}>
            <div className="flex flex-wrap items-center gap-3 px-4 py-3 lg:px-5">
              <span className="font-mono text-[11px] text-gold">{num(i + 1)}</span>
              <h2 className="m-0 flex-1 font-display text-sm uppercase tracking-[0.06em] text-ink">{lock.name}</h2>
              <span className={`${badge} border-rule-2 text-ink-2`}>{lock.minRole}</span>
              {lock.changedInGame && <span className={`${badge} border-gold text-gold`}>changed in game?</span>}
              {lock.exposed && <span className={`${badge} border-rust text-rust-2`}>ex-member knows</span>}
            </div>
            {(lock.note || lock.rotatedAt || lock.createdAt) && (
              <p className="m-0 px-4 pb-3 text-[13px] leading-relaxed text-ink-2 lg:px-5">
                {lock.note && <>{lock.note} </>}
                <span className="text-muted">{lock.rotatedAt ? `rotated ${ago(lock.rotatedAt)} by ${lock.rotatedBy}` : `added ${ago(lock.createdAt)} by ${lock.createdBy}`}</span>
              </p>
            )}
            <div className="flex items-stretch border-t border-rule-2">
              <RevealButton lockId={lock.id} className="flex min-h-[48px] w-full items-center justify-center bg-gold font-display text-xs uppercase tracking-[0.06em] text-ground hover:bg-gold-hover disabled:opacity-40" />
              {lock.changedInGame && (
                <form action="/api/vault/confirm" method="post" className="flex flex-none border-l border-rule-2">
                  <input type="hidden" name="lockId" value={lock.id} />
                  <SubmitButton className="flex min-h-[48px] items-center px-4 font-mono text-[11px] uppercase tracking-[0.18em] text-gold hover:text-ink">Confirm changed</SubmitButton>
                </form>
              )}
            </div>
            {officer && (
              <LockEditor lock={lock} open={editingId === lock.id}
                error={editingId === lock.id ? notice : undefined} kept={editingId === lock.id ? keptLock : undefined} />
            )}
          </section>
        ))}

        {officer && (
          <div className="grid gap-2 sm:grid-cols-2">
            <AddLockForm err={err} kept={addRefused ? keptLock : {}} open={addOpen} />
            <form action="/api/vault/rotate" method="post" className="sm:col-span-2">
              <input type="hidden" name="all" value="yes" />
              <input type="hidden" name="confirm" value="yes" />
              <ConfirmButton confirm="Press again to rotate all" className={`${btnSecondary} w-full`}>Rotate all</ConfirmButton>
            </form>
          </div>
        )}

        {history !== null && (
          <details className="group border-2 border-rule-2 bg-frame">
            <summary className={`${fold} !text-ink`}>History <span className="ml-auto font-mono text-[11px] normal-case tracking-[0.18em] text-muted">{history.length} {history.length === 1 ? "entry" : "entries"}</span> <Chevron /></summary>
            {history.length === 0 ? <PanelBody className="border-t-2 border-rule-2"><p className="text-sm text-ink-2">Nothing yet.</p></PanelBody> : (
              <div className="overflow-x-auto border-t-2 border-rule-2">
                <table className="w-full text-left text-sm text-ink">
                  <thead><tr className="font-mono text-xs uppercase tracking-[0.18em] text-muted"><th className="px-4 py-3 font-normal lg:px-5">When</th><th className="py-3 pr-3 font-normal">Who</th><th className="py-3 pr-3 font-normal">Action</th><th className="py-3 pr-4 font-normal">Lock</th></tr></thead>
                  <tbody>
                    {history.map((h, i) => (
                      <tr key={i} className="border-t border-rule-2">
                        <td className="px-4 py-2.5 lg:px-5">{when(h.at)}</td>
                        <td className="py-2.5 pr-3">{h.by ?? "a member"}</td>
                        <td className="py-2.5 pr-3">{h.action}</td>
                        <td className="py-2.5 pr-4">{h.lockName}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </details>
        )}

        <BackLine href="/clan">Your clan</BackLine>
      </Body>
    </Page>
  );
}
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/vault-forms.test.tsx test/vault-copy.test.ts test/confirm-button.test.tsx test/submit-once.test.ts test/api-routes.test.ts` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/clan/vault/lock-forms.tsx" "apps/web/app/(site)/clan/vault/page.tsx" apps/web/lib/vault-form.ts apps/web/app/api/vault/add/route.ts apps/web/app/api/vault/edit/route.ts apps/web/test/vault-forms.test.tsx
git commit -m "$(cat <<'EOF'
fix(web): vault refusals keep input in place; the code field is never remembered

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: H4 + L1 + L3 — the ban-confirm keeps keyboard focus and speaks through one live region

**Files:**
- Create: `apps/web/lib/report-focus.ts`
- Modify: `apps/web/app/(site)/base/report-button.tsx` (whole file)
- Test: `apps/web/test/report-button.test.tsx` (new; `test/base-report.test.ts` must keep passing unchanged)

**Interfaces:**
- Produces:
  - `type ReportPhase = "idle" | "armed" | "done"`
  - `type ReportFocus = "confirm" | "press" | "status" | null`
  - `reportFocusAfter(prev: ReportPhase, next: ReportPhase): ReportFocus`
- `ReportButton` props unchanged: `{ incidentId: number; participants: ReportParticipant[]; minTermLabel: string }`.

- [ ] **Step 1: Write the failing test** — `apps/web/test/report-button.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { reportFocusAfter } from "../lib/report-focus";
import { ReportButton } from "../app/(site)/base/report-button";

const PARTS = [{ dayzId: "a", gamertag: "Ada" }, { dayzId: "b", gamertag: "Bo" }];

describe("reportFocusAfter (H4)", () => {
  it("moves focus to Confirm when the button arms — the pressed button has just unmounted", () => expect(reportFocusAfter("idle", "armed")).toBe("confirm"));
  it("returns focus to Press charges on Cancel or timeout", () => expect(reportFocusAfter("armed", "idle")).toBe("press"));
  it("moves focus to the result when charges are pressed", () => expect(reportFocusAfter("armed", "done")).toBe("status"));
  it("does nothing on first render or without a change", () => {
    expect(reportFocusAfter("idle", "idle")).toBeNull();
    expect(reportFocusAfter("armed", "armed")).toBeNull();
  });
});

describe("the report button", () => {
  const html = renderToStaticMarkup(<ReportButton incidentId={1} participants={PARTS} minTermLabel="3 days" />);

  /** H4: a live region inserted with its content is announced unreliably; this one is there from the start. */
  it("renders its live region before anything happens", () => expect(html).toContain('role="status"'));

  it("L3: charge boxes are the site's checkbox, on 44px rows", () => {
    expect(html).toContain("h-5 w-5");
    expect(html.match(/min-h-\[44px\] items-center gap-3/gu) ?? []).toHaveLength(2);
  });

  it("L1: nothing on it is rust text — a refusal is not an obligation", () => expect(html).not.toContain("text-rust-2"));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/report-button.test.tsx`
Expected: FAIL — `Failed to resolve import "../lib/report-focus"`.

- [ ] **Step 3: Implement**

`apps/web/lib/report-focus.ts`:

```ts
export type ReportPhase = "idle" | "armed" | "done";
export type ReportFocus = "confirm" | "press" | "status" | null;

/**
 * Where keyboard focus goes when the report button changes branch (H4).
 *
 * ⚠️ Each branch REPLACES the one before, so the button that was just pressed
 * unmounts and focus falls to <body>. A keyboard user then has 8 s to find
 * "Confirm — press charges" from the top of the page. Every transition
 * names where focus goes instead.
 */
export function reportFocusAfter(prev: ReportPhase, next: ReportPhase): ReportFocus {
  if (prev === next) return null;
  if (next === "armed") return "confirm";
  if (next === "done") return "status";
  return prev === "armed" ? "press" : null;
}
```

`apps/web/app/(site)/base/report-button.tsx` (whole file):

```tsx
"use client";

import { useEffect, useId, useRef, useState } from "react";
import { btnDanger, btnQuiet, checkbox } from "@/app/components/ui";
import { reportFocusAfter, type ReportPhase } from "@/lib/report-focus";

const ARM_MS = 8_000;

export type ReportParticipant = { dayzId: string; gamertag: string };

/**
 * Presses charges on a CHOSEN SUBSET of one witnessed incident's
 * participants. ⚠️ Deliberately free of any roster-package import — `next
 * build` is the only thing that catches a client component pulling that
 * package's pooled postgres client into the browser bundle ("Can't resolve
 * 'fs'"), which no typecheck or vitest run catches (broke a deploy on
 * 2026-09-13). Everything this component needs is a prop.
 *
 * This is a real safety control, not decoration: a bare click on
 * `reportIncident` bans every CHECKED player with no staff adjudicator in
 * the loop. The first press only arms the button and states, in words,
 * exactly who gets banned and for how long at minimum; nothing is sent to
 * the server until the second press, within `ARM_MS`. Per-participant
 * checkboxes exist so an owner can charge a raider without also banning a
 * helper they invited — both would otherwise be sentenced jointly on the
 * whole incident's damage (spec §2.4, §7).
 *
 * ⚠️ H4 (UX review 2026-09-24): focus is moved on every branch change
 * (lib/report-focus.ts), and the outcome is spoken by ONE live region that is
 * mounted from the first render. A region inserted together with its text is
 * announced unreliably, and this outcome is a ban.
 */
export function ReportButton({ incidentId, participants, minTermLabel }: { incidentId: number; participants: ReportParticipant[]; minTermLabel: string }) {
  // ⚠️ Defaults to everyone selected — the common case (a raid with no
  // invited helper) should not require checking every box, and the confirm
  // step still names exactly who before anything is sent.
  const [checked, setChecked] = useState<Set<string>>(() => new Set(participants.map((p) => p.dayzId)));
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pressRef = useRef<HTMLButtonElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const statusRef = useRef<HTMLParagraphElement>(null);
  const warningId = useId();
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const phase: ReportPhase = done ? "done" : armed ? "armed" : "idle";
  const shown = useRef<ReportPhase>(phase);
  useEffect(() => {
    const target = reportFocusAfter(shown.current, phase);
    shown.current = phase;
    if (target === "confirm") confirmRef.current?.focus();
    else if (target === "press") pressRef.current?.focus();
    else if (target === "status") statusRef.current?.focus();
  }, [phase]);

  const stopTimer = () => { if (timer.current) clearTimeout(timer.current); timer.current = null; };
  const disarm = () => { stopTimer(); setArmed(false); };
  const arm = () => {
    setError(null);
    setArmed(true);
    stopTimer();
    timer.current = setTimeout(() => setArmed(false), ARM_MS);
  };

  const toggle = (dayzId: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(dayzId)) next.delete(dayzId); else next.add(dayzId);
      return next;
    });
  };

  const submit = async () => {
    if (busy) return;
    // ⚠️ The countdown stops but the armed block STAYS while the request runs:
    // dropping it here unmounted the focused Confirm mid-request and hid "Pressing charges…".
    stopTimer();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/base/report", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ incidentId, chargedDayzIds: [...checked] }),
      });
      if (res.status === 401) { window.location.reload(); return; }
      const data = (await res.json().catch(() => null)) as { ok?: boolean; message?: string } | null;
      if (!data?.ok) { setError(data?.message ?? "Could not press charges on that incident."); setArmed(false); return; }
      setDone(true);
    } catch {
      setError("Could not press charges on that incident.");
      setArmed(false);
    } finally {
      setBusy(false);
    }
  };

  const chargedNames = participants.filter((p) => checked.has(p.dayzId)).map((p) => p.gamertag).join(", ");

  const body = (() => {
    if (done) return null;
    if (armed) {
      return (
        <div className="flex flex-col gap-3">
          <p id={warningId} className="text-sm leading-relaxed text-ink-2">
            This automatically bans <span className="text-ink">{chargedNames || "nobody — pick at least one player"}</span> for at least <span className="text-ink">{minTermLabel}</span> each — doubled on a repeat offence, and <span className="text-ink">permanent</span> on a third upheld report this season. Prior offences are checked when you confirm, so a permanent ban can happen on THIS click without further warning. There is no further review after you confirm.
          </p>
          <div className="flex flex-wrap gap-3">
            {/* ⚠️ aria-disabled while busy, not disabled: a disabled button drops focus to <body>. */}
            <button ref={confirmRef} type="button" className={`${btnDanger} aria-disabled:opacity-40`} aria-describedby={warningId}
              aria-disabled={busy || undefined} disabled={checked.size === 0} onClick={() => void submit()}>
              {busy ? "Pressing charges…" : "Confirm — press charges"}
            </button>
            <button type="button" className={`${btnQuiet} aria-disabled:opacity-40`} aria-disabled={busy || undefined} onClick={() => { if (!busy) disarm(); }}>Cancel</button>
          </div>
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-2">
        {participants.length > 1 && (
          <fieldset className="flex flex-col">
            <legend className="text-xs uppercase tracking-[0.14em] text-muted">Charge</legend>
            {participants.map((p) => (
              <label key={p.dayzId} className="flex min-h-[44px] items-center gap-3 text-sm text-ink-2">
                <input type="checkbox" className={checkbox} checked={checked.has(p.dayzId)} onChange={() => toggle(p.dayzId)} />
                {p.gamertag}
              </label>
            ))}
          </fieldset>
        )}
        <button ref={pressRef} type="button" className={btnDanger} disabled={checked.size === 0} onClick={arm}>
          Press charges
        </button>
      </div>
    );
  })();

  return (
    <div className="flex flex-col gap-2">
      {body}
      {/* ⚠️ One live region, mounted on every branch from the first render (H4). L1: a failure is plain ink on the control edge, never rust. */}
      <p ref={statusRef} role="status" tabIndex={-1} className="text-sm focus:outline-none">
        {done
          ? <span className="text-ink-2">Charges pressed. The listed players are banned.</span>
          : error && <span className="block border border-rule-3 bg-surface px-3 py-2 text-ink">{error}</span>}
      </p>
    </div>
  );
}
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/report-button.test.tsx test/base-report.test.ts` — all pass. `base-report.test.ts`'s "requires a second press" still finds `setArmed(true);`, and still finds `void submit()` after `if (armed)`.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/report-focus.ts "apps/web/app/(site)/base/report-button.tsx" apps/web/test/report-button.test.tsx
git commit -m "$(cat <<'EOF'
fix(web): pressing charges keeps keyboard focus and announces the result once

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: H5 + M1 — /link resolves a typed gamertag with a fresh search, and survives a bad answer

**Files:**
- Create: `apps/web/lib/link-claim.ts`
- Modify: `apps/web/lib/link-copy.ts` (append two constants)
- Modify: `apps/web/app/(site)/link/link-flow.tsx` (whole file)
- Test: `apps/web/test/link-claim.test.ts`

**Interfaces:**
- Produces:
  - `type Match = { dayzId: string; gamertag: string }`
  - `type Resolved = { kind: "found"; dayzId: string } | { kind: "unseen" } | { kind: "failed" }`
  - `resolveTyped(typed: string, shown: { q: string; matches: Match[] }, search: (q: string) => Promise<Match[] | null>): Promise<Resolved>`
  - `readJson<T>(res: Response | null): Promise<T | null>`
  - `LINK_UNSEEN: string`
  - `LINK_FAILED: string`

- [ ] **Step 1: Write the failing test** — `apps/web/test/link-claim.test.ts`

```ts
import { describe, it, expect, vi } from "vitest";
import { readJson, resolveTyped, type Match } from "../lib/link-claim";

const RONALD: Match = { dayzId: "dz-1", gamertag: "RonaldRaygun552" };

describe("resolveTyped (H5)", () => {
  it("answers from the list on screen when it was fetched for exactly what is typed", async () => {
    const search = vi.fn();
    expect(await resolveTyped("ronaldraygun552 ", { q: "ronaldraygun552", matches: [RONALD] }, search)).toEqual({ kind: "found", dayzId: "dz-1" });
    expect(search).not.toHaveBeenCalled();
  });

  /** ⚠️ The race: the whole gamertag typed, "Claim it" tapped, before the 200 ms debounce fetched. */
  it("⚠️ searches again when the list on screen is for older text", async () => {
    const search = vi.fn(async () => [RONALD]);
    expect(await resolveTyped("RonaldRaygun552", { q: "Ronald", matches: [] }, search)).toEqual({ kind: "found", dayzId: "dz-1" });
    expect(search).toHaveBeenCalledWith("RonaldRaygun552");
  });

  it("is unseen only when a search for exactly this text has no exact match", async () => {
    expect(await resolveTyped("Nobody", { q: "", matches: [] }, async () => [RONALD])).toEqual({ kind: "unseen" });
  });

  it("is a failure, not a denial, when the search itself fails", async () => {
    expect(await resolveTyped("RonaldRaygun552", { q: "", matches: [] }, async () => null)).toEqual({ kind: "failed" });
  });
});

describe("readJson (M1)", () => {
  it("returns the body of a JSON 200", async () => {
    expect(await readJson<{ a: number }>(new Response(JSON.stringify({ a: 1 }), { status: 200 }))).toEqual({ a: 1 });
  });
  it("is null for no response, a 500, and an HTML 200 (a lapsed session's login page)", async () => {
    expect(await readJson(null)).toBeNull();
    expect(await readJson(new Response("oops", { status: 500 }))).toBeNull();
    expect(await readJson(new Response("<!doctype html><title>Sign in</title>", { status: 200 }))).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/link-claim.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/link-claim"`.

- [ ] **Step 3: Implement**

`apps/web/lib/link-claim.ts`:

```ts
export type Match = { dayzId: string; gamertag: string };
export type Resolved = { kind: "found"; dayzId: string } | { kind: "unseen" } | { kind: "failed" };

/**
 * Which character the typed gamertag names (H5, UX review 2026-09-24).
 *
 * ⚠️ The list on screen answers only for the text it was fetched for. It is
 * refreshed 200 ms after each keystroke, so a player who types a whole
 * gamertag and taps "Claim it" at once used to be told "the server has not
 * seen that character" about a character it had seen. When the list is for
 * older text, this searches for the exact text first and decides on that.
 * A failed search is `failed`, never `unseen`: an outage is not a verdict.
 */
export async function resolveTyped(typed: string, shown: { q: string; matches: Match[] }, search: (q: string) => Promise<Match[] | null>): Promise<Resolved> {
  const q = typed.trim();
  const pick = (list: Match[]): Resolved => {
    const found = list.find((m) => m.gamertag.toLowerCase() === q.toLowerCase());
    return found ? { kind: "found", dayzId: found.dayzId } : { kind: "unseen" };
  };
  if (shown.q.trim() === q) return pick(shown.matches);
  const fresh = await search(q);
  return fresh === null ? { kind: "failed" } : pick(fresh);
}

/**
 * A JSON answer, or null when there is none to read (M1).
 *
 * ⚠️ Null for a dead fetch, a non-2xx, and a 200 that is not JSON. A lapsed
 * session follows the middleware's redirect to the login page's HTML with a
 * 200, so parsing — not the status — is what fails, and a bare `res.json()`
 * threw out of the handler and left the player looking at nothing.
 */
export async function readJson<T>(res: Response | null): Promise<T | null> {
  if (!res || !res.ok) return null;
  try { return (await res.json()) as T; } catch { return null; }
}
```

Append to `apps/web/lib/link-copy.ts`:

```ts
/** Said only after a search for exactly the typed text agrees (lib/link-claim.ts resolveTyped). */
export const LINK_UNSEEN = "The server has not seen that character. Pick one from the list — only characters the event log has seen can be linked.";
/** A request that did not go through at all. Never a verdict on the character: nothing was decided. */
export const LINK_FAILED = "That did not go through, so nothing changed. Check your connection and try again.";
```

`apps/web/app/(site)/link/link-flow.tsx` (whole file):

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { LINK_EMOTES } from "@factions/domain";
import type { IssueOutcome, LinkStatus } from "@factions/roster";
import { ENDED_COPY, ISSUE_COPY, LINK_FAILED, LINK_UNSEEN, formatRemaining } from "@/lib/link-copy";
import { readJson, resolveTyped, type Match } from "@/lib/link-claim";
import { when } from "@/lib/format";
import { btnCta, btnPrimary, btnQuiet, field } from "@/app/components/ui";

/** `LinkStatus` after a trip through JSON: every Date is an ISO string. */
type Wire<T> = T extends Date ? string : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;
type Status = Wire<LinkStatus>;
type Outcome = Wire<IssueOutcome>;

const POLL_MS = 5_000;

const spread = "grid gap-6 px-5 py-6 lg:grid-cols-2 lg:gap-16 lg:px-8 lg:py-14";
const step = "font-mono text-[11px] uppercase tracking-[0.18em] text-muted";
const h1 = "mt-3 font-display text-[40px] uppercase leading-[.9] tracking-[-0.02em] text-ink lg:mt-4 lg:text-[64px]";
const body = "mt-4 max-w-[480px] text-[15px] leading-relaxed text-ink-2 [text-wrap:pretty] lg:mt-6 lg:text-[17px]";
const card = "border-2 border-rule-2 bg-frame p-5 lg:self-start";
const label = step;
const button = `w-full ${btnCta}`;
const quiet = btnQuiet;

export function LinkFlow({ initial }: { initial: Status }) {
  const [status, setStatus] = useState<Status>(initial);
  const [notice, setNotice] = useState<string | null>(initial.ended ? ENDED_COPY[initial.ended] : null);
  const [busy, setBusy] = useState(false);

  // ⚠️ M1: every answer on this page is read through readJson (lib/link-claim.ts).
  // A 500, a dead connection or a lapsed session's HTML used to throw out of
  // these handlers, and the player saw nothing happen at all.
  const refresh = async () => {
    const res = await fetch("/api/link/status", { cache: "no-store" }).catch(() => null);
    if (res?.status === 401) { window.location.assign("/login?next=/link"); return; }
    const next = await readJson<Status>(res);
    if (!next) return;
    setStatus((prev) => {
      // A challenge that vanished between polls ended without us: say why.
      if (prev.challenge && !next.challenge && !next.link && next.ended) setNotice(ENDED_COPY[next.ended]);
      return next;
    });
  };

  // ⚠️ Poll only while a challenge is open. Emotes reach the database in the
  // bot's tick batches, so a confirmation lands seconds to a minute behind
  // the emote; five seconds is often enough to feel live without hammering.
  useEffect(() => {
    if (!status.challenge) return;
    const id = setInterval(() => { void refresh(); }, POLL_MS);
    return () => clearInterval(id);
  }, [status.challenge?.id]);

  const start = async (dayzId: string, newSequence = false) => {
    setBusy(true);
    try {
      const res = await fetch("/api/link/start", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dayzId, newSequence }) }).catch(() => null);
      if (res?.status === 401) { window.location.assign("/login?next=/link"); return; }
      const data = await readJson<{ outcome: Outcome }>(res);
      if (!data) { setNotice(LINK_FAILED); return; }
      const { outcome } = data;
      if (outcome.kind === "issued" || outcome.kind === "live") {
        setNotice(outcome.kind === "issued" && outcome.switchedFrom
          ? `Canceled your challenge for ${outcome.switchedFrom} — that sequence no longer works. Here is the new one.`
          : null);
        await refresh();
      } else {
        const endsWhen = outcome.kind === "held-by-other" ? when(new Date(outcome.expiresAt)) : undefined;
        setNotice(ISSUE_COPY[outcome.kind](outcome as unknown as IssueOutcome, endsWhen));
      }
    } finally { setBusy(false); }
  };

  const cancel = async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/link/cancel", { method: "POST" }).catch(() => null);
      if (res?.status === 401) { window.location.assign("/login?next=/link"); return; }
      // ⚠️ M1: a cancel the server did not take must not read as done — the old sequence still works.
      if (!res?.ok) { setNotice(LINK_FAILED); return; }
      setNotice(null);
      await refresh();
    } finally { setBusy(false); }
  };

  if (status.link) return <Verified gamertag={status.link.gamertag} verifiedAt={status.link.verifiedAt} />;
  if (status.challenge) {
    return <ProveIt challenge={status.challenge} notice={notice} busy={busy}
      onDraw={() => start(currentTarget(status), true)} onCancel={cancel} />;
  }
  return <ChooseCharacter notice={notice} busy={busy} onClaim={(dayzId) => start(dayzId)} />;
}

/** The open challenge's target, for the re-roll. Read from status so the client never guesses a UID. */
function currentTarget(status: Status): string {
  return status.challenge?.targetDayzId ?? "";
}

function ChooseCharacter({ notice, busy, onClaim }: { notice: string | null; busy: boolean; onClaim: (dayzId: string) => void }) {
  const [query, setQuery] = useState("");
  /** The list on screen AND the text it was fetched for — without `q`, a stale list reads as a verdict (H5). */
  const [shown, setShown] = useState<{ q: string; matches: Match[] }>({ q: "", matches: [] });
  const [denial, setDenial] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const matches = shown.matches;

  const search = async (q: string): Promise<Match[] | null> => {
    const res = await fetch(`/api/link/search?q=${encodeURIComponent(q)}`, { cache: "no-store" }).catch(() => null);
    return (await readJson<{ matches: Match[] }>(res))?.matches ?? null;
  };

  useEffect(() => {
    if (timer.current) clearTimeout(timer.current);
    const q = query.trim();
    if (!q) { setShown({ q: "", matches: [] }); return; }
    timer.current = setTimeout(async () => {
      const found = await search(q);
      if (found) setShown({ q, matches: found });
    }, 200);
    return () => { if (timer.current) clearTimeout(timer.current); };
  }, [query]);

  /**
   * ⚠️ Resolved from the typed text on submit, not from whatever row was last
   * clicked — autocomplete is a suggestion, and the package re-validates the
   * UID anyway. A full gamertag typed without touching the list still works,
   * because resolveTyped searches again when the list is for older text (H5).
   */
  const claim = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy || checking || !query.trim()) return;
    setChecking(true);
    try {
      const r = await resolveTyped(query, shown, search);
      if (r.kind === "found") { setDenial(null); onClaim(r.dayzId); }
      else setDenial(r.kind === "unseen" ? LINK_UNSEEN : LINK_FAILED);
    } finally { setChecking(false); }
  };

  return (
    <div className={spread}>
      <div>
        <div className={step}>Step 2 of 3 — name your character</div>
        <h1 className={h1}>Which one is you?</h1>
        <p className={body}>The gamertag you play under. Only characters the server has actually seen are listed — if yours is missing, play a session first.</p>
        <p className="mt-4 hidden font-mono text-[11px] leading-relaxed text-muted lg:block">One character per Discord account. You will prove it is you with {LINK_EMOTES} emotes in game.</p>
      </div>
      {/* ⚠️ H5: a real form, so Enter in the box claims — it did nothing when the input sat outside one. */}
      <form className={card} onSubmit={(e) => { void claim(e); }}>
        {(notice || denial) && <Refusal label="Not issued">{denial ?? notice}</Refusal>}
        <input className={field.replace("mt-1", "")} value={query}
          onChange={(e) => { setQuery(e.target.value); setDenial(null); }} placeholder="Gamertag" aria-label="Gamertag" autoComplete="off" spellCheck={false} />
        {/* Plain buttons in a list, not a listbox: a listbox's options cannot be focusable buttons, and Tab-then-Enter is what a keyboard user will do here. */}
        <p role="status" className="sr-only">{query.trim() ? `${matches.length} ${matches.length === 1 ? "character" : "characters"} found` : ""}</p>
        {query.trim() && matches.length === 0 && <p className="mt-2 px-2 py-2 font-mono text-xs text-muted">No unclaimed character by that name</p>}
        {matches.length > 0 && (
          <ul className="mt-2 flex flex-col gap-1" aria-label="Characters the server has seen">
            {matches.map((m) => {
              const picked = m.gamertag.toLowerCase() === query.trim().toLowerCase();
              return (
                <li key={m.dayzId}>
                  <button type="button" aria-pressed={picked}
                    className={`flex min-h-[44px] w-full items-center px-3 text-left font-mono text-ink hover:bg-surface ${picked ? "bg-surface" : ""}`} onClick={() => setQuery(m.gamertag)}>
                    {m.gamertag}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {/* ⚠️ aria-disabled while checking, not disabled: a disabled button drops the focus it was just pressed with. */}
        <button className={`mt-5 ${button} aria-disabled:opacity-40`} type="submit" disabled={busy || !query.trim()} aria-disabled={checking || undefined} aria-busy={checking || undefined}>
          {checking ? "Checking…" : <>Claim it <span className="font-mono normal-case">→</span></>}
        </button>
        <div className="mt-4 font-mono text-[11px] leading-relaxed text-muted lg:hidden">One character per Discord account. You will prove it is you with {LINK_EMOTES} emotes in game.</div>
      </form>
    </div>
  );
}

function ProveIt({ challenge, notice, busy, onDraw, onCancel }: {
  challenge: NonNullable<Status["challenge"]>; notice: string | null; busy: boolean; onDraw: () => void; onCancel: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);
  const remaining = new Date(challenge.expiresAt).getTime() - now;
  const total = challenge.steps.length;

  const draws = challenge.drawsLeft > 0
    ? `Can’t find one of these on the wheel? Draw a new sequence — ${challenge.drawsLeft} ${challenge.drawsLeft === 1 ? "draw" : "draws"} left today.`
    : "Out of draws for this character today. If an emote is missing from your wheel, say so in the Discord rather than working around it.";

  return (
    <div className={spread}>
      <div>
        <div className={step}>Step 3 of 3 — one step left</div>
        <h1 className={h1}>Prove it&rsquo;s you.</h1>
        <div className="mt-3 font-mono text-lg text-gold lg:mt-4 lg:text-xl">{challenge.gamertag}</div>
        <p className={body}>In game as that character, open the emote wheel and perform these {total}, in this order. Other emotes in between are fine — the order is what counts.</p>
        <dl className="mt-6 hidden max-w-[480px] grid-cols-[auto_1fr] gap-x-5 gap-y-2 text-sm leading-relaxed text-ink-2 lg:grid">
          <dt className={`${step} pt-1`}>Timing</dt><dd className="m-0">Emotes reach us from the server log in batches, so a confirmation can take up to a minute to appear. This page checks every few seconds.</dd>
          <dt className={`${step} pt-1`}>Log off</dt><dd className="m-0">Perform all {LINK_EMOTES} and you can log off — the link catches up on its own.</dd>
        </dl>
      </div>
      {/* Rust: an obligation the player still owes the server (frontend rebuild §4). */}
      <div className="border-2 border-rust bg-frame lg:self-start">
        <div className="flex items-center justify-between gap-4 border-b-2 border-rust px-4 py-3 lg:px-5">
          <h2 className="m-0 font-display text-[13px] uppercase tracking-[0.06em] text-ink lg:text-sm"><span className="mr-3 text-rust-2">●</span>Challenge open</h2>
          <span className="font-mono text-[11px] text-muted"><span className="hidden lg:inline">Expires in </span>{formatRemaining(remaining)}</span>
        </div>
        {notice && <div className="px-4 pt-4 lg:px-5"><Refusal label="Note" neutral>{notice}</Refusal></div>}
        {/* ⚠️ An ordered list, because the order IS the proof. */}
        <ol className="flex flex-col gap-2 p-4 lg:gap-2.5 lg:p-5">
          {challenge.steps.map((s, i) => (
            <li key={s.token} className={`flex min-h-[56px] items-center gap-4 border-2 px-4 lg:min-h-[60px] ${s.confirmed ? "border-olive bg-surface" : "border-rule-2"}`}>
              <span className={`font-display text-xl lg:text-[22px] ${s.confirmed ? "text-olive" : "text-dim"}`}>{i + 1}</span>
              <span className={`font-display text-lg lg:text-xl ${s.confirmed ? "text-olive line-through" : "text-ink"}`}>{s.label}</span>
              <span className={`ml-auto font-mono text-[11px] uppercase tracking-[0.18em] ${s.confirmed ? "text-olive" : "text-muted"}`}>{s.confirmed ? "Confirmed" : "Waiting"}</span>
            </li>
          ))}
        </ol>
        {/* ⚠️ A SIBLING of the list, never an attribute on it: aria-live on the <ol> strips list semantics in several screen readers. */}
        <p role="status" aria-live="polite" className="sr-only">{challenge.confirmed} of {total} confirmed</p>
        <div className="mx-4 border border-rule-2 bg-surface px-3.5 py-3 text-sm leading-relaxed text-ink-2 lg:mx-5">
          <strong className="text-ink">The server has confirmed {challenge.confirmed} of {total}.</strong>{" "}
          <span className="lg:hidden">A confirmation can take up to a minute. Perform all {LINK_EMOTES} and you can log off.</span>
          <span className="hidden lg:inline">Emotes reach us from the server log in batches, so a confirmation can take up to a minute to appear. This page checks every few seconds; perform all {LINK_EMOTES} and you can log off — the link catches up on its own.</span>
        </div>
        <div className="mt-4 flex items-center justify-between gap-4 border-t border-rule-2 px-4 py-3.5 lg:px-5 lg:py-4">
          <span className="font-mono text-[11px] leading-relaxed text-muted">{draws}</span>
          <span className="flex flex-none gap-4 lg:gap-5">
            <button type="button" className={quiet} onClick={onDraw} disabled={busy || challenge.drawsLeft === 0}>New sequence</button>
            <button type="button" className={quiet} onClick={onCancel} disabled={busy}>Cancel</button>
          </span>
        </div>
      </div>
    </div>
  );
}

function Verified({ gamertag, verifiedAt }: { gamertag: string; verifiedAt: string }) {
  return (
    <div className={spread}>
      <div>
        <div className={step}>Linked</div>
        <h1 className={h1}>You are {gamertag}</h1>
        <p className={body}>Linked on {new Date(verifiedAt).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" })}. Your clan, your base and your map hang off this.</p>
      </div>
      <div className={card}>
        <a className={button} href="/base">Your base <span className="font-mono normal-case">→</span></a>
        <a className={`mt-3 ${btnPrimary.replace("bg-gold", "border-2 border-rule-2 bg-transparent").replace("text-ground", "text-ink")} w-full`} href="/me">Your page</a>
      </div>
    </div>
  );
}

function Refusal({ label: title, neutral = false, children }: { label: string; neutral?: boolean; children: React.ReactNode }) {
  return (
    <div className={`mb-4 border px-3.5 py-3 ${neutral ? "border-rule-2 bg-surface" : "border-rust bg-surface"}`} role={neutral ? "status" : "alert"}>
      <div className={label}>{title}</div>
      <div className="mt-1 text-sm leading-relaxed text-ink">{children}</div>
    </div>
  );
}
```

`Verified`, `Refusal`, the step-3 label and the countdown keep their old markup here on purpose. Task 11 changes them.

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/link-claim.test.ts test/link-copy.test.ts` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/link-claim.ts apps/web/lib/link-copy.ts "apps/web/app/(site)/link/link-flow.tsx" apps/web/test/link-claim.test.ts
git commit -m "$(cat <<'EOF'
fix(web): /link checks a typed gamertag with a fresh search and survives a bad answer

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 11: M2 + L1 + L5 + L6 — /link's buttons, refusal colour, step numbers and countdown

**Files:**
- Modify: `apps/web/app/(site)/link/link-flow.tsx`, at these post-Task-10 lines:
  - the `ui` import
  - ProveIt's step label, bullet and countdown
  - `Verified`'s second anchor
  - `Refusal`'s class
- Modify: `apps/web/app/(site)/login/page.tsx:31`
- Modify: `apps/web/app/(site)/join/page.tsx:28`
- Test: `apps/web/test/link-flow-render.test.tsx`

**Interfaces:** Consumes `btnSecondary` from `ui.tsx`. Produces nothing new.

- [ ] **Step 1: Write the failing test** — `apps/web/test/link-flow-render.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LinkFlow } from "../app/(site)/link/link-flow";
import LoginPage from "../app/(site)/login/page";
import JoinPage from "../app/(site)/join/page";
import { btnSecondary } from "../app/components/ui";

type Initial = Parameters<typeof LinkFlow>[0]["initial"];
const flow = (initial: Initial) => renderToStaticMarkup(<LinkFlow initial={initial} />);
const LINKED = { link: { dayzId: "dz", gamertag: "Ada", verifiedAt: "2026-09-01T00:00:00.000Z" }, challenge: null, ended: null } as Initial;
const OPEN = {
  link: null, ended: null,
  challenge: { id: 1, targetDayzId: "dz", gamertag: "Ada", confirmed: 0, drawsLeft: 2, expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    steps: [{ token: "salute", label: "salute", confirmed: false }] },
} as Initial;
const CHOOSE = { link: null, challenge: null, ended: "expired" } as Initial;

describe("M2: the verified screen's second button", () => {
  it("is the secondary button, with no gold hover under ink text", () => {
    const a = flow(LINKED).match(/<a[^>]*href="\/me"[^>]*>/u)?.[0] ?? "";
    expect(a).toContain(btnSecondary);
    expect(a).not.toContain("hover:bg-gold-hover");
  });
});

describe("L1: a refusal is not rust", () => {
  it("the 'Not issued' box uses the control edge", () => {
    const html = flow(CHOOSE);
    expect(html).toContain("Not issued");
    expect(html).not.toContain("border-rust");
  });
});

describe("L6: the countdown and the bullet", () => {
  const html = flow(OPEN);
  it("says 'left' on a phone, where 'Expires in' is hidden", () => expect(html).toContain('<span class="lg:hidden"> left</span>'));
  it("hides the decorative bullet from a screen reader", () => expect(html).toContain('<span aria-hidden="true" class="mr-3 text-rust-2">●</span>'));
});

describe("L5: one numbering, sign-in to proof", () => {
  it("login is step 1", async () => expect(renderToStaticMarkup(await LoginPage({ searchParams: Promise.resolve({}) }))).toContain("Step 1 of 3 — sign in"));
  it("joining the Discord is still step 1, not 'one step left'", async () => {
    const html = renderToStaticMarkup(await JoinPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Step 1 of 3 — join the Discord");
    expect(html).not.toContain("One step left");
  });
  it("naming the character is step 2", () => expect(flow(CHOOSE)).toContain("Step 2 of 3 — name your character"));
  it("the proof is step 3, and does not also say 'one step left'", () => {
    const html = flow(OPEN);
    expect(html).toContain("Step 3 of 3 — prove it");
    expect(html).not.toContain("one step left");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/link-flow-render.test.tsx`
Expected: FAIL. The M2 test fails because the anchor contains `hover:bg-gold-hover` and not `btnSecondary`'s classes. The L1, L6 and L5 tests fail on their own assertions.

- [ ] **Step 3: Implement**

In `apps/web/app/(site)/link/link-flow.tsx`:
- The ui import: `import { btnCta, btnPrimary, btnQuiet, field } from "@/app/components/ui";` → `import { btnCta, btnQuiet, btnSecondary, field } from "@/app/components/ui";`
- `<div className={step}>Step 3 of 3 — one step left</div>` → `<div className={step}>Step 3 of 3 — prove it</div>`
- `<span className="mr-3 text-rust-2">●</span>Challenge open` → `<span aria-hidden="true" className="mr-3 text-rust-2">●</span>Challenge open`
- `<span className="font-mono text-[11px] text-muted"><span className="hidden lg:inline">Expires in </span>{formatRemaining(remaining)}</span>` → the line below. L6: on a phone, "23 h 12 min" alone never said what it counted down to.
  ```tsx
            <span className="font-mono text-[11px] text-muted"><span className="hidden lg:inline">Expires in </span>{formatRemaining(remaining)}<span className="lg:hidden"> left</span></span>
  ```
- In `Verified`, the line ``<a className={`mt-3 ${btnPrimary.replace("bg-gold", "border-2 border-rule-2 bg-transparent").replace("text-ground", "text-ink")} w-full`} href="/me">Your page</a>`` →
  ```tsx
        {/* M2: the real secondary button. Rewriting btnPrimary's classes left its gold hover under ink text (1.5:1) and a panel edge where a control's belongs. */}
        <a className={`mt-3 ${btnSecondary} w-full`} href="/me">Your page</a>
  ```
- In `Refusal`, replace the body with:
  ```tsx
    // L1: a refusal owes the server nothing, so it is never rust (globals.css); the control edge makes it stand out instead.
    return (
      <div className={`mb-4 border px-3.5 py-3 ${neutral ? "border-rule-2 bg-surface" : "border-rule-3 bg-surface"}`} role={neutral ? "status" : "alert"}>
        <div className={label}>{title}</div>
        <div className="mt-1 text-sm leading-relaxed text-ink">{children}</div>
      </div>
    );
  ```

`apps/web/app/(site)/login/page.tsx:31`: `step="Step 1 of 3"` → `step="Step 1 of 3 — sign in"`.

`apps/web/app/(site)/join/page.tsx:28`: `step="One step left"` → `step="Step 1 of 3 — join the Discord"`. Joining the Discord is part of signing in, so it keeps step 1; the next screen, /link, says step 2.

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/link-flow-render.test.tsx test/link-claim.test.ts` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/link/link-flow.tsx" "apps/web/app/(site)/login/page.tsx" "apps/web/app/(site)/join/page.tsx" apps/web/test/link-flow-render.test.tsx
git commit -m "$(cat <<'EOF'
fix(web): /link's secondary button, plain refusals, one step numbering, a labelled countdown

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 12: M5 — guest passes are listed by gamertag, not a Discord id

**Files:**
- Modify: `packages/roster/src/internal/guest-store.ts:7,19,119`
- Test: `packages/roster/test/guest.test.ts:125-133` (update one expectation, add one test)
- Create: `apps/web/app/(site)/clan/settings/guest-passes.tsx`
- Modify: `apps/web/app/(site)/clan/settings/page.tsx`: replace the guest-pass list as it stands after Tasks 3 and 7. That is the `{guestPasses.length === 0 ? … : (<ul …>…</ul>)}` expression inside the "Guest passes" `Panel`.
- Test: `apps/web/test/guest-passes.test.tsx`

**Interfaces:**
- Produces: `OpenGuestPass = { id: number; userDiscordId: string; userGamertag: string | null; grantedBy: string; expiresAt: Date }`. This adds a field; the roster export list is unchanged, since `ClanView` already carries the type.
- Produces: `GuestPassList(props: { passes: ClanView["guestPasses"] })`.

- [ ] **Step 1: Write the failing tests**

In `packages/roster/test/guest.test.ts`, replace the expectation at line 129:

```ts
    expect(open).toEqual([{ id: granted.passId, userDiscordId: U9, userGamertag: null, grantedBy: "Otto", expiresAt: new Date(now.getTime() + GUEST_PASS_MS) }]);
```

and add after that `it(...)` block:

```ts
  /** M5: /clan/settings listed passes by an 18-digit Discord id; a linked guest has a name. */
  it("openGuestPassesDb names a linked guest by gamertag", async () => {
    await db.insert(players).values({ dayzId: "G".repeat(40), gamertag: "Gus", firstSeenAt: now, lastSeenAt: now });
    await db.insert(identityLinks).values({ discordId: "dG", dayzId: "G".repeat(40), gamertag: "Gus", verifiedAt: now });
    await grantGuestPassDb(db, { factionId, actorDiscordId: D.O1, userDiscordId: "dG", at: now });

    const [pass] = await openGuestPassesDb(db, factionId, now);
    expect(pass!.userGamertag).toBe("Gus");
  });
```

`apps/web/test/guest-passes.test.tsx`:

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GuestPassList } from "../app/(site)/clan/settings/guest-passes";

const at = new Date("2026-09-25T12:00:00Z");

describe("the guest pass list (M5)", () => {
  it("names a linked guest by gamertag and hides the id", () => {
    const html = renderToStaticMarkup(<GuestPassList passes={[{ id: 1, userDiscordId: "123456789012345678", userGamertag: "Gus", grantedBy: "Otto", expiresAt: at }]} />);
    expect(html).toContain("Gus");
    expect(html).not.toContain("123456789012345678");
    expect(html).toContain("granted by Otto");
  });

  it("falls back to 'Discord user' and the id, muted, for a guest who never linked", () => {
    const html = renderToStaticMarkup(<GuestPassList passes={[{ id: 1, userDiscordId: "123456789012345678", userGamertag: null, grantedBy: "Otto", expiresAt: at }]} />);
    expect(html).toContain("Discord user");
    expect(html).toContain("123456789012345678");
  });

  it("says so when there are none", () => expect(renderToStaticMarkup(<GuestPassList passes={[]} />)).toContain("No open passes."));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/guest.test.ts`
Expected: FAIL. In `openGuestPassesDb: only open passes`, the diff shows the `userGamertag` key missing, and the new test gets `undefined`.
Run: `cd apps/web && npx vitest run test/guest-passes.test.tsx`
Expected: FAIL — `Failed to resolve import "../app/(site)/clan/settings/guest-passes"`.

- [ ] **Step 3: Implement**

`packages/roster/src/internal/guest-store.ts`:
- line 7: `import { gamertagOrId } from "./feed-actor";` → `import { actorGamertagTx, gamertagOrId } from "./feed-actor";`
- line 19 →
  ```ts
  /**
   * `userGamertag` is null for a guest who never linked a character: the site
   * knows no other name for them (it never reads Discord profiles). M5.
   */
  export type OpenGuestPass = { id: number; userDiscordId: string; userGamertag: string | null; grantedBy: string; expiresAt: Date };
  ```
- line 119 →
  ```ts
      out.push({ id: r.id, userDiscordId: r.userDiscordId, userGamertag: (await actorGamertagTx(tx, r.userDiscordId)) ?? null, grantedBy: await gamertagOrId(tx, r.grantedByDiscordId), expiresAt: r.expiresAt });
  ```

`apps/web/app/(site)/clan/settings/guest-passes.tsx`:

```tsx
import type { ClanView } from "@factions/roster";
import { when } from "@/lib/format";
import { ConfirmButton, PanelBody, btnSecondary } from "@/app/components/ui";

/**
 * The open guest passes on /clan/settings.
 *
 * M5: a pass is named by the guest's gamertag. An unlinked guest has no name
 * the site knows, so they read "Discord user" with the id beside it, muted —
 * the id is the one thing that tells two unlinked guests apart.
 */
export function GuestPassList({ passes }: { passes: ClanView["guestPasses"] }) {
  if (passes.length === 0) return <PanelBody className="border-t border-rule-2 !py-3"><p className="text-sm text-ink-2">No open passes.</p></PanelBody>;
  return (
    <ul className="border-t border-rule-2">
      {passes.map((p) => (
        <li key={p.id} className="flex min-h-[60px] flex-wrap items-center justify-between gap-3 border-t border-rule-2 px-4 py-2 text-sm text-ink first:border-t-0 lg:px-5">
          <span>
            <span className="font-mono">{p.userGamertag ?? "Discord user"}</span>
            {p.userGamertag === null && <span className="ml-2 font-mono text-xs text-muted">{p.userDiscordId}</span>}
            <span className="block text-xs text-muted">granted by {p.grantedBy} · expires {when(p.expiresAt)}</span>
          </span>
          <form action="/api/clan/revoke-guest" method="post"><input type="hidden" name="passId" value={p.id} /><ConfirmButton confirm="Press again to revoke" className={`${btnSecondary} !px-3.5`}>Revoke</ConfirmButton></form>
        </li>
      ))}
    </ul>
  );
}
```

In `apps/web/app/(site)/clan/settings/page.tsx`:
- Add `import { GuestPassList } from "./guest-passes";` after the `RenameForm` import.
- Replace the whole `{guestPasses.length === 0 ? <PanelBody …>No open passes.</p></PanelBody> : ( <ul className="border-t border-rule-2"> … </ul> )}` expression (original lines 69–78) with:
  ```tsx
            <GuestPassList passes={guestPasses} />
  ```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/guest.test.ts test/reads.test.ts` — all pass. Then `npx tsc --noEmit`.
Run: `cd apps/web && npx vitest run test/guest-passes.test.tsx test/submit-once.test.ts test/confirm-button.test.tsx` — all pass. Then `npx tsc --noEmit`.
Run: `cd apps/bot && npx tsc --noEmit` — clean (`commands/guest.ts` reads only `userDiscordId`).

- [ ] **Step 5: Commit**

```bash
git add packages/roster/src/internal/guest-store.ts packages/roster/test/guest.test.ts "apps/web/app/(site)/clan/settings/guest-passes.tsx" "apps/web/app/(site)/clan/settings/page.tsx" apps/web/test/guest-passes.test.tsx
git commit -m "$(cat <<'EOF'
fix: list guest passes by the guest's gamertag, not a raw Discord id

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 13: M3 — repeated row buttons say who they act on

**Files:**
- Create: `apps/web/app/components/row-action.tsx`
- Modify: `apps/web/app/(site)/clan/page.tsx`. Changes, against the text left by Tasks 3, 4 and 7:
  - delete the local `RowAction` (original lines 21–31)
  - add an import
  - roster rows (original 97–100)
  - withdraw (original 121)
  - requests (original 142–143)
- Modify: `apps/web/app/(site)/clan/settings/guest-passes.tsx` (the revoke form)
- Modify: `apps/web/app/(site)/base/page.tsx` (the Declare form, original 139–142)
- Test: `apps/web/test/row-action.test.tsx`

**Interfaces:**
- Consumes: `SubmitButton`, `ConfirmButton`.
- Produces: `RowAction(props: { action: string; fields: Record<string, string | number>; who: string; children: React.ReactNode; style?: string; confirm?: string; disabled?: boolean })`. `action` is the full path; `who` is required.

- [ ] **Step 1: Write the failing test** — `apps/web/test/row-action.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RowAction } from "../app/components/row-action";
import { GuestPassList } from "../app/(site)/clan/settings/guest-passes";

describe("RowAction (M3)", () => {
  it("names who it acts on inside the button, for a screen reader's button list", () => {
    const html = renderToStaticMarkup(<RowAction action="/api/clan/promote" fields={{ target: "d1" }} who="Ada">Make officer</RowAction>);
    expect(html).toContain('Make officer<span class="sr-only"> Ada</span>');
    expect(html).toContain('action="/api/clan/promote"');
    expect(html).toContain('<input type="hidden" name="target" value="d1"/>');
  });

  it("carries every hidden field", () => {
    const html = renderToStaticMarkup(<RowAction action="/api/clan/decide-request" fields={{ requestId: 7, decision: "accepted" }} who="Bo">Accept</RowAction>);
    expect(html).toContain('name="requestId" value="7"');
    expect(html).toContain('name="decision" value="accepted"');
  });

  it("names the target on a two-press button too", () => {
    const html = renderToStaticMarkup(<RowAction action="/api/clan/kick" fields={{ target: "d1" }} who="Ada" confirm="Press again to remove">Remove</RowAction>);
    expect(html).toContain('Remove<span class="sr-only"> Ada</span>');
  });

  it("the guest pass Revoke says whose pass", () => {
    const html = renderToStaticMarkup(<GuestPassList passes={[{ id: 1, userDiscordId: "1", userGamertag: "Gus", grantedBy: "Otto", expiresAt: new Date() }]} />);
    expect(html).toContain('Revoke<span class="sr-only"> Gus</span>');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/row-action.test.tsx`
Expected: FAIL — `Failed to resolve import "../app/components/row-action"`.

- [ ] **Step 3: Implement**

`apps/web/app/components/row-action.tsx`:

```tsx
import { ConfirmButton, SubmitButton, btnSecondary } from "./ui";

/**
 * Hidden fields + one button: the shape of every per-row action on the clan
 * pages and /base.
 *
 * ⚠️ M3: `who` rides inside the button as screen-reader-only text. Ten
 * "Remove" buttons are ten identical entries in a screen reader's list of
 * buttons; "Remove Ada" is one decision. The visible text stays the short
 * verb because the row already shows the name.
 */
export function RowAction({ action, fields, who, children, style = btnSecondary, confirm, disabled = false }: {
  action: string; fields: Record<string, string | number>; who: string; children: React.ReactNode; style?: string; confirm?: string; disabled?: boolean;
}) {
  const label = <>{children}<span className="sr-only">{` ${who}`}</span></>;
  return (
    <form action={action} method="post">
      {Object.entries(fields).map(([name, value]) => <input key={name} type="hidden" name={name} value={value} />)}
      {confirm
        ? <ConfirmButton confirm={confirm} className={`${style} !px-3.5`} disabled={disabled}>{label}</ConfirmButton>
        : <SubmitButton className={`${style} !px-3.5`} disabled={disabled}>{label}</SubmitButton>}
    </form>
  );
}
```

`apps/web/app/(site)/clan/page.tsx`:
- Delete the whole local `/** Hidden target + one button: the shape of every per-row action. */ function RowAction(…) { … }` block (original lines 21–31, as edited by Task 4).
- Add `import { RowAction } from "@/app/components/row-action";` after the `OwnClanHero` import.
- Replace the four roster-row actions (original lines 97–100) with:
  ```tsx
                    {!self && officer && r.status === "full" && r.role === "member" && <RowAction action="/api/clan/kick" fields={{ target: r.discordId }} who={r.gamertag ?? "unknown"} style={btnDanger} confirm="Press again to remove">Remove</RowAction>}
                    {!self && officer && isPending && <RowAction action="/api/clan/kick" fields={{ target: r.discordId }} who={r.gamertag ?? "unknown"} style={btnDanger} confirm="Press again to remove">Remove</RowAction>}
                    {!self && leader && r.status === "full" && r.role === "member" && <RowAction action="/api/clan/promote" fields={{ target: r.discordId }} who={r.gamertag ?? "unknown"}>Make officer</RowAction>}
                    {!self && leader && r.status === "full" && r.role === "officer" && <RowAction action="/api/clan/demote" fields={{ target: r.discordId }} who={r.gamertag ?? "unknown"} confirm="Press again to demote">Demote</RowAction>}
  ```
- Replace the withdraw form (original line 121) with:
  ```tsx
                        <RowAction action="/api/clan/revoke-invite" fields={{ inviteId: inv.id }} who={inv.inviteeGamertag ?? "unknown"} confirm="Press again to withdraw">Withdraw</RowAction>
  ```
- Replace the two decide-request forms inside `<span className="flex gap-2">` (original lines 142–143) with:
  ```tsx
                          <RowAction action="/api/clan/decide-request" fields={{ requestId: r.id, decision: "accepted" }} who={r.gamertag ?? "unknown"} style={btnPrimary}>Accept</RowAction>
                          <RowAction action="/api/clan/decide-request" fields={{ requestId: r.id, decision: "declined" }} who={r.gamertag ?? "unknown"}>Decline</RowAction>
  ```

`apps/web/app/(site)/clan/settings/guest-passes.tsx`:
- Replace `import { ConfirmButton, PanelBody, btnSecondary } from "@/app/components/ui";` with:
  ```tsx
  import { PanelBody } from "@/app/components/ui";
  import { RowAction } from "@/app/components/row-action";
  ```
- Replace the revoke `<form …>…</form>` with:
  ```tsx
          <RowAction action="/api/clan/revoke-guest" fields={{ passId: p.id }} who={p.userGamertag ?? "Discord user"} confirm="Press again to revoke">Revoke</RowAction>
  ```

`apps/web/app/(site)/base/page.tsx`:
- Add `import { RowAction } from "@/app/components/row-action";` after the `ReportButton` import.
- Replace the Declare form (the `<form action="/api/base/declare" method="post">` … `</form>` block, original lines 139–142) with:
  ```tsx
                      <RowAction action="/api/base/declare" fields={{ poleKey: c.poleKey }} who={`at grid ${gridRef(c.x, c.z)}`} style={btnPrimary} disabled={view.declaration !== null}>Declare</RowAction>
  ```
  The pole key stays in a hidden field only. It is never rendered (CLAUDE.md: pole coordinates are a raid target); the grid reference shown is the viewer's own raise, which this page already prints.

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/row-action.test.tsx test/submit-once.test.ts test/confirm-button.test.tsx test/guest-passes.test.tsx test/base-report.test.ts` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/app/components/row-action.tsx "apps/web/app/(site)/clan/page.tsx" "apps/web/app/(site)/clan/settings/guest-passes.tsx" "apps/web/app/(site)/base/page.tsx" apps/web/test/row-action.test.tsx
git commit -m "$(cat <<'EOF'
fix(web): repeated row buttons name who or what they act on for screen readers

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 14: M6 — "Move here" is a two-press, like Release

**Files:**
- Modify: `apps/web/app/(site)/clan/settings/page.tsx`: the rebind form inside the "Move the base" panel (original line 120, as edited by Task 4), plus one import
- Test: `apps/web/test/move-base.test.ts`

**Interfaces:** Consumes `RowAction` (Task 13).

- [ ] **Step 1: Write the failing test** — `apps/web/test/move-base.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SETTINGS = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "clan", "settings", "page.tsx"), "utf8");

/**
 * M6: one tap moved the base, started the 7-day cooldown and put the old pole
 * on its grace clock. Release on /base has always been two-press; this is the
 * same weight of act.
 */
describe("Move here", () => {
  it("is a two-press", () => {
    expect(SETTINGS).toMatch(/<RowAction action="\/api\/clan\/rebind"[^\n]*confirm="Press again to move"/u);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/move-base.test.ts`
Expected: FAIL — `expected '…' to match /<RowAction action="\/api\/clan\/rebind"…/`.

- [ ] **Step 3: Implement**

In `apps/web/app/(site)/clan/settings/page.tsx`:
- Add `import { RowAction } from "@/app/components/row-action";` after the `GuestPassList` import.
- Replace
  ```tsx
                        <form action="/api/clan/rebind" method="post"><input type="hidden" name="poleKey" value={c.poleKey} /><SubmitButton className={`${btnPrimary} !px-3.5`}>Move here</SubmitButton></form>
  ```
  with
  ```tsx
                        {/* M6: moving starts a cooldown and releases the old pole — two-press, the same weight as Release on /base. The pole key stays in a hidden field, never rendered. */}
                        <RowAction action="/api/clan/rebind" fields={{ poleKey: c.poleKey }} who={`(raised by ${c.by})`} style={btnPrimary} confirm="Press again to move">Move here</RowAction>
  ```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/move-base.test.ts test/confirm-button.test.tsx test/submit-once.test.ts` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/clan/settings/page.tsx" apps/web/test/move-base.test.ts
git commit -m "$(cat <<'EOF'
fix(web): moving the base takes a second press, like releasing one

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 15: M7 — tap targets on notifications and the vault's "Hide now"

The bell panel's own "Mark all read" (113×17 live) is in `notifications-bell.tsx`'s panel, which the SHELL/PUBLIC plan owns. It is not changed here; see the self-review.

**Files:**
- Create: `apps/web/app/(site)/notifications/filter-chips.tsx`
- Modify: `apps/web/app/(site)/notifications/page.tsx`:
  - line 7 (ui import)
  - lines 47–49 (the `chip` helper, deleted)
  - line 56 (Mark all read)
  - lines 65–68 (the chip row)
- Modify: `apps/web/app/(site)/notifications/actions.tsx:12-14` (`btn`)
- Modify: `apps/web/app/(site)/clan/vault/reveal-button.tsx:62`
- Test: `apps/web/test/tap-targets.test.tsx`

**Interfaces:** Produces `FilterChips(props: { group: NoticeGroup | undefined; href: (o: { page?: number; group?: NoticeGroup | null }) => string })`.

- [ ] **Step 1: Write the failing test** — `apps/web/test/tap-targets.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import type { NoticeRow } from "@factions/roster";
import { NOTICE_GROUPS } from "../lib/notice-copy";
import { NoticeActions } from "../app/(site)/notifications/actions";
import { FilterChips } from "../app/(site)/notifications/filter-chips";

const row = (kind: NoticeRow["kind"]): NoticeRow => ({ id: 1, kind, target: "dm", occurredAt: new Date(), payload: {}, clanId: 7, unread: true });
const controls = (html: string) => (html.match(/<(button|a) /gu) ?? []).length;
const tall = (html: string) => (html.match(/min-h-\[44px\]/gu) ?? []).length;

describe("M7: 44px everywhere a player taps", () => {
  it.each(["invited", "vote_opened", "rebind_proposed"] as const)("every %s action is 44px tall", (kind) => {
    const html = renderToStaticMarkup(<NoticeActions row={row(kind)} />);
    expect(controls(html)).toBeGreaterThan(0);
    expect(tall(html)).toBe(controls(html));
    expect(html).not.toMatch(/min-h-\[3\dpx\]/u);
  });

  it("every filter chip is 44px tall", () => {
    const html = renderToStaticMarkup(<FilterChips group={undefined} href={() => "/notifications"} />);
    expect(tall(html)).toBe(NOTICE_GROUPS.length + 1);
  });

  it("the page's Mark all read is a full-size secondary button", () => {
    const page = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "notifications", "page.tsx"), "utf8");
    expect(page).toContain("<SubmitButton className={btnSecondary}>Mark all read</SubmitButton>");
  });

  it("the vault's Hide now is 44px tall", () => {
    const reveal = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "clan", "vault", "reveal-button.tsx"), "utf8");
    expect(reveal.split("\n").find((l) => l.includes(">Hide now<"))).toContain("min-h-[44px]");
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/tap-targets.test.tsx`
Expected: FAIL — `Failed to resolve import "../app/(site)/notifications/filter-chips"`.

- [ ] **Step 3: Implement**

`apps/web/app/(site)/notifications/filter-chips.tsx`:

```tsx
import { NOTICE_GROUPS, type NoticeGroup } from "@/lib/notice-copy";

/**
 * The filter row on /notifications. M7: every chip is 44px tall — they were
 * 34px, the smallest targets on a page read mostly on phones. Control edges
 * are rule-3 (globals.css: the boundary that is the only affordance).
 */
export function FilterChips({ group, href }: { group: NoticeGroup | undefined; href: (o: { page?: number; group?: NoticeGroup | null }) => string }) {
  const chip = (label: string, on: boolean, to: string) => (
    <a key={label} href={to} aria-current={on ? "true" : undefined}
      className={`flex min-h-[44px] items-center border px-3 font-mono text-[11px] uppercase tracking-[0.12em] ${on ? "border-gold bg-gold text-ground" : "border-rule-3 text-ink-2 hover:text-ink"}`}>{label}</a>
  );
  return (
    <div role="group" aria-label="Filter" className="mt-6 flex flex-wrap gap-2">
      {chip("All", !group, href({ group: null, page: 1 }))}
      {NOTICE_GROUPS.map((g) => chip(g, group === g, href({ group: g, page: 1 })))}
    </div>
  );
}
```

`apps/web/app/(site)/notifications/page.tsx`:
- line 7: `import { Pager, Notice, SubmitButton } from "@/app/components/ui";` → `import { Pager, Notice, SubmitButton, btnSecondary } from "@/app/components/ui";`, and add `import { FilterChips } from "./filter-chips";` after the `NoticeActions` import.
- Delete the `const chip = (label: string, on: boolean, to: string) => …;` helper (original lines 47–49).
- The Mark all read button → `<SubmitButton className={btnSecondary}>Mark all read</SubmitButton>`
- Replace the `<div role="group" aria-label="Filter" …>…</div>` block (original lines 65–68) with `<FilterChips group={group} href={href} />`.

`apps/web/app/(site)/notifications/actions.tsx` lines 12–14 → (M7: the actions were 38px):
```tsx
const btn = (tone: "primary" | "ghost") =>
  `flex min-h-[44px] items-center border px-4 font-display text-xs uppercase tracking-[0.06em] ${
    tone === "primary" ? "border-gold bg-gold text-ground hover:bg-gold-hover" : "border-rule-3 text-ink hover:border-ink"}`;
```

`apps/web/app/(site)/clan/vault/reveal-button.tsx:62` → (M7: "Hide now" was a bare 16px-tall word):
```tsx
        <button type="button" className="inline-flex min-h-[44px] items-center px-2 font-mono text-xs uppercase tracking-[0.18em] text-muted hover:text-ink" onClick={() => { stop(); setCode(null); }}>Hide now</button>
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/tap-targets.test.tsx test/notification-actions.test.ts test/notifications-page.test.ts` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/notifications/filter-chips.tsx" "apps/web/app/(site)/notifications/page.tsx" "apps/web/app/(site)/notifications/actions.tsx" "apps/web/app/(site)/clan/vault/reveal-button.tsx" apps/web/test/tap-targets.test.tsx
git commit -m "$(cat <<'EOF'
fix(web): notifications and the vault's Hide now meet the 44px tap minimum

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 16: M8 — the notifications filter filters in SQL, across pages

**Files:**
- Modify: `packages/roster/src/notifications.ts` (`notificationsForDb`, lines 70–105; imports on line 2)
- Modify: `packages/roster/src/api.ts:1,200-201`
- Test: `packages/roster/test/notifications.test.ts` (append after the Task 1 tests)
- Modify: `apps/web/lib/notice-copy.ts` (append `kindsInGroup` after `noticeGroup`, line 325)
- Modify: `apps/web/app/(site)/notifications/page.tsx`:
  - line 4 (import)
  - lines 34–36 (the read, and the filter it replaces)
  - line 72 (the empty-state text)
- Test: `apps/web/test/notice-copy.test.ts` (append one `it` inside `describe("notice copy", …)`)

**Interfaces:**
- Produces: `notificationsForDb(db, discordId, page, pageSize = NOTIFICATIONS_PAGE_SIZE, kinds?: readonly ClanNoticeKind[])`.
- Produces: `notificationsFor(discordId, page, pageSize?, kinds?)`. The optional fourth parameter does not change the export list, and the bell's calls `notificationsFor(sub, 1, 4)` are unchanged.
- Produces: `kindsInGroup(group: NoticeGroup): ClanNoticeKind[]`.

- [ ] **Step 1: Write the failing tests**

Append to `packages/roster/test/notifications.test.ts` (inside the outer describe, after Task 1's tests):

```ts
  /**
   * M8: the page filtered the 50 rows it had already fetched, so a filter
   * showed "nothing on this page" while page 2 was full of matches. The kind
   * filter must be in the query, before the LIMIT.
   */
  it("filters by kind in the query, so a filter reaches past the first page", async () => {
    for (let i = 0; i < 51; i++) await dm(new Date(Date.UTC(2026, 8, 18, 0, i)));
    const f = await faction("NTH");
    await member(f, AT("2026-09-01T00:00:00Z"));
    await channel(f, AT("2026-09-17T00:00:00Z"));
    expect((await notificationsForDb(db, YOU, 1)).rows.some((r) => r.kind === "promoted")).toBe(false);

    const p = await notificationsForDb(db, YOU, 1, undefined, ["promoted"]);
    expect(p.rows.map((r) => r.kind)).toEqual(["promoted"]);
    expect(p.hasNext).toBe(false);
  });

  it("an empty kind list is an empty page, not everything", async () => {
    await dm(AT("2026-09-18T10:00:00Z"));
    expect(await notificationsForDb(db, YOU, 1, undefined, [])).toEqual({ rows: [], page: 1, hasNext: false });
  });
```

Append inside `describe("notice copy", …)` in `apps/web/test/notice-copy.test.ts`, and add `kindsInGroup, noticeGroup` to the `@/lib/notice-copy` import on line 3:

```ts
  it("kindsInGroup partitions every kind into exactly its group (M8)", () => {
    const all = NOTICE_GROUPS.flatMap((g) => kindsInGroup(g).map((k) => [k, g] as const));
    expect(all.map(([k]) => k).sort()).toEqual([...CLAN_NOTICE_KINDS].sort());
    for (const [k, g] of all) expect(noticeGroup(k)).toBe(g);
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/notifications.test.ts`
Expected: FAIL — `expected [ 'invited', 'invited', … ] to deeply equal [ 'promoted' ]`. The fifth argument is ignored.
Run: `cd apps/web && npx vitest run test/notice-copy.test.ts`
Expected: FAIL — `kindsInGroup is not a function`.

- [ ] **Step 3: Implement**

`packages/roster/src/notifications.ts`, `notificationsForDb` (replace the signature and the body up to the `const all = [...raw];` line):

```ts
/**
 * `kinds` narrows the page to those kinds IN THE QUERY (M8). The site's filter
 * chips used to filter the 50 rows already fetched, so a filter could say
 * "nothing here" while page 2 was full of matches, and the pager counted rows
 * the filter then hid. An empty list is an empty page — never "everything".
 */
export async function notificationsForDb(db: Database, discordId: string, page: number, pageSize: number = NOTIFICATIONS_PAGE_SIZE, kinds?: readonly ClanNoticeKind[]): Promise<NotificationsPage> {
  const p = Math.max(1, Math.trunc(page));
  if (kinds && kinds.length === 0) return { rows: [], page: p, hasNext: false };
  // ⚠️ One extra row, not a second COUNT query: "is there a next page" is the
  // only thing the pager needs, and counting an unbounded table to learn it is
  // the expensive way to answer a yes/no question.
  const limit = pageSize + 1;
  const offset = (p - 1) * pageSize;
  const only = kinds ? sql`where v.kind in (${sql.join(kinds.map((k) => sql`${k}`), sql`, `)})` : sql``;

  const raw = await db.execute<Raw>(sql`
    with v as (${VISIBLE(discordId)})
    select v.*, (${UNREAD_PREDICATE(discordId)}) as unread
      from v
     ${only}
     order by v.id desc
     limit ${limit} offset ${offset}
  `);
```

`ClanNoticeKind` is already imported on line 2. The rest of the function is unchanged.

`packages/roster/src/api.ts`:
- After line 1 add `import type { ClanNoticeKind } from "@factions/domain";`.
- Lines 200–201 →
  ```ts
      notificationsFor: (discordId: string, page: number, pageSize?: number, kinds?: readonly ClanNoticeKind[]): Promise<NotificationsPage> =>
        notificationsForDb(getDb(), discordId, page, pageSize, kinds),
  ```

`apps/web/lib/notice-copy.ts`, after line 325:

```ts
/**
 * Every kind in one filter group, for the query (M8). Read off NOTICE_COPY so
 * a new kind joins its group's filter by being written there, and the chip and
 * the row's own group can never disagree.
 */
export function kindsInGroup(group: NoticeGroup): ClanNoticeKind[] {
  return (Object.keys(NOTICE_COPY) as ClanNoticeKind[]).filter((k) => NOTICE_COPY[k].group === group);
}
```

`apps/web/app/(site)/notifications/page.tsx`:
- line 4: `import { NOTICE_GROUPS, noticeGroup, type NoticeGroup } from "@/lib/notice-copy";` → `import { NOTICE_GROUPS, kindsInGroup, type NoticeGroup } from "@/lib/notice-copy";`
- lines 34–36 →
  ```tsx
    // M8: the filter is part of the query, so it reaches every page and the pager counts what it shows.
    const feed = await notificationsFor(session.sub, page, undefined, group ? kindsInGroup(group) : undefined);
    const now = new Date();
    const shown = feed.rows;
  ```
- line 72: `{group ? "Nothing in this filter on this page." : "Nothing here yet."}` → `{group ? "Nothing in this filter." : "Nothing here yet."}`

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd packages/roster && TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" npx vitest run test/notifications.test.ts test/exports.test.ts` — all pass. Then `npx tsc --noEmit`.
Run: `cd apps/web && npx vitest run test/notice-copy.test.ts test/smoke.test.ts test/notifications-bell.test.ts` — all pass. Then `npx tsc --noEmit`.

- [ ] **Step 5: Commit**

```bash
git add packages/roster/src/notifications.ts packages/roster/src/api.ts packages/roster/test/notifications.test.ts apps/web/lib/notice-copy.ts "apps/web/app/(site)/notifications/page.tsx" apps/web/test/notice-copy.test.ts
git commit -m "$(cat <<'EOF'
fix: the notifications filter filters in the query, across every page

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 17: L8 — /notifications uses the site's page shape and never streams a redirect

**Files:**
- Modify: `apps/web/app/(site)/notifications/page.tsx` (whole file)
- Test: `apps/web/test/notifications-layout.test.ts`

**Interfaces:** Consumes `Page`, `PageHead`, `Body`, `SessionLost`, `SubmitButton`, `btnSecondary`, `FilterChips`, `kindsInGroup`.

- [ ] **Step 1: Write the failing test** — `apps/web/test/notifications-layout.test.ts`

```ts
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE = readFileSync(join(import.meta.dirname, "..", "app", "(site)", "notifications", "page.tsx"), "utf8");

describe("/notifications is an ordinary signed-in page (L8)", () => {
  /** app/(site)/me/route.ts: in this streamed group a redirect() is a one-second meta refresh, not a 3xx. */
  it("⚠️ answers a lost session with SessionLost, never a streamed redirect()", () => {
    expect(PAGE).not.toMatch(/from "next\/navigation"/u);
    expect(PAGE).toContain('<SessionLost next="/notifications" />');
  });
  it("uses Page and PageHead — centred, the shared title scale, one <main>", () => {
    expect(PAGE).toContain("<Page>");
    expect(PAGE).toContain("<PageHead");
    expect(PAGE).not.toContain("<main");
  });
  it("ends on the way back", () => expect(PAGE).toContain('<BackLine href="/me">'));
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/notifications-layout.test.ts`
Expected: FAIL — `expected '…' not to match /from "next\/navigation"/`.

- [ ] **Step 3: Implement** — `apps/web/app/(site)/notifications/page.tsx` (whole file)

```tsx
import type { Metadata } from "next";
import { notificationsFor } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { NOTICE_GROUPS, kindsInGroup, type NoticeGroup } from "@/lib/notice-copy";
import { notificationsHref, noticeDay } from "@/lib/notifications-page";
import { NoticeArticle } from "@/app/components/notice-row";
import { Page, PageHead, Body, BackLine, Pager, Notice, SessionLost, SubmitButton, btnSecondary } from "@/app/components/ui";
import { NoticeActions } from "./actions";
import { FilterChips } from "./filter-chips";
import { RESULT_COPY } from "@/lib/clan-copy";
import { LEADERSHIP_RESULT_COPY } from "@/lib/leadership-copy";
import { NOTIFICATIONS_RESULT_COPY } from "@/lib/notifications-copy";
import { lookupCopy } from "@/lib/copy-lookup";

export const metadata: Metadata = { title: "Clan Wars — notifications", robots: { index: false, follow: false } };

/**
 * Everything the bot has told you, and everything it told your clan since you
 * joined it (spec §3). The clan half is why this page is not simply your DMs.
 *
 * ⚠️ Request-time rendered like the rest of the group; the session decides
 * every row, so there is nothing here to cache.
 */
export const dynamic = "force-dynamic";

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<{ page?: string; group?: string; result?: string }> }) {
  const session = await currentSession();
  // ⚠️ SessionLost, never redirect(): app/(site)/loading.tsx makes this group
  // stream, and a streamed redirect is a one-second meta refresh behind the
  // loading line, not a 3xx (app/(site)/me/route.ts says the same).
  if (!session) return <SessionLost next="/notifications" />;
  const q = await searchParams;
  const page = Math.max(1, Number(q.page ?? "1") || 1);
  const group = NOTICE_GROUPS.find((g) => g === q.group);
  const notice = q.result
    ? (lookupCopy(RESULT_COPY, q.result) ?? lookupCopy(LEADERSHIP_RESULT_COPY, q.result) ?? lookupCopy(NOTIFICATIONS_RESULT_COPY, q.result))
    : undefined;

  // M8: the filter is part of the query, so it reaches every page and the pager counts what it shows.
  const feed = await notificationsFor(session.sub, page, undefined, group ? kindsInGroup(group) : undefined);
  const now = new Date();
  const shown = feed.rows;

  // Day headings are computed per page on purpose: a day spanning a page
  // boundary gets its heading on both, which beats a pager that cannot say how
  // many pages there are.
  const days = ["Today", "Yesterday", "Earlier"]
    .map((day) => ({ day, items: shown.filter((r) => noticeDay(r.occurredAt, now) === day) }))
    .filter((d) => d.items.length > 0);

  const href = (o: { page?: number; group?: NoticeGroup | null }) => notificationsHref({ page, group }, o);

  return (
    <Page>
      <PageHead kicker="Inbox" title="Notifications"
        sub="Everything the bot sent you, and everything it posted to your clan since you joined."
        aside={<form action="/api/notifications/read-all" method="post"><SubmitButton className={btnSecondary}>Mark all read</SubmitButton></form>} />
      <Body className="max-w-[900px]">
        {notice && <Notice>{notice}</Notice>}
        <FilterChips group={group} href={href} />

        {days.length === 0 ? (
          <p className="mt-9 border-2 border-rule-2 bg-frame px-4 py-8 text-center text-sm text-muted">
            {group ? "Nothing in this filter." : "Nothing here yet."}
          </p>
        ) : days.map((d) => (
          <section key={d.day} className="mt-9">
            <h2 className="m-0 mb-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.18em] text-dim">{d.day}</h2>
            <div className="border-t-2 border-rule-2">
              {d.items.map((r) => <NoticeArticle key={r.id} row={r} now={now} actions={<NoticeActions row={r} />} />)}
            </div>
          </section>
        ))}

        {(feed.page > 1 || feed.hasNext) && (
          <div className="mt-6">
            <Pager page={feed.page} prevHref={feed.page > 1 ? href({ page: feed.page - 1 }) : null}
                   nextHref={feed.hasNext ? href({ page: feed.page + 1 }) : null}
                   labels={{ prev: "Newer", next: "Older", page: (n) => `Page ${n}` }} />
          </div>
        )}
        <BackLine href="/me">Your page</BackLine>
      </Body>
    </Page>
  );
}
```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/notifications-layout.test.ts test/tap-targets.test.tsx test/request-time-rendering.test.ts test/submit-once.test.ts` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/notifications/page.tsx" apps/web/test/notifications-layout.test.ts
git commit -m "$(cat <<'EOF'
fix(web): /notifications uses the site's page shape and answers a lost session in place

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 18: M9 — the kit's Undo stays long enough to use

**Files:**
- Create: `apps/web/lib/dismiss-timer.ts`
- Modify: `apps/web/app/(site)/kit/kit-flow.tsx`:
  - imports (line 6 area)
  - line 38 (`dismiss` ref)
  - line 64 (cleanup)
  - lines 143–147 (`flash`)
  - line 160 (`undo`)
  - line 269 (the status `Bar`)
  - lines 291–301 (`Bar`)
- Modify: `apps/web/test/kit.test.ts:342`
- Test: `apps/web/test/dismiss-timer.test.ts`

⚠️ No em dash anywhere in `kit-flow.tsx`, comments included (`test/kit.test.ts`).

**Interfaces:**
- Produces:
  - `UNDO_MS = 10_000`
  - `type DismissTimer = { start(): void; hold(): void; release(): void; cancel(): void }`
  - `dismissTimer(ms: number, onExpire: () => void): DismissTimer`

- [ ] **Step 1: Write the failing test** — `apps/web/test/dismiss-timer.test.ts`

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { dismissTimer, UNDO_MS } from "../lib/dismiss-timer";

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("the Undo bar's clock (M9)", () => {
  it("⚠️ gives at least ten seconds (WCAG 2.2.1; it was 4.5)", () => expect(UNDO_MS).toBeGreaterThanOrEqual(10_000));

  it("expires after its time", () => {
    const gone = vi.fn();
    dismissTimer(1000, gone).start();
    vi.advanceTimersByTime(999);
    expect(gone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("⚠️ never expires while held, and restarts the full time on release", () => {
    const gone = vi.fn();
    const t = dismissTimer(1000, gone);
    t.start();
    vi.advanceTimersByTime(900);
    t.hold();
    vi.advanceTimersByTime(60_000);
    expect(gone).not.toHaveBeenCalled();
    t.release();
    vi.advanceTimersByTime(999);
    expect(gone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it("a new pick while held does not start a countdown under the pointer", () => {
    const gone = vi.fn();
    const t = dismissTimer(1000, gone);
    t.hold();
    t.start();
    vi.advanceTimersByTime(5000);
    expect(gone).not.toHaveBeenCalled();
  });

  it("a new start replaces the old countdown; cancel stops it", () => {
    const gone = vi.fn();
    const t = dismissTimer(1000, gone);
    t.start();
    vi.advanceTimersByTime(800);
    t.start();
    vi.advanceTimersByTime(800);
    expect(gone).not.toHaveBeenCalled();
    t.cancel();
    vi.advanceTimersByTime(5000);
    expect(gone).not.toHaveBeenCalled();
  });
});
```

In `apps/web/test/kit.test.ts`, change line 342:

```ts
    expect(FLOW).toContain('<Bar role="status" tone="plain" onHold={dismiss.hold} onRelease={dismiss.release}>');
```

and add, after that `it(...)` block:

```ts
  /** M9: an Undo that vanishes while the player is reaching for it is an Undo they do not have. */
  it("keeps Undo up for ten seconds, and not at all while it is pointed at or focused", () => {
    expect(FLOW).toContain("dismissTimer(UNDO_MS,");
    expect(code(FLOW)).not.toContain("4500");
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && npx vitest run test/dismiss-timer.test.ts test/kit.test.ts`
Expected: FAIL. `dismiss-timer.test.ts` fails with `Failed to resolve import "../lib/dismiss-timer"`. In `kit.test.ts`, the line-342 assertion and the new test fail.

- [ ] **Step 3: Implement**

`apps/web/lib/dismiss-timer.ts`:

```ts
/** How long the kit's Undo bar stays (M9). WCAG 2.2.1 asks for time enough; 4.5 s was not. */
export const UNDO_MS = 10_000;

export type DismissTimer = { start(): void; hold(): void; release(): void; cancel(): void };

/**
 * A countdown that pauses while it is held.
 *
 * ⚠️ `hold` while the pointer or focus is on the bar, `release` when it
 * leaves: releasing restarts the FULL time, because a player who moved to the
 * Undo and away again is not two thirds done deciding.
 */
export function dismissTimer(ms: number, onExpire: () => void): DismissTimer {
  let id: ReturnType<typeof setTimeout> | null = null;
  let held = false;
  const stop = () => { if (id !== null) clearTimeout(id); id = null; };
  const start = () => {
    stop();
    if (!held) id = setTimeout(() => { id = null; onExpire(); }, ms);
  };
  return {
    start,
    hold: () => { held = true; stop(); },
    release: () => { held = false; start(); },
    cancel: () => { held = false; stop(); },
  };
}
```

`apps/web/app/(site)/kit/kit-flow.tsx`:
- After line 6 (the `@/lib/kit-copy` import) add `import { dismissTimer, UNDO_MS } from "@/lib/dismiss-timer";`
- Line 38, `const dismiss = useRef<ReturnType<typeof setTimeout> | null>(null);`, becomes:
  ```tsx
    /**
     * ⚠️ The Undo bar's clock (M9, WCAG 2.2.1): ten seconds, not four and a
     * half, and held while the pointer or focus is on the bar. An Undo that
     * vanishes while a player reaches for it is an Undo they do not have.
     */
    const [dismiss] = useState(() => dismissTimer(UNDO_MS, () => setToast(null)));
  ```
- Line 64, `useEffect(() => () => { if (dismiss.current) clearTimeout(dismiss.current); }, []);` → `useEffect(() => () => dismiss.cancel(), [dismiss]);`
- Lines 143–147 (`flash`) →
  ```tsx
    const flash = useCallback((text: string, prev: { slot: KitSlot; value: string }) => {
      setToast({ text, prev });
      dismiss.start();
    }, [dismiss]);
  ```
- In `undo` (line 160), `if (dismiss.current) clearTimeout(dismiss.current);` → `dismiss.cancel();`
- Line 269, `<Bar role="status" tone="plain">` → `<Bar role="status" tone="plain" onHold={dismiss.hold} onRelease={dismiss.release}>`
- `Bar` (lines 291–301) →
  ```tsx
  function Bar({ role, tone, onHold, onRelease, children }: {
    role: "alert" | "status"; tone: "rust" | "plain"; onHold?: () => void; onRelease?: () => void; children: React.ReactNode;
  }) {
    return (
      <div
        role={role}
        onMouseEnter={onHold}
        onMouseLeave={onRelease}
        onFocus={onHold}
        onBlur={onRelease}
        className={`cw-toast fixed inset-x-3 bottom-3 z-[1200] flex items-center justify-between gap-3 border bg-surface py-3 pl-3.5 pr-2 shadow-[0_8px_24px_rgba(0,0,0,.6)] lg:left-auto lg:right-8 lg:w-[420px] ${tone === "rust" ? "border-rust" : "border-rule-3"}`}
        style={{ bottom: "calc(0.75rem + env(safe-area-inset-bottom))" }}
      >
        {children}
      </div>
    );
  }
  ```

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/dismiss-timer.test.ts test/kit.test.ts test/kit-render.test.tsx` — all pass, including the no-em-dash test.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/dismiss-timer.ts "apps/web/app/(site)/kit/kit-flow.tsx" apps/web/test/dismiss-timer.test.ts apps/web/test/kit.test.ts
git commit -m "$(cat <<'EOF'
fix(web): the kit's Undo stays ten seconds, and while it is pointed at or focused

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 19: L1 + L6 + L7 — kit: plain refusals, labelled countdown, heading order, 11px, control edges

**Files:**
- Modify: `apps/web/app/(site)/kit/kit-flow.tsx`. Changes, against the text left by Task 18:
  - move the `SequenceCard` block (original lines 185–194)
  - the save-state line (original 211)
  - the alert `Bar` (original 260)
  - `Bar`'s `tone`
  - `SlotTile` (original 345–363)
- Modify: `apps/web/app/(site)/kit/sequence-card.tsx:33,36`
- Modify: `apps/web/test/kit.test.ts:341` (+ one new `describe` at the end of the file)
- Test: `apps/web/test/kit-render.test.tsx` (append one `describe`)

⚠️ No em dash anywhere in `kit-flow.tsx` or `sequence-card.tsx`, comments included.

**Interfaces:** `Bar`'s `tone` becomes `"refusal" | "plain"`. Nothing exported changes.

- [ ] **Step 1: Write the failing tests**

In `apps/web/test/kit.test.ts`, change line 341 to

```ts
    expect(FLOW).toContain('<Bar role="alert" tone="refusal">');
```

and append at the end of the file:

```ts
describe("kit visuals (UX review 2026-09-24)", () => {
  /** L1: a refused pick owes the server nothing; rust is for the open sequence alone. */
  it("never paints a refusal rust", () => {
    expect(FLOW).not.toContain('tone="rust"');
    expect(code(FLOW)).not.toContain("text-rust-2");
  });

  /** L7: the sequence card's h2 sat above the page's h1, so the outline began at level two. */
  it("puts the open sequence under the page heading", () => {
    expect(FLOW.indexOf("<SequenceCard")).toBeGreaterThan(FLOW.indexOf(">Your kit</h1>"));
  });

  it("L7: nothing smaller than 11px", () => {
    expect(code(FLOW)).not.toMatch(/text-\[(9|10)px\]/u);
    expect(code(CARD)).not.toMatch(/text-\[(9|10)px\]/u);
  });

  it("L7: a slot tile's edge is a control edge", () => {
    const tile = FLOW.slice(FLOW.indexOf("function SlotTile"), FLOW.indexOf("function HowThisWorks"));
    expect(tile).not.toContain("border-rule-2");
    expect(tile).toContain("border-rule-3");
  });
});
```

Append to `apps/web/test/kit-render.test.tsx`:

```tsx
describe("the sequence card's header (L6)", () => {
  it("says 'left' on a phone, where 'Expires in' is hidden", () => expect(card(0)).toContain('<span class="lg:hidden"> left</span>'));
  it("keeps the decorative bullet from being read aloud", () => expect(card(0)).toContain('<span aria-hidden="true" class="mr-3 text-rust-2">•</span>'));
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd apps/web && npx vitest run test/kit.test.ts test/kit-render.test.tsx`
Expected: FAIL. In `kit.test.ts`, the line-341 assertion and all four new tests fail. In `kit-render.test.tsx`, both new tests fail.

- [ ] **Step 3: Implement**

`apps/web/app/(site)/kit/kit-flow.tsx`:
- Delete the block that opens the booster branch:
  ```tsx
            {view.challenge && (
              <div className="mb-5">
                <SequenceCard
                  challenge={view.challenge}
                  busy={busy}
                  onDraw={() => { void post("/api/kit/draw"); }}
                  onCancel={() => { void post("/api/kit/cancel"); }}
                />
              </div>
            )}
  ```
  and insert, directly after the header's closing `</div>` and before `<p className="mt-3.5 text-[13px] leading-relaxed text-ink-2">`:
  ```tsx
            {/* L7: the open sequence sits under the page's own heading, never above it. Its h2 before the h1 started the outline at level two. */}
            {view.challenge && (
              <div className="mt-5">
                <SequenceCard
                  challenge={view.challenge}
                  busy={busy}
                  onDraw={() => { void post("/api/kit/draw"); }}
                  onCancel={() => { void post("/api/kit/cancel"); }}
                />
              </div>
            )}
  ```
- The save-state line: ``<div className={`mt-1 font-mono text-[10px] uppercase tracking-[0.14em] ${refusal ? "text-rust-2" : "text-muted"}`}>`` → ``<div className={`mt-1 font-mono text-[11px] uppercase tracking-[0.14em] ${refusal ? "text-ink" : "text-muted"}`}>``
- `<Bar role="alert" tone="rust">` → `<Bar role="alert" tone="refusal">`
- In `Bar`, the type `tone: "rust" | "plain";` → `tone: "refusal" | "plain";`. The className's ``… justify-between gap-3 border bg-surface …${tone === "rust" ? "border-rust" : "border-rule-3"}`` → ``… justify-between gap-3 bg-surface …${tone === "refusal" ? "border-2 border-rule-3" : "border border-rule-3"}``. Put this comment above `function Bar`:
  ```tsx
  // L1: a refusal is heavier (2px), never rust. Rust is the one cue that a player owes the server something (globals.css), and a refused pick owes it nothing.
  ```
- In `SlotTile`:
  - ``${entry ? "border border-rule-2 bg-frame" : "border border-dashed border-rule-2"}`` → ``${entry ? "border border-rule-3 bg-frame" : "border border-dashed border-rule-3"}``
  - `hover:border-rule-3` → `hover:border-muted`
  - `<span className="font-mono text-[9px] uppercase tracking-[0.14em] text-muted">{SLOT_LABELS[slot]}</span>` → `<span className="font-mono text-[11px] uppercase tracking-[0.14em] text-muted">{SLOT_LABELS[slot]}</span>`
  - in the "No art" span, `text-[10px]` → `text-[11px]`

`apps/web/app/(site)/kit/sequence-card.tsx`:
- line 33: `<span className="mr-3 text-rust-2">&bull;</span>Sequence open` → `<span aria-hidden="true" className="mr-3 text-rust-2">&bull;</span>Sequence open`
- line 36: `<span className="hidden lg:inline">Expires in </span>{formatRemaining(remaining)}` → `<span className="hidden lg:inline">Expires in </span>{formatRemaining(remaining)}<span className="lg:hidden"> left</span>`

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/kit.test.ts test/kit-render.test.tsx test/theme-tokens.test.ts` — all pass, including the no-em-dash and role-count tests.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/kit/kit-flow.tsx" "apps/web/app/(site)/kit/sequence-card.tsx" apps/web/test/kit.test.ts apps/web/test/kit-render.test.tsx
git commit -m "$(cat <<'EOF'
fix(web): kit refusals are plain, the countdown says left, 11px floor, heading order, control edges

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 20: L2 — Leave states the cooldown before you commit

**Files:**
- Create: `apps/web/app/(site)/clan/leave-form.tsx`
- Modify: `apps/web/app/(site)/clan/page.tsx`: the Leave form, as edited by Task 4 (original lines 222–225), plus one import
- Test: `apps/web/test/leave-form.test.tsx`

**Interfaces:** Produces `LeaveForm()`.

- [ ] **Step 1: Write the failing test** — `apps/web/test/leave-form.test.tsx`

```tsx
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ROSTER_COOLDOWN_MS } from "@factions/domain";
import { TABLES } from "@factions/copy";
import { days } from "../lib/format";
import { LeaveForm } from "../app/(site)/clan/leave-form";

/**
 * L2: the box said "for a while"; the success message then said the number.
 * Two statements of one fact — this holds them together.
 */
describe("Leave", () => {
  it("names the cooldown before the player commits", () => {
    expect(renderToStaticMarkup(<LeaveForm />)).toContain(`I understand I cannot join a clan again for ${days(ROSTER_COOLDOWN_MS)} after leaving.`);
  });
  it("in the same words the success message uses", () => {
    expect(TABLES.leave.ok).toContain(days(ROSTER_COOLDOWN_MS));
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/leave-form.test.tsx`
Expected: FAIL — `Failed to resolve import "../app/(site)/clan/leave-form"`.

- [ ] **Step 3: Implement**

`apps/web/app/(site)/clan/leave-form.tsx`:

```tsx
import { ROSTER_COOLDOWN_MS } from "@factions/domain";
import { days } from "@/lib/format";
import { SubmitButton, btnDanger, checkbox } from "@/app/components/ui";

/**
 * The Leave panel's form. L2: the cooldown is a number BEFORE the player
 * commits, from the same rule the success message reads (packages/copy
 * src/clan.ts LEAVE.ok); test/leave-form.test.tsx holds the two together.
 */
export function LeaveForm() {
  return (
    <form action="/api/clan/leave" method="post">
      <label className="flex min-h-[44px] items-start gap-3 text-sm leading-relaxed text-ink-2">
        <input type="checkbox" name="confirm" value="yes" required className={`${checkbox} mt-0.5`} />
        {`I understand I cannot join a clan again for ${days(ROSTER_COOLDOWN_MS)} after leaving.`}
      </label>
      <SubmitButton className={`mt-3.5 ${btnDanger}`} pending="Leaving…">Leave the clan</SubmitButton>
    </form>
  );
}
```

`apps/web/app/(site)/clan/page.tsx`:
- Add `import { LeaveForm } from "./leave-form";` after the `RowAction` import.
- Replace
  ```tsx
                  <form action="/api/clan/leave" method="post">
                    <label className="flex items-start gap-3 text-sm leading-relaxed text-ink-2"><input type="checkbox" name="confirm" value="yes" required className={`${checkbox} mt-0.5`} /> I understand I cannot join a clan again for a while after leaving.</label>
                    <SubmitButton className={`mt-3.5 ${btnDanger}`} pending="Leaving…">Leave the clan</SubmitButton>
                  </form>
  ```
  with `<LeaveForm />`.

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/leave-form.test.tsx test/submit-once.test.ts test/clan-copy.test.ts` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add "apps/web/app/(site)/clan/leave-form.tsx" "apps/web/app/(site)/clan/page.tsx" apps/web/test/leave-form.test.tsx
git commit -m "$(cat <<'EOF'
fix(web): Leave says how many days before you can join again, before you press it

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 21: L9 — no polling in a background tab; the hero's clan read runs beside the page's own

**Files:**
- Create: `apps/web/lib/visible-poll.ts`
- Modify:
  - `apps/web/app/(site)/kit/kit-flow.tsx`: the poll effect (original lines 96–100) and imports
  - `apps/web/app/(site)/link/link-flow.tsx`: the poll effect (the `useEffect` under "⚠️ Poll only while a challenge is open") and imports
  - `apps/web/app/(site)/clan/vault/page.tsx`: the two reads (the final file from Task 8)
  - `apps/web/app/(site)/clan/board/page.tsx:26-29,41-42`
  - `apps/web/app/(site)/clan/board/[board]/page.tsx:30,42`
- Test: `apps/web/test/visible-poll.test.ts`

⚠️ No em dash in `kit-flow.tsx`.

**Interfaces:**
- Produces: `type PollDoc = EventTarget & { readonly hidden: boolean }`
- Produces: `visiblePoll(doc: PollDoc, run: () => void, ms: number): () => void`

- [ ] **Step 1: Write the failing test** — `apps/web/test/visible-poll.test.ts`

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { visiblePoll } from "../lib/visible-poll";

class FakeDoc extends EventTarget { hidden = false; }
const flip = (doc: FakeDoc, hidden: boolean) => { doc.hidden = hidden; doc.dispatchEvent(new Event("visibilitychange")); };

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe("visiblePoll (L9)", () => {
  it("polls on its interval while the tab is visible", () => {
    const run = vi.fn();
    visiblePoll(new FakeDoc(), run, 1000);
    vi.advanceTimersByTime(3000);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it("⚠️ stops while the tab is hidden, and catches up at once on return", () => {
    const run = vi.fn();
    const doc = new FakeDoc();
    visiblePoll(doc, run, 1000);
    flip(doc, true);
    vi.advanceTimersByTime(60_000);
    expect(run).not.toHaveBeenCalled();
    flip(doc, false);
    expect(run).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1000);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("starts paused in a tab that opened in the background", () => {
    const run = vi.fn();
    const doc = new FakeDoc();
    doc.hidden = true;
    visiblePoll(doc, run, 1000);
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });

  it("stops for good once disposed", () => {
    const run = vi.fn();
    const doc = new FakeDoc();
    visiblePoll(doc, run, 1000)();
    flip(doc, false);
    vi.advanceTimersByTime(5000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("the pages that poll use it", () => {
  const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "app", "(site)", ...p), "utf8");
  it.each([["kit", "kit-flow.tsx"], ["link", "link-flow.tsx"]])("%s/%s", (...p) => {
    const text = read(...p);
    expect(text).toContain("visiblePoll(document,");
    expect(text).not.toMatch(/setInterval\(\(\) => \{ void refresh\(\); \}/u);
  });
});

describe("the hero's clan read runs beside the page's own (L9)", () => {
  const read = (...p: string[]) => readFileSync(join(import.meta.dirname, "..", "app", "(site)", "clan", ...p), "utf8");
  it.each([["vault", "page.tsx"], ["board", "page.tsx"], ["board", "[board]", "page.tsx"]])("%s", (...p) => {
    expect(read(...p)).toMatch(/await Promise\.all\(\[[^\]]*clanFor\(session\.sub\)\]\)/u);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `cd apps/web && npx vitest run test/visible-poll.test.ts`
Expected: FAIL — `Failed to resolve import "../lib/visible-poll"`.

- [ ] **Step 3: Implement**

`apps/web/lib/visible-poll.ts`:

```ts
/** The two things a poll reads from `document`: whether it is hidden, and the event that says it changed. */
export type PollDoc = EventTarget & { readonly hidden: boolean };

/**
 * Run `run` every `ms` while the page is visible (L9).
 *
 * ⚠️ /link and /kit poll every 5 s while a sequence is open, and a player
 * performing it is IN GAME, so that tab is almost always in the background.
 * Each poll is a database read for nobody. This stops while hidden and runs
 * once immediately on return, so a confirmation that landed while they were
 * away shows the moment they look.
 */
export function visiblePoll(doc: PollDoc, run: () => void, ms: number): () => void {
  let id: ReturnType<typeof setInterval> | null = null;
  const start = () => { if (id === null) id = setInterval(run, ms); };
  const stop = () => { if (id !== null) { clearInterval(id); id = null; } };
  const onChange = () => {
    if (doc.hidden) { stop(); return; }
    run();
    start();
  };
  if (!doc.hidden) start();
  doc.addEventListener("visibilitychange", onChange);
  return () => { stop(); doc.removeEventListener("visibilitychange", onChange); };
}
```

`apps/web/app/(site)/kit/kit-flow.tsx`:
- Add `import { visiblePoll } from "@/lib/visible-poll";` after the `dismiss-timer` import.
- Replace
  ```tsx
    useEffect(() => {
      if (!view.challenge) return undefined;
      const id = setInterval(() => { void refresh(); }, POLL_MS);
      return () => clearInterval(id);
    }, [view.challenge?.id, refresh]);
  ```
  with
  ```tsx
    useEffect(() => {
      if (!view.challenge) return undefined;
      // L9: paused while the tab is hidden, which is most of the time a player is in game performing the sequence.
      return visiblePoll(document, () => { void refresh(); }, POLL_MS);
    }, [view.challenge?.id, refresh]);
  ```

`apps/web/app/(site)/link/link-flow.tsx`:
- Add `import { visiblePoll } from "@/lib/visible-poll";` after the `link-claim` import.
- Replace
  ```tsx
    useEffect(() => {
      if (!status.challenge) return;
      const id = setInterval(() => { void refresh(); }, POLL_MS);
      return () => clearInterval(id);
    }, [status.challenge?.id]);
  ```
  with
  ```tsx
    useEffect(() => {
      if (!status.challenge) return undefined;
      // L9: paused while the tab is hidden; the player is in game performing the emotes.
      return visiblePoll(document, () => { void refresh(); }, POLL_MS);
    }, [status.challenge?.id]);
  ```

`apps/web/app/(site)/clan/vault/page.tsx` (the Task 8 file):
- Replace `const view = await vaultFor(session.sub);` with
  ```tsx
    // L9: the hero's clan read runs BESIDE the vault's own, not after it. It is still two
    // reads (vaultFor answers only for the vault); what this removes is the serial wait.
    const [view, clan] = await Promise.all([vaultFor(session.sub), clanFor(session.sub)]);
  ```
- Delete the later line `const clan = await clanFor(session.sub);`.

`apps/web/app/(site)/clan/board/page.tsx`:
- Replace `const boards = await clanBoard(session.sub, parsed === "default" ? { kind: "current" } : parsed, BOARD_TOP);` with
  ```tsx
    // L9: the hero's clan read runs beside the board read rather than after it.
    const [boards, view] = await Promise.all([clanBoard(session.sub, parsed === "default" ? { kind: "current" } : parsed, BOARD_TOP), clanFor(session.sub)]);
  ```
- Delete the two lines `// The hero's data. A board exists only for a full member, so this is a ClanView on every path that reaches here.` and `const view = await clanFor(session.sub);`.

`apps/web/app/(site)/clan/board/[board]/page.tsx`:
- Replace `const page = await clanBoardPage(session.sub, kind, parsed === "default" ? { kind: "current" } : parsed, parsePageParam(rawPage));` with
  ```tsx
    // L9: the hero's clan read runs beside the board read rather than after it.
    const [page, view] = await Promise.all([clanBoardPage(session.sub, kind, parsed === "default" ? { kind: "current" } : parsed, parsePageParam(rawPage)), clanFor(session.sub)]);
  ```
- Delete the later line `const view = await clanFor(session.sub);`.

- [ ] **Step 4: Run to pass, then typecheck**

Run: `cd apps/web && npx vitest run test/visible-poll.test.ts test/kit.test.ts test/board-page.test.ts test/vault-forms.test.tsx` — all pass.
Run: `cd apps/web && npx tsc --noEmit` — clean.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/visible-poll.ts "apps/web/app/(site)/kit/kit-flow.tsx" "apps/web/app/(site)/link/link-flow.tsx" "apps/web/app/(site)/clan/vault/page.tsx" "apps/web/app/(site)/clan/board/page.tsx" "apps/web/app/(site)/clan/board/[board]/page.tsx" apps/web/test/visible-poll.test.ts
git commit -m "$(cat <<'EOF'
perf(web): no polling in a background tab; the hero's clan read runs beside the page's own

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 22: CHANGELOG and the full gate

**Files:**
- Modify: `CHANGELOG.md` (under `## [Unreleased]`, line 6)

- [ ] **Step 1: Add the entry** — insert after `## [Unreleased]` (line 6), with a blank line either side:

```markdown
### Fixed

- Notifications: something both sent to you and posted to your clan, such as your own
  achievement unlock, is listed once, not twice.
- Signed-in forms send once. Double-tapping "Found the clan", Leave, Disband, Invite or
  any two-press button no longer posts twice. A founder whose second tap arrived after
  the clan was created lands on their clan instead of a "not found" page.
- A refused form keeps what you typed: the claim form, including which founders you
  unticked; rename; invite; guest pass; and the vault's add and edit forms. A vault code
  is never carried back.
- A refused vault edit reopens that lock's form, with the reason inside it.
- On the claim page, a flag or roster refusal moves focus to that section.
- Pressing charges on /base keeps keyboard focus on the confirm step and announces the
  result.
- /link: typing a whole gamertag and pressing Claim straight away now finds it, and Enter
  claims. A failed request says so instead of doing nothing.
- The /notifications filter now covers every page, not just the one on screen.
- The kit's Undo stays for ten seconds, and stays while you point at it or focus it.
- Buttons and filters on /notifications, and the vault's "Hide now", are full-size tap
  targets.

### Changed

- Two-press buttons turn gold when armed and say "Press again to …".
- Moving the clan's base takes a second press, as releasing one already did.
- Guest passes are listed by the guest's gamertag.
- Leave states the rejoin cooldown in days before you confirm.
- Sign-in steps are numbered 1 to 3 throughout. Countdowns on phones say "left".
- Refusals on /link, /kit and /base are no longer drawn in rust, which marks only an
  open obligation.
- /link and /kit stop checking for emote confirmations while their tab is in the background.
```

- [ ] **Step 2: Run the full gate from the repo root**

Run:
```bash
TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
  npx turbo run typecheck test --concurrency=1 --force
```
Expected: `Tasks: 30 successful, 30 total`. Count the tasks, not the exit code. Nothing else may be running `vitest` or `turbo run test` at the same time: they share `factions_test_<package>`.

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "$(cat <<'EOF'
docs(changelog): forms and signed-in tools UX fixes

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
)"
```

Then `keel:finish-work` to open the PR. The `changelog` check reads the **committed** `CHANGELOG.md`.

---

## Self-review

| Finding | Task | Notes |
|---|---|---|
| D1 | 1 | Duplicate confirmed by code reading. The channel copy is deduped against the viewer's own DM in `VISIBLE`, with three DB-backed tests. |
| H1 | 2, 3, 4 | `SubmitButton` + guard (2). `ConfirmButton` posts once (3). Wired into every signed-in form, and a repeated claim lands on `/clan` (4). |
| H2 | 5, 6, 7, 8 | One mechanism, `kept.*` query params via `lib/form.ts` (5), applied to claim (6), rename/invite/guest (7) and vault add/edit (8). `code` is excluded in both directions. |
| H3 | 6 | Autofocus on the first flag / first untickable founder, with the fieldset described by the error. |
| H4 | 9 | Focus moves on every branch change, and one always-mounted live region. |
| H5 | 10 | `resolveTyped` searches again when the list is stale; a real `<form>`, so Enter works. |
| M1 | 10 | `readJson` guards `start`, `cancel` and `refresh`; `cancel` checks `res.ok`. |
| M2 | 11 | `btnSecondary`. |
| M3 | 13 (+12) | `RowAction` with `who`, covering roster rows, requests, withdraw, revoke and Declare. |
| M4 | 3 | Gold armed look, "Press again to …" labels, and a screen-reader hint while armed. |
| M5 | 12 | `OpenGuestPass.userGamertag`, plus `GuestPassList`. |
| M6 | 14 | Two-press "Move here". |
| M7 | 15 | Chips, actions, Mark all read, and Hide now at 44px. **The bell panel's "Mark all read" is not changed:** the SHELL/PUBLIC plan owns that panel. |
| M8 | 16 | Kind filter in SQL (`notificationsForDb` `kinds`) and `kindsInGroup`. |
| M9 | 18 | 10 s, held while hovered or focused, restarted on release. |
| M10 | 8 | `autoComplete="off"`, `data-1p-ignore`, `data-lpignore`, and no value prop. |
| M11 | 8 | `lock` kept on edit refusals; that lock's `<details>` opens with the error inside. |
| L1 | 9, 11, 19 | report-button (9), link-flow (11), kit (19). |
| L2 | 20 | `LeaveForm` names `days(ROSTER_COOLDOWN_MS)`, pinned to `LEAVE.ok`. |
| L3 | 9 | `checkbox` class, 44px rows. |
| L4 | 6 | Legend first, `alt=""`, check glyph. |
| L5 | 11 | "Step 1 of 3 — sign in / join the Discord", "Step 2 … name your character", "Step 3 … prove it". |
| L6 | 11, 19 | "left" suffix on phones; decorative bullets `aria-hidden`. |
| L7 | 19 | Card under the h1, 11px floor, rule-3 tiles. |
| L8 | 17 | `Page` + `PageHead` + `BackLine`; `SessionLost` instead of a streamed `redirect()`. |
| L9 | 21 | Polling pauses while hidden, and the vault/board hero reads run in parallel. **Not changed:** `OwnClanHero`'s whole-`scoreboard()` read (see below). |

**Deliberately not fixed:**

- **L9, `OwnClanHero` reading the whole scoreboard.**
  - Why it stays: the scoreboard is one query over one server's clans, tens of rows. A single-clan rank query would restate the ranking rule (active and points > 0; points desc, times raided asc, activated_at asc, id asc) in a second place. `scoring.test.ts` pins that rule in one place today (CLAUDE.md: "Two statements of one fact will drift").
  - What Task 21 does instead: the vault and board pages now run their two reads side by side. Nothing is added to the query count.
- **M7, the bell panel's "Mark all read".** It lives in the notifications-bell panel, which the SHELL/PUBLIC plan owns.

**Review Focus coverage:** item 1 → Task 3; item 2 → Tasks 5 and 6; item 3 → Tasks 5 and 8; item 4 → Task 2; item 5 → Task 4.

---

## Appendix: findings

Reproduced verbatim from the 2026-09-24 review. Paths are relative to `apps/web`.

### High
H1. No pending state on plain-HTML form POSTs → double-tap submits twice. E.g. claim/[ceremony]/page.tsx:97 "Found the clan", clan/settings/page.tsx:134 Disband, clan/page.tsx:224 Leave, :112 Invite, :142 Accept. ConfirmButton (components/confirm-button.tsx:23-24) returns early only while unarmed — once armed every tap submits. Claim page harm: first POST founds, second gets no-such-ceremony → back to /claim/{id} → notFound() (page.tsx:25): founder lands on 404 though founding worked. Fix: shared client SubmitButton using useFormStatus (or onSubmit setting disabled + aria-busy, label e.g. "Founding…"); ConfirmButton disables itself after the submitting click.

H2. Refused forms discard typed input. claim/[ceremony]/page.tsx:44,48,63,83 name/tag/flag/roster have no defaultValue/defaultChecked from rejected POST — "name taken" means redo all four panels; unticked founders come back ticked. clan/settings/page.tsx:86-87 Rename resets to defaultValue={clan.name} so "Another clan has that name." sits under the current name. Vault Add form (clan/vault/page.tsx:136-143) re-opens empty. Fix: echo rejected non-secret values back (e.g. query params on the 303 via lib/form.ts, length-capped; NEVER the vault code) and use as defaultValue; at minimum name the refused value in the error.

H3. Claim page: flag/roster error gets no focus, never announced. For err.field "texture"/"member", Notice gets focus={false} (claim/[ceremony]/page.tsx:36) and invalid() is never spread onto radios/checkboxes (:63,:83) → no autoFocus. Fix: tabIndex={-1} on the fieldset and focus it when it carries the error, or keep Notice focus for those two.

H4. Ban-confirm (base/report-button.tsx:79-94): pressing "Press charges" replaces the component with the armed branch; focused button unmounts → focus to <body>; keyboard user must find "Confirm — press charges" within 8s (ARM_MS). Same on Cancel and "done". Armed block's role=status inserted with its content (unreliably announced). Fix: ref+focus Confirm when armed; return focus to "Press charges" on Cancel/timeout; one always-mounted live region for the result.

H5. Link flow search races debounce: claim() (link/link-flow.tsx:114-120) matches typed text against `matches`, refreshed 200ms after each keystroke (:102). Type full gamertag + tap "Claim it" before fetch returns → "The server has not seen that character…" in a rust box. Input not in a <form> (:132) → Enter does nothing. Fix: wrap in <form onSubmit>; on submit, if list stale, await fresh /api/link/search before deciding.

### Medium
M1. link-flow.tsx:57 `await res.json()` no catch (500/HTML throws, player sees nothing); cancel() (:73) ignores res.ok. Fix: like kit-flow.tsx post(): catch, check ok, show "did not save".

M2. Verified screen "Your page" button (link-flow.tsx:229) built via btnPrimary.replace("bg-gold",…) leaving hover:bg-gold-hover → hover text-ink on #e6b04f = 1.52:1; edge border-rule-2 (1.34:1) vs rule-3 for controls. Fix: btnSecondary.

M3. Repeated row buttons don't say who: "Remove / Make officer / Demote" (clan/page.tsx:97-100), "Accept / Decline" (:142-143), "Withdraw" (:121), "Revoke" (settings/page.tsx:74), "Declare" (base/page.tsx:141). Fix: sr-only gamertag inside RowAction and others.

M4. Two-press confirm unexplained: on /clan ConfirmButton just relabels to "Remove them?", no visual change, no hint that a second press within 4s is needed, silently disarms. Only vault explains (vault/page.tsx:124). Fix: distinct armed look (bg-rust/15? — careful, rust is for obligations; prefer ink border / gold), label "Press again to remove", aria-describedby hint.

M5. Guest passes listed by raw Discord ID: settings/page.tsx:73 renders p.userDiscordId and p.grantedBy (18-digit, per packages/roster/src/internal/guest-store.ts:19). Fix: resolve to gamertags / Discord names in OpenGuestPass.

M6. "Move here" (settings/page.tsx:120) one tap moves base, starts 7-day cooldown and old pole grace — no confirm. Fix: ConfirmButton confirm="Move the base?" as Release does.

M7. Under-44px controls: notifications/page.tsx:49 filter chips min-h-[34px]; :56 "Mark all read" min-h-[38px]; notifications/actions.tsx:13 Accept/Decline/"Cast your vote" min-h-[38px]; vault/reveal-button.tsx:62 "Hide now" no min-height (~16px). Also live: the bell panel's "Mark all read" measured 113×17. Fix: min-h-[44px] / reuse btnPrimary/btnSecondary.

M8. Notifications filter only filters current page: notifications/page.tsx:36 filters feed.rows after paging → "Nothing in this filter on this page." while page 2 has matches; pager counts unfiltered. Fix: pass group to notificationsFor, filter in SQL.

M9. Kit Undo disappears after 4.5s (kit-flow.tsx flash: setTimeout(…,4500)) — WCAG 2.2.1. Fix: don't dismiss while focused/hovered; ≥10s or until next pick.

M10. Vault code input (vault/page.tsx:143) name="code" inputMode numeric but no autoComplete="off" → browsers save in form history, offer dropdown on focus (stream leak the page comments guard against). Fix: autoComplete="off" (or one-time-code) + data-1p-ignore / data-lpignore.

M11. Refused vault edit (vault/page.tsx:38) goes to the top notice only; the lock's <details> (:98) comes back closed and reverted. Fix: &lock=<id> in redirect; open that details and show the error inside it.

### Low
L1. Rust used for plain refusals contradicting house rule (sign-in-card.tsx:10-12 says a refusal is not rust): link-flow.tsx:237 ("Not issued": border-rust, role=alert), kit-flow.tsx:260 (refusal Bar tone="rust"), report-button.tsx:91,120 (text-rust-2 errors). Fix: border-rule-3 + text-ink.

L2. Leave checkbox (clan/page.tsx:223) "I cannot join a clan again for a while" vague; success message (packages/copy/src/clan.ts:65) gives days(ROSTER_COOLDOWN_MS). Fix: state the number before commit.

L3. Ban checkboxes (report-button.tsx:102-103) browser-default size, no `checkbox` class, label rows ~20px. Fix: checkbox class + min-h-[44px].

L4. claim/[ceremony]/page.tsx:77-78 FieldError rendered before <legend> (legend must be first child); :64 alt={f} repeats visible span label → alt=""; chosen flag shown by border colour only (has-[:checked]:border-gold) → add check glyph / thicker border.

L5. Step labels: login "Step 1 of 3", link "Step 2 of 3"/"Step 3 of 3", but /join between them says "One step left" (join/page.tsx:28). Fix: consistent numbering.

L6. Countdown unlabelled on phones: link-flow.tsx:187 and kit/sequence-card.tsx:36 hide "Expires in" below lg → bare "23 h 12 min"/"4:07"; decorative ●/• (link-flow.tsx:186, sequence-card.tsx:33) read aloud. Fix: short "left" suffix; aria-hidden bullets.

L7. Kit page: SequenceCard's <h2> renders above page <h1> "Your kit"; slot labels text-[9px] (CONFIRMED LIVE: "Jacket | Pants | Backpack…" at 9px), save state text-[10px]; tile edges border-rule-2 (1.34:1). Fix: card below h1, 11px floor, rule-3 tiles.

L8. notifications/page.tsx:52 own <main> without mx-auto (hugs left on wide screens); one-off 34px h1; <Notice> at :63 no top margin; no BackLine; :26 redirect() inside streamed page (me/route.ts:13-17 warns it becomes meta-refresh). Fix: Page + PageHead.

L9. Heavy reads/polling: OwnClanHero (own-clan-hero.tsx:21) loads whole scoreboard() to find one row on every clan tab; vault and board pages call clanFor again after own read; link and kit pages poll every 5s in background tabs. Fix: single-clan standing read; pause polling when document.hidden.

### NEW (seen live)
D1. Signed-in bell showed "Unlocked: Veteran — RonaldRaygun552 unlocked it. Play for … hours" TWICE, both 3d old. Investigate: packages/roster/src/notifications.ts notificationsForDb is a union of the viewer's DMs and their clans' channel notices; the achievements tick (apps/bot/src/achievements/) may queue both a DM and a clan-channel notice for one unlock. If so, dedupe (with a test); if they're legitimately two events, document it.

### Working well (keep)
Token contrast passes; invalid()/FieldError give aria-invalid/describedby/focus; Notice takes focus on load; emote-sequence progress told in words; kit PickSheet is a proper modal (Tab trap, Escape, scroll lock, focus return); destructive actions use required checkbox or two-press; reduced motion honoured.
