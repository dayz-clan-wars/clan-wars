# Publish the Nasdara special episode

This runbook covers the one-off "New to Clan Wars? Start here" episode of The Bloodbag
and Painkiller Show. Spec: `docs/superpowers/specs/2026-10-19-nasdara-promo-episode-design.md`.

It renders on a laptop and publishes from the host. The YouTube, Facebook and show
Discord credentials exist only in `/opt/clan-wars/.env`.

## 1. Render locally

1. Load the ElevenLabs and OpenRouter keys from `/opt/deathmatch-bot/.env`. Reusing them
   is approved; never print them.
2. Point `RHUBARB_PATH` at the local Rhubarb 1.13 binary.
3. Run, from the repo root:

       pnpm run show --special $PWD/apps/show/specials/2026-10-nasdara --render ~/show-special-2026-10-nasdara

Exit 1 means the script screen held it, and the reasons are printed. The output folder
gets `episode.mp3`, `video.mp4` and `cut.txt`, and the printed duration should be 2:00 to 2:30 of
dialogue plus the jingles.

## 2. Review

The operator watches `video.mp4`. If the script changes, edit `script.txt`, commit, and
render again.

## 3. Release

Run the usual release flow (release PR, tag) so the host has the `--special` command.

## 4. Copy the reviewed render to the host

    ssh acab@regime.fi 'sudo install -d -o acab /var/lib/clan-wars-show/specials/2026-10-nasdara'
    scp ~/show-special-2026-10-nasdara/{episode.mp3,video.mp4,cut.txt} acab@regime.fi:/var/lib/clan-wars-show/specials/2026-10-nasdara/

⚠️ Publish the files you reviewed. Re-rendering on the host would voice a different take.
⚠️ `cut.txt` is the hash of the script the audio was voiced from. The publish refuses (exit 2)
when the host's `script.txt` does not match it. A late script change needs a new render.

## 5. Publish (first run)

    ssh acab@regime.fi "sudo -u acab bash -c 'cd /opt/clan-wars && set -a && . ./.env && set +a && pnpm run show --special apps/show/specials/2026-10-nasdara --publish /var/lib/clan-wars-show/specials/2026-10-nasdara'"

Expected: `special 2026-10-nasdara: waiting`. The video is uploaded unlisted, and the ops
channel has a draft marked `show:special:2026-10-nasdara:<hash>`.

## 6. Approve

An approver checks the unlisted video on YouTube and reacts ✅ on the draft. A ❌ ends it:
the state records the rejection, and every later run prints `rejected`.

## 7. Publish (second run)

Run the same command again. Expected: `special 2026-10-nasdara: done`. The video is
public and in the Clan Wars playlist, and a forum thread named `Clan Wars Special · New to
Clan Wars? Start here` holds the link and the transcript. The Facebook Page has the
video, unless `facebookError` is set in `publish-state.json`.

A failed step exits 1 and prints the error. Running it again is safe: it adopts the
earlier upload, draft and thread instead of posting them again.
