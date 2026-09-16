# Changelog

All notable changes to this project are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

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
