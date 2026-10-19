# Special episode: "New to Clan Wars? Start here."

A one-off episode of The Bloodbag and Painkiller Show that announces the move to Nasdara
and sells the whole server to people who have never played it. It is a promo piece, and it
still has to be a real episode of the show.

## 1. Why, and who it is for

The server moved from Chernarus to Nasdara on 2026-10-17 (v2.0.0), and fast travel came
back in 2.4.0. This video carries that news to people who can join now. Viewers come from
three places:

1. Existing players on the server.
2. People who come across it in posts on other Discords, Reddit or Facebook.
3. People an existing player sent the link to.

Groups 2 and 3 are the target. They have never met Boris and Pavel and do not know what
Clan Wars is. Group 1 watches to catch up on the move.

**Success:** a new viewer finishes the video and hops on the server. Every beat serves
that. The outro screen tells them how.

## 2. Goals, non-goals, anti-goals

Goals
- Make a stranger want to join within 2 to 2.5 minutes.
- Explain what makes Clan Wars different. Then deliver the Nasdara news.
- Keep the show's humor intact. It must feel like an episode, not an ad read.
- Publish through the show's normal channels.

Non-goals
- No week recap: no stats, raids or storylines from the game data.
- No change to the weekly pipeline's behavior. The special does not count as a weekly
  episode.
- No new art. The user made the intro and outro screens. The desk rigs stay as they are.

Anti-goals (what would make this a failure even if it renders)
- It reads like a feature list or a corporate ad: Boris and Pavel taking turns reading
  bullet points.
- It breaks the show's tone or content rules (§4).
- It promises something that is not live (§5.3).
- It discourages raiding or sides with clans that got raided.
- It runs long enough that people leave before the outro screen.

## 3. Assets the user made

Both files are 3840x2160 PNGs at `/Users/steveharmeyer/Development/dayz-clan-wars/`:

- `special-intro.png`: a "SPECIAL EPISODE" ribbon over the show title, Boris and Pavel in
  parkas. "NEW TO CLAN WARS? START HERE." / "Your clan. Your war. Everything you need to
  know in one episode." Footer: `DAYZ · XBOX · NASDARA · CLAN WARS`, dayzclanwars.com.
- `special-outro.png`: "Bloodbag & Painkiller say: YOUR CLAN. YOUR WAR." with three
  steps: 1 Join the Discord (discord.gg/TJu4XP25nr), 2 Link your gamertag
  (dayzclanwars.com), 3 Raise your flag ("On Xbox, on Nasdara. The log does the rest.").
  Footer: "NEW EPISODE EVERY MONDAY @ 00:00 UTC".

They replace the regular `intro-screen.png` and the generated outro board for this
episode only. They are copied into `apps/show/assets/special/`; the regular assets are
untouched.

## 4. The script

### 4.1 Tone (unchanged from the weekly show)

Everything in `apps/show/src/prompt/system.ts` HOSTS and RULES applies, except the rules
about data:

- **Boris "Bloodbag" Volkov:** ex-Livonian military. A loud, condescending play-by-play
  man who thinks he is a tactical genius. His war stories end somewhere dark and absurd.
- **Pavel "Painkiller" Kozlov:** a panicky field medic who is out of saline. He is the
  one who actually read the notes.
- **Style:** South Park pacing. Mundane things are treated as world-historic disasters,
  absurdity escalates, and payoffs are deadpan.
- **Desk only:** dialogue only, and every line starts with `Boris: ` or `Pavel: `. No
  props, standing, pointing or stage directions.
- **Raiders are the heroes.** The admins (ADM) get roasted extra hard.
- **Clean:** PG-13, no em dash, "clan" never "faction".
- **Places are Nasdara places**, Boris's war stories included.
- **Brand terms** (`brand/02-verbal-identity.md`): flag, raise/lower, declared base,
  watch zone, Alpha, champion, gamertag, linked. Write "Clan Wars", never "CW". The hosts
  may shout. That is the show's register, not site copy.
- **No player gamertags, clan names, base locations or coordinates.** This is a promo for
  strangers. Exception: the ADM admins can be named as "the admins".

### 4.2 Length

The target is 2:00 to 2:30 of dialogue, which is 22 to 28 lines. That is roughly 300 to
380 spoken words, or at most about 2,200 characters. The intro jingle and outro screen
come on top of that.

### 4.3 Shape

The weekly format adapted to a special. The beats are fixed; the wording and the jokes are
the writer's.

1. **Cold start after the special intro.** Boris announces a "special episode". Management
   wants a recruitment video, and Boris treats it as a military briefing for new recruits.
   Pavel has the notes.
2. **"Previously, on Chernarus..."** Pavel gives a one-line recap: the whole server picked
   up and moved. Boris objects that a sports desk does not do "previously on". This is the
   regular show's bit, flipped. It lands the move to Nasdara within about 15 seconds.
3. **The hook: what Clan Wars is** (Tier 1, about 40% of the runtime).
4. **Nasdara** (Tier 2, about 30%).
5. **The rapid-fire rest** (Tier 3, one exchange). Pavel rattles off the rest while Boris
   tries to stop him.
6. **"Your first night on Nasdara"** replaces "Next time on". Two or three lines that walk
   a new player in, and set up the outro's three steps.
7. **Pavel's "You know, I learned something today..."** mock moral. Boris undercuts it.
   Both sign off by name, and the outro screen follows.

There is one running gag across the episode, seeded early and paid off at the end.
Suggested gag: Boris keeps trying to recruit Pavel, who is already on the show. The writer
may replace it.

### 4.4 Features and priority

The tiers were agreed with the user. Every **Tier 1** item gets a beat. **Tier 2** gets a
beat each, or a strong line. **Tier 3** is one rapid-fire exchange. **Tier 4** is optional.

**Tier 1: the hook**
1. Founding a clan: three linked players lower and raise a white flag together. No forms;
   the game log is the witness.
2. 33 one-of-a-kind flags. No two clans fly the same one, and each has a matching armband
   and Discord name colour.
3. The flag is the raid. A non-member lowering your flag is a raid, with no breach needed.
   Hitting the #1 clan pays the most (200 points against #1, sliding to 100).
4. Raid weekend: base damage is on from Friday 00:00 to Monday 00:00 UTC, switched
   automatically.
5. The 100 m watch zone pings your clan channel when an intruder walks in.
6. Each week the top 3 clans become the Alphas, and the season champion is recorded for
   good.
7. What the server leaves out on purpose: no shop, no currency, no alliances, and no admin
   deciding who won.

**Tier 2: the Nasdara news**
8. Nasdara itself: a 16 km map of new terrain, with 66 spawn towns.
9. Regional fresh-spawn loadout: pakol or turban, kameez, shalwar, sandals, keffiyeh, and
   a scoped Ruger 10/22. This is a strong comedy target for Boris.
10. Loot: guns ×2.5, building supplies ×2, food ×2, pristine loot, coloured
    AK/M4/SCAR/AKS74U.
11. Fast travel: log out in any shed, or next to your clan's pole, and you wake up in a sky
    Hub. Its porta-potty doors each lead to a town. This is another strong comedy target.
12. Working cars and build trucks. Both are in the server name, and "build trucks" needs
    verifying (§5.3).
13. Nasdara's own features: radio bunkers that hold the explosives, sandstorms, tunnels
    and gas pits. Verify these in game first (§5.3).

**Tier 3: the rapid-fire rest**
- The same supply kit at every clan's pole every restart.
- King of the Hill events.
- Event awards: Weapon Kit, Plate Carrier, Dead Rooster.
- Bounties.
- A live map on the site.
- Player stats and crown roles.
- 49 achievements.
- Griefers caught from the log and banned automatically.
- Clan tools.
- Linking your gamertag by doing three emotes.

**Tier 4: optional**
- The Discord booster kit.
- The weekly referral prize.
- Restarts every 2 hours.
- Vehicle rotation.
- Unlimited stamina and build anywhere.
- Live kill and war feeds.
- Defend-or-go-dormant.

### 4.5 How it gets written

Claude writes the script by hand into
`apps/show/specials/2026-10-nasdara/script.txt`, in the same `Boris: ` / `Pavel: ` line
format the weekly writer produces. The user approves the script before any audio is
generated.

The weekly LLM writer is not used. It is built around a week of game data, and the script
has to be reviewed line by line anyway.

The final script still runs through the existing script-level moderation screen as a
safety net. A hold is shown to the user, never silently overridden.

## 5. Production

### 5.1 Rendering

A new CLI path in `apps/show`, for example `pnpm run show --special <dir> --render <out>`,
renders a special from a directory holding `script.txt`, `meta.json` (code, subtitle,
descriptions, captions) and the two screens. It reuses the existing stages unchanged:

- ElevenLabs voicing with the Boris and Pavel voice ids
- the pronunciation store
- Rhubarb lip sync
- the desk compositor
- the intro and outro jingles
- `renderAnimatedShowVideo`

It differs from a weekly render in three ways:
- **Intro still:** `special-intro.png` instead of `intro-screen.png`.
- **Outro still:** `special-outro.png` instead of the generated outro board.
- **Screen wall and marquee** (my call): these normally come from the week's
  StoryContext. Here they come from `meta.json`:
  - The screen wall shows a few feature cards timed to the Tier 1 and 2 beats, for
    example "RAID WEEKEND · FRI 00:00 to MON 00:00 UTC" or "33 FLAGS · NO TWO ALIKE".
  - The marquee scrolls the server name, dayzclanwars.com and the Discord invite.
  - If wiring per-beat card timing turns out costly, a fixed rotation of cards is
    acceptable.

The output is `episode.mp3` and a 1080p `video.mp4`. The user watches the MP4 locally
before anything is published.

The special never creates a `show_episodes` row. That table is keyed by week, and
"Previously on" reads the last row's storylines. A row for the special would collide with
a real week or leak into next Monday's recap.

### 5.2 Publishing

These are the normal distribution channels, the same ones the weekly show uses:

- **YouTube:**
  - Same channel and the "Clan Wars" playlist.
  - Uploaded unlisted, then set public.
  - Title: `The Bloodbag and Painkiller Show: Clan Wars Special · New to Clan Wars? Start here` (my
    call; `videoTitle` with code `Special`).
  - Description (my call): the join steps and links first (Discord invite, dayzclanwars.com,
    and the server name to search for on Xbox), then the transcript. The weekly
    description is the transcript alone.
- **Discord:** one thread in the show's forum channel (#🩸-the-bloodbag-and-painkiller-show),
  with the same transcript messages as a weekly thread.
- **Facebook:** the same Page. The caption is new, because the weekly caption says "This
  week in Clan Wars: the raids...". The new one (my call):
  `🎙️ The Bloodbag and Painkiller Show: Clan Wars Special · New to Clan Wars? Start here`
  / `Clan Wars moved to Nasdara. Boris and Pavel explain the server in two minutes.` /
  YouTube link / Discord invite.

**Approval goes through the same gate as a weekly episode (user's decision):**

1. The special is uploaded to YouTube **unlisted**.
2. A draft goes to the ops channel.
3. An allowlisted approver reacts ✅ there.
4. Only then does the video go public. At that point it also joins the playlist, gets a
   forum thread and gets its Facebook post.

The weekly gate lives in `stages/run.ts` (`awaitingApproval` / `approved`). Reuse its
draft text, its reaction check and its approver list; do not write a second approval
path.

The special has no `show_episodes` row (§5.1), so it needs its own small state record:
the draft message id, the YouTube id, approval, and the forum and Facebook ids. A tiny
table or a JSON state file on the prod host would work, and that choice is the builder's.
A ✅ on the special's draft must never approve a weekly episode, and the reverse must
also be impossible.

Every step is idempotent, the way the weekly publish is: before acting, find the
existing upload by title, the existing forum thread, and the existing Facebook post. A
re-run after a partial failure therefore never double-posts.

Credentials: the YouTube, Facebook and show Discord credentials exist only in prod's
`.env`. The local `.env` has `DISCORD_TOKEN` only. So:
- **Rendering happens locally.** The ElevenLabs key and voice ids come from
  `/opt/deathmatch-bot/.env`, a reuse the user already approved, and Rhubarb is installed
  locally.
- **Publishing runs on prod.** It runs from the released code, with the rendered MP4
  copied up to the host.

### 5.3 Facts to verify before the script is final

- **Hub ban:** on (manual step 3 of `docs/deploy/2026-10-19-nasdara-fast-travel.md`).
  If it is off, the script must not call the Hub a no-combat zone.
- **"Build trucks" and "working cars":** check what they mean on this server and say
  exactly that.
- **Nasdara native features:** check the radio bunkers, sandstorms and gas areas in game
  or the RPT, or cut them.
- **Shed count:** do not say a number. Say "any shed".
- **Bunker Online:** do not mention it (removed). Do not mention the Wanderer achievement
  (retired).
- **King of the Hill:** do not say it starts automatically or by vote unless
  `KOTH_AUTO_TICK` and `KOTH_VOTE` are on in prod. "King of the Hill events" alone is safe.
- **Platform:** say Xbox. PC players can join (the PC auto-ban was removed in 2.3.3), but
  the screens say Xbox, so keep to Xbox.

## 6. Constraints

- Another Claude session is active in `nasdara/`, `clan-wars-rules/` and the main
  `clan-wars` checkout. All work happens in the worktree
  `/Users/steveharmeyer/Development/dayz-clan-wars/clan-wars-promo-episode` on its own
  branch.
- `main` is protected. Changes land by PR. Shipping to prod follows the repo's release
  flow (release/x.y.z changelog PR, then a tag). Confirm the version bump with the user.
- **Deadline: published today, 2026-10-19 (user's decision).** That rules out anything
  optional. Use the fixed card rotation, not per-beat timing (§5.1), and drop Tier 4
  unless a line earns it.
- **Order of work:**
  1. The script, approved by the user.
  2. The special mode in `apps/show`, with tests and a PR.
  3. A local render, approved by the user.
  4. Merge, then a patch release (confirm the bump with the user). Write the changelog
     line so it does not spoil the episode, because `release:sync` posts it to Discord.
  5. Publish on prod as unlisted.
  6. The ✅ in the ops channel.
  7. Public.
- Code changes must not alter weekly behavior. Existing tests stay green, and the new code
  gets its own tests.
- The production show service (`SHOW_ENABLED`) keeps running untouched.

## 7. Left to the builder

- The exact CLI shape and the `meta.json` schema.
- How card timing is attached to beats.
- Where the special's files live.
- Where the special's approval state is stored.
- How the MP4 gets onto prod for publishing.
