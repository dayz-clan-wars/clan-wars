#!/usr/bin/env bash
# Deploy the web app on the host, then write the field guide into Discord.
#
#   ssh acab@regime.fi /opt/clan-wars/deploy/deploy-web.sh
#
# The guide step is what keeps the Discord copy of the guide in step with the
# site: the same commit that changes content/guide on dayzclanwars.com is
# the one that rewrites the channels, in the same run. It is a reconciler
# (apps/web/scripts/publish-guide.ts) — a deploy that changed nothing in the
# guide writes nothing to Discord. The hourly timer (clan-wars-guide.timer)
# is the safety net for a deploy done by hand without this script.
set -euo pipefail
cd /opt/clan-wars
git pull --ff-only
sudo -n docker compose build -q web
sudo -n docker compose up -d web
set -a; . ./.env; set +a
/home/acab/.local/bin/pnpm --filter @factions/web guide:publish
