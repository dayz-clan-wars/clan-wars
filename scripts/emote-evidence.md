# Emote evidence — which safe-pool tokens have actually been seen

`packages/domain/src/emotes.ts` offers 24 tokens for `/link` sequences. That set is
one-life's **published** list, adopted whole; it has never been verified against this
project's own players. The docstring there says so at length, and this file is the query
behind the numbers it quotes, so they can be regenerated rather than believed.

⚠️ **Read the caveat before acting on the output.** Observation and wheel-selectability
are independent properties and neither implies the other:

- `EmoteSOS` was observed three times in the five-week export and a real player still
  could not find it on the wheel. That is what got it demoted.
- A token missing from a small sample is missing for want of occasions. Two days of a
  five-player server is a small sample.

So this is **not** a demotion queue. The evidence that settles whether a token is
unperformable is a lockout message naming it — those name the emote the player never
reached, and a genuinely unperformable token will accumulate them.

## The query

```bash
docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "
  select payload->>'emote' as token, count(*) as performances,
         count(distinct payload->>'dayzId') as players,
         min(occurred_at)::date as first_seen, max(occurred_at)::date as last_seen
  from events where type='emote.performed'
  group by 1 order by 2 desc"
```

Safe-pool tokens with **no** local evidence, which is the list worth watching:

```bash
docker exec clan-wars-postgres-1 psql -U factions -d factions_live -X -c "
  select t.token
  from unnest(array[
    'EmoteSalute','EmoteSurrender','EmoteGreeting','EmoteClap','EmoteHeart',
    'EmotePoint','EmotePointSelf','EmoteThumb','EmoteThumbDown','EmoteNod',
    'EmoteShake','EmoteDance','EmoteFacepalm','EmoteShrug','EmoteTimeout',
    'EmoteLookAtMe','EmoteListening','EmoteCome','EmoteMove','EmoteSilent',
    'EmoteWatching','EmoteThroat','EmoteRPSRandom','EmoteTauntElbow'
  ]) as t(token)
  where not exists (
    select 1 from events e
    where e.type='emote.performed' and e.payload->>'emote' = t.token)
  order by 1"
```

## Snapshot — 2026-09-02

95 emote events over two days (1–2 Sep), 14 distinct tokens, of which 12 are in the safe
pool.

| Token | Performances | Players | Safe |
|---|---:|---:|---|
| `EmoteSitA` | 54 | 5 | no — 57% of all traffic here, 77% in the older export |
| `EmoteSuicide` | 13 | 4 | no — gameplay penalty |
| `EmoteGreeting` | 5 | 2 | yes |
| `EmoteDance` | 5 | 1 | yes |
| `EmoteTauntElbow` | 4 | 1 | yes |
| `EmoteClap` | 4 | 1 | yes |
| `EmotePoint` | 2 | 1 | yes |
| `EmoteSurrender` | 2 | 2 | yes |
| `EmoteThumbDown` | 1 | 1 | yes |
| `EmoteFacepalm` | 1 | 1 | yes |
| `EmoteListening` | 1 | 1 | yes |
| `EmoteLookAtMe` | 1 | 1 | yes |
| `EmotePointSelf` | 1 | 1 | yes |
| `EmoteSalute` | 1 | 1 | yes |

Never seen locally (12 of 24): Heart, Thumb, Nod, Shake, Shrug, Timeout, Come, **Move**,
Silent, Watching, Throat, RPSRandom.

`EmoteMove`'s presence there corroborates the 2026-09-01 lockout directly — Wintershadow394
was drawn it and produced no such line. It is still **not** grounds to demote it on its
own: the historical export has 5 performances by 3 distinct players, more evidence than
`EmoteNod` (1 by 1) or `EmoteTimeout` (3 by 1), which are also in the pool.

`EmoteSitA` at 57% is also a useful check on the exclusion rule that keeps it out: it
still dominates natural play, so a sequence containing it would still be completed by
accident.
