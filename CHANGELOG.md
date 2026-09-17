# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- An acceptance record for the automatic deployment system,
  `docs/acceptance/2026-09-17-auto-deploy.md`: what the three rehearsals proved,
  the six-minute outage the second one caused and why, the measured downtime of
  a real rollback, and an explicit list of what the acceptance does **not**
  establish.

## [1.16.6] - 2026-09-17

### Fixed

- The release deployer can no longer be rewritten out from under itself. It
  moves the tree to the new tag, which replaces `deploy-release.sh` while bash
  is executing it, and bash reads a script lazily by byte offset rather than
  loading it whole — so a replacement of a different length makes the
  interpreter resume at a stale offset in new bytes. Reproduced: the victim
  script silently stopped running at the rewrite and **exited 0**, which in a
  deploy means all three writers stopped, a failure marker written, and a
  success reported. The deployer now re-execs from a private copy, so its own
  text cannot change mid-run.
- A deploy can no longer report success while production runs the previous
  release's image. `docker compose up -d` was observed starting the stopped
  containers again rather than recreating them on the newly built image; web
  and ingest-worker are build-only services whose definitions name no image, so
  an unchanged definition can look up to date. No health check could catch it —
  the old image is perfectly healthy. The deployer now passes
  `--force-recreate`, which costs nothing because those containers have already
  been stopped.

## [1.16.5] - 2026-09-17

### Changed

- Rehearsal 2, re-run: a deliberately unhealthy release, used once to prove the
  deployer's automatic rollback restores code, images, host config and database
  after the image-retag fix in 1.16.3. Reverted here. The rollback passed: 1
  minute 57 seconds of downtime, including a full drop-and-restore of
  `factions_live`, with no human involved.

## [1.16.4] - 2026-09-17 [WITHDRAWN]

Not a release. This tag is rehearsal 2's re-run — a deliberately unhealthy
build, cut to prove the automatic rollback after the image-retag fix in 1.16.3.
It is recorded rather than deleted for the same reason as 1.16.2: a tag the
deploy history names should not be a mystery.

The rollback passed in full this time. **Never deploy this tag.**

## [1.16.3] - 2026-09-17

### Fixed

- The deployer's rollback no longer retags the **postgres** image when
  restoring the previous release. It resolved the target with
  `docker compose config --images <service>`, which also lists the service's
  dependencies, so the first line was `postgres:16-alpine` — pointing the
  database's image tag at an application image and putting postgres into a
  restart loop. Found by rehearsal 2 on 2026-09-17, which took production down
  for about six minutes; no data was lost.

### Changed

- Rehearsal 2's deliberately unhealthy release is reverted.

## [1.16.2] - 2026-09-17 [WITHDRAWN]

Not a release. This tag is rehearsal 2 — a deliberately unhealthy build, cut to
prove the deployer's automatic rollback works against real production data. It
is recorded here rather than deleted because the production host's failure
marker names it, and a tag a runbook points at should not be a mystery.

The rollback restored the tree, the host config and `factions_live` correctly,
and refused to retry. It failed at one step, fixed in 1.16.3. **Never deploy
this tag.**

## [1.16.1] - 2026-09-17

### Fixed

- The release deployer no longer dies at its first step: `pnpm` prints a
  lifecycle banner to stdout before a script's own output, and the deployer
  fed that banner to a JSON parser. Every deploy would have failed.
- `/backups/` is ignored, so hand-made dumps kept on the production host no
  longer leave the working tree dirty — which would otherwise make the release
  deployer refuse every deploy.

## [1.16.0] - 2026-09-16

### Added

- Releases deploy themselves: a new `vX.Y.Z` tag on `main` is deployed to
  production within two minutes, applying migrations and rolling back code,
  image, host config and database together if any phase fails.
- Repository lifecycle, CI, hygiene, secret-scanning and dependency-update
  configuration via the shipyard plugins: `.keel.json`, `.rigging.json`,
  `.stow.json`, `.hull.json` and `.bosun.json`, with the GitHub Actions
  workflows, PR/issue templates, CODEOWNERS and changelog gate they render.
- CI (`.github/workflows/ci.yml`) runs `pnpm run ci` — the typecheck and test
  gate — on node 20 against a Postgres 16 service container, with
  `TEST_DATABASE_URL` pointed at it as the base URL each package derives its
  own `factions_test_<package>` from.
- Secret scanning (`.github/workflows/security.yml`) runs trufflehog rather
  than gitleaks: this repo is organization-owned, and the gitleaks action
  exits 1 without a licence key before scanning anything.
- `CLAUDE.md` documents the CI gate, the `main`-is-protected PR workflow, the
  committed-changelog requirement, and the secret-scanning boundary — including
  that the history was swept clean once at adoption.
- Design for automatic deployment on release (`docs/superpowers/specs/2026-09-16-auto-deploy-design.md`),
  approved but not implemented: a host-side timer deploys each new tag, applies
  migrations, and rolls back both code and database automatically on failure,
  with the implementation plan in `docs/superpowers/plans/2026-09-16-auto-deploy.md`.
