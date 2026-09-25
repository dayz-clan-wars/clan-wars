# Re-crediting Hub kills from before the rule — deploy

Kills made at the Fast Travel Hub before it became a no-combat zone score again. A
Hub kill is discredited only from `HUB_COMBAT_FROM` (`packages/domain/src/rules.ts`,
2026-09-23T02:17:03Z — the bot's first `HUB_BAN_TICK on`). Spec: the §2.6 amendment in
`docs/superpowers/specs/2026-09-22-hub-combat-design.md`. Bans are unchanged: Hub combat
is still a one-hour ban.

## 1. What ships

- No migration. `kills-tick.ts` writes `at_hub` through `hubKillDiscredited`, which is
  false for any kill before `HUB_COMBAT_FROM`.
- **Nothing moves on the release alone.** Existing `kills` rows keep the `at_hub` they
  were written with until step 3 rebuilds them. The release deploy is safe to let run
  on its own; steps 2–5 are by hand, afterwards.

On 2026-09-24, 75 kills were `at_hub`, every one before `HUB_COMBAT_FROM` (the last at
2026-09-22 23:58); 61 of them score once re-credited (the rest are friendly fire or
self-kills), across 11 killers.

## 2. Stop the bot

After the release deploy has finished (`[DEPLOYED] v… is live` in
`journalctl -u clan-wars-deploy`):

```bash
sudo systemctl stop clan-wars-bot
systemctl status clan-wars-bot     # inactive (dead)
```

⚠️ The bot stays stopped through step 4. `backfill:achievements` shares the achievement
tick's watermarks and resume marker; the live tick must not run beside it.

## 3. Rebuild kills

```bash
cd /opt/clan-wars && set -a && . ./.env && set +a
pnpm --filter @factions/bot exec tsx ../../scripts/rebuild-kills.ts --server 1
```

Verify — `before` must be 0; `since` is every Hub kill from the rule on (0 on
2026-09-24):

```sql
select count(*) filter (where at_hub and occurred_at <  '2026-09-23T02:17:03Z') as before,
       count(*) filter (where at_hub and occurred_at >= '2026-09-23T02:17:03Z') as since
from kills;
```

The Discord feeds do not repost: every poster keeps its cursor on event ids, which the
rebuild preserves.

## 4. Restore badges, silently

```bash
pnpm --filter @factions/bot exec tsx ../../scripts/backfill-achievements.ts
```

It runs every owner's rules with `announce: false` — unlock rows only, no notices, so no
achievement card and no DM — and then sets the tick's watermarks to the head. ⚠️ That
last part is what keeps it silent: without it, the live tick would see every kill
renumbered by step 3 above its watermark and re-run everyone on its next start, posting
a card for each restored badge. So this step is not optional even if you do not care
about badges.

Expect `N unlocks inserted` ≥ the number `revoke-achievements.ts --apply` revoked on
2026-09-22. It only ever inserts; it never takes a badge away.

## 5. Start the bot

```bash
sudo systemctl start clan-wars-bot
journalctl -u clan-wars-bot -f
```

Expect `HUB_BAN_TICK on: …` as before, and no burst of achievement cards.

## 6. Known limits

- A badge `revoke-achievements.ts` RE-DATED (kept, moved to a later non-Hub kill) keeps
  its later date. The backfill inserts missing unlocks only; it does not move an
  existing one back.
- Discord posts made about the discredit stay. There were none — it was silent.

## 7. Rollback

Revert the release, then repeat steps 2–5: the rebuild under the old code discredits
every Hub kill again. Step 4 is then a no-op (it cannot revoke); run
`revoke-achievements.ts` (see `2026-09-22-hub-combat.md` §6) instead.
