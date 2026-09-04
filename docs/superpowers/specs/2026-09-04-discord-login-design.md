# Discord login — gating the site — design

**Date:** 2026-09-04
**Covers:** the authentication half of `docs/direction/2026-09-02-web-app-and-faction-map.md`
**Builds on:** the web app skeleton (`2026-09-03-web-app-skeleton-design.md`), which
excluded "Discord OAuth, sessions, any authentication" and said it gets its own design.
This is that design.
**Blocks:** every data-driven page. A faction map that shows base coordinates cannot be
built before there is a way to know who is looking at it.

---

## 1. Purpose

`dayzclanwars.com` is public and shows nobody anything. The two screens that exist —
`/mobile` and `/link` — are fixtures precisely because there is no way to tell one visitor
from another, so there is nothing safe to show.

This establishes **who you are**, and nothing else. It does not establish what you are
entitled to see: no faction data is read, no roster is consulted, no coordinate is
rendered. That is deliberate. Identity is the smaller half of the problem and it is the
half everything else waits on.

### In scope

- Discord OAuth (authorization code) as the only way in
- An encrypted session cookie, 7 days, holding identity only
- Guild membership as the gate, re-checked periodically against Discord
- A consented "Join and continue" path for players not yet in the guild
- Middleware gating every route except the front door and the auth endpoints

### Out of scope, deliberately

- **Any database access.** `apps/web` still imports no database package and reads no
  `DATABASE_URL`. `apps/web/test/smoke.test.ts` continues to hold that line, and this
  design extends that test rather than weakening it (§6).
- **Linking a character.** Being in the guild is not the same as having completed
  `/link`, and this gate does not check the latter. `/link` stays a fixture prototype.
- **Authorization of any kind.** No roles, no faction scoping, no per-page rules. Every
  authenticated guild member sees exactly what every other one sees, which today is the
  same fixtures they saw before.
- **The direct-Postgres vs bot-API question.** The direction note's biggest open question
  stays open, untouched, because nothing here needs an answer to it.

---

## 2. Decisions

### 2.1 The gate is guild membership, not a linked character

Three bars were available: any Discord account, a member of the Clan Wars guild, or a
player who has completed `/link`.

"Any Discord account" is not a gate — every Discord account on earth passes it, so it
stops crawlers and nothing else. "A linked character" is the real identity the direction
note means, but it requires reading `discord_links`, which is the one thing this app is
built not to do; taking it now would force the Postgres-vs-API decision as a side effect
of building a login.

**Guild membership is the useful middle.** It is a real filter, it is a fact Discord will
answer for us, and it needs no database. When a page finally needs to know *which
faction* you are in, that is a separate design with a separate decision about where the
data comes from.

### 2.2 A non-member is offered a join, not refused

Refusing a non-member is the hardest gate and the least useful: a real player who found
the site legitimately would have no way forward.

Instead, a signed-in non-member lands on `/join` with a **"Join and continue" button**
that adds them to the guild. It is a button rather than a silent auto-join because a site
that quietly joins you to a Discord server is doing something to your account you did not
ask for, and because the OAuth consent for it should be attached to a thing the player
just pressed.

⚠️ **This means the gate cannot be failed by anyone willing to press the button.** That
is the accepted consequence of choosing a funnel over a filter. The gate's real work is
keeping out crawlers, drive-by visitors and anyone unwilling to attach a Discord identity
— not keeping out a determined rival, who can join the Discord anyway.

### 2.3 Consent is asked in two tiers

`guilds.join` renders on Discord's consent screen as **"Join servers for you"**, which is
the most alarming line the average player will read, and irrelevant to the ~95% who are
already in the guild.

So the first OAuth round requests **`identify` only**. `guilds.join` is requested in a
*second* round, triggered by pressing "Join and continue". A player already in the guild
never sees it.

### 2.4 The user's access token is never stored

Membership is checked with **our own bot token** (`GET /guilds/{guild}/members/{user}`),
not with the player's token. This is the decision that keeps the whole thing small:

- No `guilds.members.read` scope, so the consent screen stays at one line.
- **No user access token is persisted anywhere**, and no refresh token exists to leak.
  The code is exchanged, the Discord user id is read out, and the token is discarded.
- The 15-minute re-check (§2.6) needs only the user id, which is already in our cookie —
  so it works forever without a token that would have expired in a week.

The one place a user access token is used is the join call, which requires one by
protocol; it lives for the length of that single request.

### 2.5 The session is a cookie, not a table

There is nowhere to put a server-side session. The web app has no database by design and
an in-memory store would be emptied by every `docker compose up -d web` — which this
project does often, and which would log out every player each deploy with no signal that
it had happened.

So the session is a **JWE (encrypted JWT) in an httpOnly cookie**, holding identity only.

⚠️ **A cookie session cannot be revoked before it expires.** There is no server-side
record to delete, so "log this person out now" is not an operation this design supports.
The levers are the 7-day lifetime and the 15-minute membership re-check, and they are
what make that acceptable: a kicked player loses access in minutes, not days. If a future
feature needs true revocation — a compromised account, say — it needs a session store,
and that is a decision to make then rather than to pre-build now.

⚠️ Rotating `SESSION_SECRET` logs every player out simultaneously. That is the intended
emergency lever and the only one; it is stated in `.env` beside the key.

### 2.6 Seven days, re-checked every fifteen minutes

Players return roughly weekly, so a 7-day session is about one login per active player
per week. A 24-hour session would mean a login prompt most play sessions, on mobile,
which is the friction players actually feel; 30 days leaves a shared or LAN machine valid
for a month, which is the wrong shape for a session that will eventually show base
coordinates.

Guild membership is re-verified at most every **15 minutes** and the result cached in the
cookie. Checking on every request would put a Discord API call in the path of every page
load — slower pages, and a Discord rate-limit becomes a site outage. Fifteen minutes
means a kick or ban takes effect within fifteen minutes, which is the honest promise.

### 2.7 A Discord outage does not log anyone out

When the re-check cannot reach Discord — an outage, a rate-limit, a network fault — an
already-verified session **keeps working on its last-known-good membership** until its 7
days run out. Only *new* logins fail while Discord is unreachable.

The alternative fails closed and turns any Discord outage into a total site outage for
every player at once, caused by something outside this system entirely. The accepted
cost is narrow and worth stating: **a player kicked during an outage keeps access until
the outage ends.**

⚠️ A failed check must NOT simply leave the session stale, or every subsequent request
retries and we hammer a service that is already struggling. The cookie carries
`nextCheckAt`; a failure sets it to 60 seconds out rather than 15 minutes, so recovery is
quick but the retry rate is bounded.

### 2.8 `/` stays public

Gating the front door would make the site invisible: `/` is the only indexable page and
the only way a prospective player learns what Clan Wars is before being asked for an
OAuth consent. A sign-in prompt with no explanation attached to it reads as sketchy and
converts badly.

So `/` stays public and unchanged. Everything else is gated, including both fixture
prototypes — which is a small improvement in its own right, since `/mobile` and `/link`
show invented data and are better off behind a login than in front of one.

### 2.9 The web app gets its own Discord application

The join call requires bot authentication. Giving the web container the real bot's token
would mean a compromised web app can kick, ban and post as the bot that runs the game
integration.

⚠️ It also would not work: **Discord requires the bot token and the user's access token to
belong to the same application**, so a "minimal second bot, OAuth from the main app"
split is not possible. The web app therefore gets its **own Discord application** —
`Clan Wars Web` — used for both the OAuth and the join. The game bot's token never leaves
the game bot.

⚠️ That application's guild role must carry **`CREATE_INSTANT_INVITE` and nothing else**.
It was first invited with Administrator, which grants everything and makes this
application strictly more dangerous than the token it was meant to avoid sharing. The
permission is a deploy prerequisite (§7) and is verifiable:

    curl -s -H "Authorization: Bot $DISCORD_JOIN_BOT_TOKEN" \
      https://discord.com/api/v10/users/@me/guilds

`permissions & 0x8` (Administrator) must be zero and `& 0x1` (Create Invite) must not be.

---

## 3. Flow

    visitor → /mobile
      └─ no session → 302 /login?next=/mobile
           └─ press "Continue with Discord"
                → /api/auth/discord   state+verifier cookie, scope=identify
                → Discord consent
                → /api/auth/callback  verify state, exchange code, read user id,
                                      discard token, check membership (bot token)
                     ├─ member      → set session, 302 to `next`
                     └─ non-member  → set session (guild:false), 302 /join
                          └─ press "Join and continue"
                               → /api/auth/discord?mode=join   scope=identify guilds.join
                               → Discord consent ("Join servers for you")
                               → /api/auth/callback  exchange, PUT guild member,
                                                     set session (guild:true), 302 to `next`

Every later request carries the cookie. Middleware decrypts it, and if `nextCheckAt` has
passed, re-verifies membership before serving.

---

## 4. Components

### 4.1 Routes

| Route | Access | Does |
|---|---|---|
| `/` | public | unchanged landing page |
| `/login` | public | the sign-in card; `?next=` remembered |
| `/join` | signed in, non-member | "Join and continue" |
| `/api/auth/discord` | public | begins OAuth; `?mode=join` adds `guilds.join` |
| `/api/auth/callback` | public | verifies state, exchanges, sets session |
| `/api/auth/logout` | signed in | clears the cookie. **POST only** |
| everything else | gated | |

⚠️ `/login` reuses the `/link` prototype's signed-out card, promoted into a real
component. The prototype keeps rendering its own fixture copy so the flow demo still
reads end-to-end; the two share the component, not the state.

⚠️ Logout is POST. A `GET /api/auth/logout` can be triggered by any image tag on any
page on the internet, which makes logging players out a drive-by. It clears the cookie
and redirects to `/`.

⚠️ **Both gate pages redirect when they have nothing to ask for.** A signed-in member
who reaches `/login` goes to `next` (or `/`), and a member who reaches `/join` does the
same. Rendering either would offer a player a button for something they have already
done — pressing "Continue with Discord" while signed in, or "Join and continue" while
already in the guild — and the second of those sends a pointless `guilds.join` consent
screen to someone who does not need it.

### 4.2 The session cookie

`cw_session` — JWE, `A256GCM`, direct encryption from `SESSION_SECRET`.
`httpOnly`, `secure`, `sameSite=lax`, `path=/`, 7-day `maxAge` and a matching `exp`.

    { sub: <discord user id>, name, avatar, guild: <bool>, nextCheckAt: <epoch seconds> }

⚠️ Identity only. Nothing about factions, membership of anything but the guild, or
entitlement to anything. The moment a faction fact is cached in this cookie it becomes a
second source of truth that no transaction updates, and it will be wrong.

⚠️ `sameSite=lax`, not `strict`: the OAuth callback is a cross-site top-level navigation
back from Discord, and `strict` would drop the cookie on exactly that redirect.

### 4.3 State

`arctic` generates the `state`, which is stored in a short-lived (10 minute) `httpOnly`
cookie and compared against the `state` Discord returns. The `mode` (login or join) and
the `next` path travel in that cookie, not the URL.

⚠️ **No PKCE, deliberately — and not by omission.** PKCE exists for *public* clients that
cannot keep a secret. This is a confidential client: the exchange happens server-side and
is authenticated by `DISCORD_CLIENT_SECRET`, which a browser never sees. Arctic's Discord
provider refuses a `codeVerifier` for confidential clients for exactly this reason
(`createAuthorizationURL(state, null, scopes)`), so the state cookie is the whole CSRF
defence and it therefore has to be right: an absent or mismatched `state` must refuse the
callback outright rather than falling through to the exchange.

⚠️ `next` must be validated as a **site-relative path** before redirecting to it. An
unchecked `?next=https://evil.example` turns the login endpoint into an open redirect.

### 4.4 Middleware

`apps/web/middleware.ts`. Public allowlist: `/`, `/login`, `/join`, `/api/auth/*`, and
static assets (`/_next/*`, `/flags/*`, `favicon.ico`, `robots.txt`). Everything else
requires a session; missing or undecryptable → `302 /login?next=<path>`; session with
`guild:false` → `302 /join`.

⚠️ Static assets stay public deliberately. Gating image bytes protects nothing — they are
the same 33 flags the Discord bot already posts publicly — and would break caching for
every gated page that uses them.

Gated pages remain **statically rendered**. Middleware gates the request; it does not
force the page dynamic. Nothing here changes how the pages are built.

---

## 5. Failure handling

| Situation | Response |
|---|---|
| Discord unreachable during re-check | keep last-known-good; `nextCheckAt = now + 60` (§2.7) |
| Discord unreachable during login | fail; the login page says Discord is unavailable |
| Member check returns 404 | not a member → `/join` |
| Join returns 403 | the player is banned from the guild. Say so plainly — "try again" would be a lie |
| Bad or missing `state` | refuse, clear state cookies, return to `/login`. Never proceed |
| Cookie fails to decrypt | treat as signed out. Do not distinguish tampering from an old `SESSION_SECRET` |
| `next` is not a site-relative path | ignore it and use `/` |

---

## 6. Testing

Tests in `apps/web` are node-only static checks — no jsdom, no browser. So the logic is
written as pure functions and tested directly, and the wiring is pinned structurally.

- **Session round-trip.** Encrypt → decrypt returns the same payload; a wrong key fails;
  an expired token fails.
- **The re-check decision table.** Member / not-a-member / rate-limited / 5xx / network
  error each map to the right outcome and the right `nextCheckAt`. This is where §2.7
  actually lives, so it is tested as a table rather than a happy path.
- **`next` validation.** Absolute URLs, protocol-relative `//evil.example`, and
  backslash variants are all rejected.
- **Cookie attributes.** The builder emits `httpOnly`, `secure`, `sameSite=lax`. A
  cookie that quietly loses `httpOnly` is readable by any script on the page.
- **⚠️ A drift test on the public allowlist.** The set of ungated routes is asserted
  exactly. Adding one is then a deliberate act that fails a test naming it, because a
  silently widened gate is not a thing anyone reports.

⚠️ **`smoke.test.ts` must be extended before any of this is written.** It scans `app/`
and `src/` only, and Next puts `middleware.ts` at the **project root** — outside both. All
the new server-side code would land in the one place the guard does not look. Its own
docblock warns that "a directory added later that isn't listed here is scanned by
nothing, silently"; this is that, happening to the test itself. Root-level `.ts` files
join its roots in the same change.

---

## 7. Deployment

### Prerequisites the deploy cannot satisfy for itself

1. A Discord application `Clan Wars Web` with `https://dayzclanwars.com/api/auth/callback`
   and `http://localhost:3000/api/auth/callback` registered as redirect URIs.
   ⚠️ **Unverified.** Discord validates `redirect_uri` at the consent screen, not at any
   API endpoint, so this cannot be checked from a shell and is confirmed only by a real
   login. A mismatch shows as "Invalid OAuth2 redirect_uri" instead of a consent screen.
2. Its bot invited to the guild with **`CREATE_INSTANT_INVITE` only** (§2.9).
3. `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_JOIN_BOT_TOKEN`,
   `SESSION_SECRET`, `WEB_BASE_URL` in `.env`, and passed to the `web` service in
   `docker-compose.yml`.

⚠️ None of these may be `NEXT_PUBLIC_`. A `NEXT_PUBLIC_` prefix inlines the value into the
client bundle, which for `DISCORD_CLIENT_SECRET` means publishing it.

⚠️ `docker compose up -d web` and nothing else. A bare `up -d` starts services this change
has no business restarting.

---

## 8. Carried forward

- **Where faction data comes from** — direct Postgres or a bot API — is still open, and
  is the next thing that must be decided, because the map cannot be built without it.
- **What happens on `/unlink`.** The direction note asks; this design does not answer it,
  because the gate does not consult the link at all. When a page does, `/unlink` needs to
  mean something to the session, and a cookie session cannot be revoked (§2.5).
- **Whether the map sits behind a re-auth.** Deferred until there is a map.
- **Roles.** Guild membership is currently one bit. Faction leadership, admin tooling and
  moderation will all eventually want more, and the cookie is the wrong place to cache
  any of it (§4.2).
