# The field guide in Discord

Since 2026-09-09 the field guide is published into the Discord's **📖 Field Guide**
category: one channel per chapter (`01-what-this-is` … `13-rules-on-one-page`,
`a-numbers`) behind a `00-start-here` contents channel. The channels are written from
the same `apps/web/content/guide/*.html` fragments and the same number tokens the site
renders, by `apps/web/scripts/publish-guide.ts` through `apps/web/lib/guide-discord.ts`.

**Edit the guide on the site. Never edit the channels.** The publisher is a reconciler:
it rewrites any message whose text differs from what the content says, so a hand edit in
Discord lasts until the next run.

## How it stays in sync

1. `deploy/deploy-web.sh` runs the publisher at the end of every web deploy. The commit
   that changes the guide on dayzclanwars.com is the one that rewrites the channels.
2. `clan-wars-guide.timer` runs it hourly on the host, for a deploy done by hand.
3. `apps/web/test/guide-discord.test.ts` renders every chapter and holds each message
   under Discord's cap, with no HTML, no unresolved token and no unescaped markdown left
   over. A new HTML element in a chapter fails that test until `lib/guide-discord.ts`
   learns to render it.

Cross-links between chapters become channel mentions; the site link at the foot of each
chapter has its embed suppressed so the share card does not unfurl fifteen times.

## One-time setup (done 2026-09-09)

1. `.env` on the host and locally: `GUIDE_CATEGORY_ID=1544053793774374932`.
2. Install the timer:

       sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-guide.service /etc/systemd/system/clan-wars-guide.service
       sudo ln -s /opt/clan-wars/deploy/systemd/clan-wars-guide.timer /etc/systemd/system/clan-wars-guide.timer
       sudo systemctl daemon-reload && sudo systemctl enable --now clan-wars-guide.timer

3. First publish: `pnpm --filter @factions/web guide:publish --dry-run`, read the plan,
   then without `--dry-run`.

## Operating

    systemctl list-timers clan-wars-guide.timer
    journalctl -u clan-wars-guide -n 50
    pnpm --filter @factions/web guide:publish --dry-run     # what would change, from any checkout with the env

`--prune` deletes channels under the category that are not the guide's. Neither the
deploy script nor the timer passes it.
