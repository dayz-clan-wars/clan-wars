# Web frontend rebuild — Tailwind, and the site as the player interface — design

**Date:** 2026-09-04
**Covers:** the presentation half of `docs/direction/2026-09-02-web-app-and-faction-map.md`
**Builds on:** Discord login (`2026-09-04-discord-login-design.md`), which established
*who you are* and deliberately left *what you may do* untouched. This begins the latter.
**Changes a documented invariant.** See §2. Read that section before anything else.

---

## 1. Purpose

The site is to become the place players do the things they need: see teammates on a map,
manage a faction roster, link a gamertag. Today it is two fixture prototypes behind a
working login, styled in CSS modules, showing nobody any real data.

This design covers the **rebuild of the presentation layer** and settles the two
structural questions the work cannot proceed without — what the site is allowed to
write, and how it reaches the data. It then scopes the **first increment** narrowly:
Tailwind, the home page, and the real login screens. No data path is built here.

### In scope

- Tailwind v4 replacing the CSS modules, carrying the existing palette and faces forward
- Deleting the fixture prototypes (`/mobile`, `/link`) after mining their design language
- Rebuilding the landing page and the `/login` + `/join` screens against existing auth
- Settling the write-access boundary (§2) and the data-path shape (§3) *as decisions*

### Out of scope, deliberately

- **Building the data path.** `packages/roster` is specified in §3 and built in a later
  increment. `apps/web` still imports no database package when this increment ships, and
  `smoke.test.ts` still holds that line literally — see §6.
- **Any roster, map or faction screen.** The signed-in home page is a placeholder.
- **Faction creation from the web.** Ruled out permanently by §2, not merely deferred.
- **Deployment.** A separate, deliberate step, as every deploy here is.

---

## 2. The invariant, narrowed

`CLAUDE.md` states:

> **The website is a surface, never a source of truth.** Faction state is earned in game
> and proved from the server's logs; nothing on `dayzclanwars.com` may create a faction,
> claim a flag, bind a pole or alter a roster.

**"or alter a roster" is removed. Everything else stands, and stands harder.**

The rule becomes: **rituals are earned in game; administration is not a ritual.**

- **Still forbidden from the web, permanently:** creating a faction, claiming a flag,
  binding or rebinding a pole. These are proved from the server's own ADM logs because
  standing at a flagpole is what makes an identity worth holding. A faction that could be
  founded from a web form would not be the same thing.
- **Now permitted from the web:** invite, kick, promote, demote. These were never earned
  by anything — they are chores that Discord slash-commands serve badly.

⚠️ This narrowing is a **product decision, deliberately taken on 2026-09-04**, not an
oversight and not a drift. `CLAUDE.md` records at least two invariants that were later
found to be wrong and one (public rosters) that a past version wrongly listed as a gap;
this entry exists so a future reader does not "restore" the wider rule as a bug fix. The
wider rule was correct when the site could show nobody anything. It stopped being correct
when the site became where players are.

⚠️ The narrowing does **not** weaken the guard. §6 replaces a test about *location* with a
test about *capability*, which is strictly stronger: the old test permitted any database
operation whatsoever so long as it happened elsewhere.

---

## 3. The data path — a capability package

`apps/web` will import `@factions/roster` and never `@factions/db`.

`packages/roster` exports **only** the operations the web is permitted to perform:

- Reads: the caller's factions, a roster, the public directory, the feed, map state
- Writes: `invite`, `revokeInvite`, `kick`, `promote`, `demote`

It exports **no** faction-creation, flag-claim or pole-bind function. Not a guarded one,
not a privileged one — none. That absence is the enforcement mechanism, and §6 tests it.

⚠️ **Why a package and not an HTTP service.** A separate `apps/api` would preserve
`smoke.test.ts` verbatim, and was rejected: `web` and `postgres` already share the compose
default network, so the network boundary prevents nothing that the missing export does not
prevent better, while costing a service, a deploy step and hand-written types on both
sides. `CLAUDE.md` already records this reasoning for the container boundary — "the
container is not a second guard" — and it applies identically here.

⚠️ **Lock order is inherited, not restated.** `packages/roster` writes the roster tables
and is therefore bound by the existing order: `factions` → `faction_members` →
`faction_invites` → `faction_events`. A deadlock was already built here once from two
separately-correct changes. The package is a **fifth writer**, and the first one not
running inside the bot process.

⚠️ **`faction_events` rows are written in the transition's own transaction.** Every write
`packages/roster` performs must append through `appendFactionEventTx`, which takes a `Tx`
rather than a `Database` precisely so this is hard to get wrong. A roster change made from
the web that does not appear in the feed is indistinguishable from one that never
happened — the transition's own evidence is what the log preserves.

⚠️ **Two roster writers, one feed order.** The feed posts in `id` order and stops at the
first failure. Web writes and bot writes now interleave in that queue. This is safe — the
queue is ordered by `id`, not by origin — but it means **a web-originated event can block
the bot's feed**, and the only signal is one error-level `feed queue blocked at …` line,
which already has no alerting (known-open item 4, inbox item 35).

**None of this is built in the first increment.** It is specified here because §2's
decision is meaningless without knowing what enforces it.

---

## 4. Design language

The prototypes are deleted, but they carry a real design system ported from a design
canvas, and it is carried forward rather than reinvented.

**Palette** (13 tokens, from `auth.module.css` / `mobile.module.css`):

| Token | Value | Role |
|---|---|---|
| `--color-ink` | `#e8e2d4` | primary text |
| `--color-ink-2` | `#b5afa4` | secondary text |
| `--color-muted` | `#8a857c` | labels, captions |
| `--color-dim` | `#6e6a62` | disabled, least emphasis |
| `--color-frame` | `#0b0b0a` | card ground |
| `--color-surface` | `#131211` | raised surface |
| `--color-rule` | `#1a1917` | hairline border |
| `--color-rule-2` | `#2a2825` | stronger border |
| `--color-gold` | `#d9a03c` | accent, the brand |
| `--color-rust` | `#8c3a22` | outstanding obligation — see below |
| `--color-olive` | `#8fa36a` | affirmative state |
| `--color-terrain` | `#111110` | map ground |
| page ground | `#050505` | below `--color-frame`, deliberately |

⚠️ **The landing page is currently off-brand and this fixes it.** `globals.css` uses
`#0e1013 / #c9a227 / #e8e6e3`; the prototypes use `#050505 / #d9a03c / #e8e2d4`. Two
palettes, neither aware of the other, differing by about two shades of gold — which looks
like a design choice and gets reported by nobody. The rebuild unifies on the canvas
palette.

⚠️ **`--color-rust` means an outstanding obligation and nothing else** — a challenge
pending or expired. It is the one persistent cue that a player still owes the server
something, and using it as a generic "error" or "danger" colour empties it of meaning.
This rule survives the port; it was previously enforced only by a comment on
`.cardOutstanding`.

**Faces.** `app/fonts.ts` is kept **unchanged** — three faces self-hosted at build time by
`next/font`, for the reason its own docblock gives: a failed CDN fetch would not degrade
the shell, it would erase the distinction between a display heading and a mono caption,
which is most of what tells the screens apart. They wire into `@theme` as
`--font-display` (Archivo Black), `--font-sans` (Archivo), `--font-mono` (Space Mono).

**Touch minimums.** 44 / 52 / 56px, the canvas's, unchanged.

---

## 5. What is deleted, and what is kept

**Kept, untouched:** `lib/auth/*` (all eight modules), `middleware.ts`, their seven test
files, `app/fonts.ts`, `app/api/auth/*`, `src/flag-images.ts`.

⚠️ Four of the six login commits are **bug fixes** — a kicked-member redirect loop, a
sliding session expiry, a login that routed to `/join` on an unreachable Discord, a
next-path carrying a fragment. That is earned knowledge and none of it is visible in the
happy path. "Scrap the frontend" means the presentation layer; it does not reach `lib/`.

**Deleted:** `app/mobile/` (14 files, its stylesheet included), `app/link/` (10 files),
`app/components/sign-in-card.tsx`, `app/auth.module.css`,
and the `.landing` / element rules in `globals.css`.

**Rebuilt:** `app/page.tsx`, `app/login/page.tsx`, `app/join/page.tsx`, `app/layout.tsx`.

---

## 6. Tests

**`palette-drift.test.ts` is deleted.** ⚠️ It exists because the palette is stated twice,
in two scope-isolated CSS modules that cannot see each other. Under `@theme` it is stated
**once, for the whole app**. The test goes because the drift it catches becomes impossible
to express — not because the drift stopped mattering. Its docblock's reasoning is the
reason `@theme` is the right home for the palette, and is preserved in §4 above.

**`theme-tokens.test.ts` is added.** The `@theme` block must declare every token §4 lists.
A token dropped during the port is a silent failure: one screen renders in a browser
default and looks merely plain.

**`smoke.test.ts` is extended, not weakened.** This increment adds no data path, so
"imports no database package" still holds **literally** and stays as-is. Its `ROOTS` list
is extended to catch a root-level `tailwind.config.ts` — ⚠️ that list has silently missed a
new directory twice already, which its own docblock records; a config file scanned by
nothing is exactly the hole it keeps falling into.

**Later increment, when `packages/roster` lands:** the test is rewritten to the capability
rule — `apps/web` imports no database package *and* `@factions/roster` exports no
faction-creation, flag-claim or pole-bind function. Deliberately not done now: weakening
the literal rule a week before the narrower one has anything to guard trades a real test
for a placeholder.

**`flag-assets.test.ts` and `flag-images.test.ts`** are untouched — the 33 flag images and
`CLAIMABLE_FLAGS` remain two statements of one fact.

---

## 7. The static-rendering trap

⚠️ `middleware.ts` gates **routes, not content**. The matcher excludes `/_next/static`, so
a gated page's build-time HTML and data sit in a static chunk that anyone can fetch, gate
or no gate. Harmless today because every gated page is an invented fixture.

The signed-in home page is **the first page where this stops being harmless** — it renders
the viewer's Discord identity. It is therefore rendered from the session **at request
time**, after the middleware has run, never baked at build time.

This is recorded here rather than left in the middleware docblock because the next
increment puts real faction data on these pages, and the trap will still be there, with no
error, log line or test to catch it.

---

## 8. First increment — scope

Ships a complete, deployable slice:

1. Tailwind v4 installed; `@theme` block carrying §4's palette and faces
2. CSS modules and fixture prototypes deleted
3. Landing page rebuilt — the pitch, the Discord CTA, the login entry
4. `/login` and `/join` rebuilt from `sign-in-card.tsx`'s structure, keeping the 390px
   card and the touch minimums
5. Signed-in home: a placeholder rendering the viewer's Discord identity and a note that
   player tools land here

⚠️ The placeholder shows **no fake dashboard cards**. Empty states for features that do
not exist read as features that are broken, and the site's whole claim is that what it
shows is true.

**Verification:** the full gate at 22/22 tasks —

    TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions" \
      npx turbo run typecheck test --concurrency=1 --force

— plus `pnpm --filter @factions/web build`, because Tailwind's compile step is new and the
Docker build is where it would first fail otherwise.

**Not deployed by this increment.** A separate step, deliberately.

---

## 9. Consequences for `CLAUDE.md`

On merge, `CLAUDE.md` needs: the §2 narrowing recorded against the "surface, never a
source of truth" bullet, `packages/roster` named as the fifth roster writer under the lock
order, and the `palette-drift.test.ts` line replaced by `theme-tokens.test.ts` under "two
statements of one fact will drift".
