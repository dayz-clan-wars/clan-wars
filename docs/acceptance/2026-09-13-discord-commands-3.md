# Acceptance — Discord slash commands (plan 3: vault, map, reads)

**Plan:** `docs/superpowers/plans/2026-09-13-discord-commands-3-vault-map-reads.md`
**Runbook:** `docs/deploy/2026-09-13-discord-commands-3.md`

The automated half is the gate below, run uncached against the merged tree.
The manual half is a pass in the guild, done after the deploy runbook's
restart step, before telling anyone the deploy is finished.

## Automated gate

```
export TEST_DATABASE_URL="postgres://factions:factions@localhost:5434/factions"
npx turbo run typecheck test --concurrency=1 --force
```

`--force` and `--concurrency=1` are both load-bearing here, not just in
development: a cache hit proves nothing about a tree the cache has not seen,
and concurrent tasks share the `factions_test_<package>` databases and drop
each other's. Expected: every task green. Result recorded in the plan's
execution ledger (`.superpowers/sdd/2026-09-13-discord-commands-3-vault-map-reads/progress.md`)
and in the commit that lands this file.

## Manual checks (in the guild)

⚠️ **Head every check below with this one.** Confirm every reply listed here
is **ephemeral — only you can see it.** A clan's roster, its own base and its
vault are all raid targets, and a vault code that reaches a public reply is a
raid the same night. If any check below answers in the channel instead of to
you alone, stop and treat it as a blocking defect — do not continue down the
list.

- [ ] `/vault add` opens a modal; the code field lives in the modal, **not**
      in the command bar where Discord would echo it back as you type.
- [ ] `/vault reveal` shows the code — **to you only**.
- [ ] `/vault list` shows the locks and **no code**.
- [ ] `/vault delete` shows a Confirm button and writes nothing until it is
      pressed.
- [ ] `/vault rotate` shows a Confirm button and writes nothing until it is
      pressed.
- [ ] `/map pin x: z: icon:` drops a pin.
- [ ] `/map pins` lists it.
- [ ] `/map unpin` removes it, and its autocomplete label shows **no
      coordinate** — icon, note excerpt and age only.
- [ ] `/map view` answers with one line and the site link (no drawn map in
      the reply itself — that lives on the site, behind its own gate).
- [ ] `/scoreboard` renders.
- [ ] `/alphas` renders.
- [ ] `/seasons` renders.
- [ ] `/warlog` renders.
- [ ] `/player` renders.
- [ ] `/board` renders.
- [ ] `/achievements` renders.
- [ ] `/whoami` is gone — Discord offers no such command, and typing it
      produces the client's own "unknown command," not a bot reply.

## Not exercised here

- The retired stubs' exact client-side behavior across the restart instant
  (cached command still shown once, then vanishing) is a Discord-client
  detail outside this repo's control — the runbook's warning to players is
  the mitigation, not a test.
- `/map view`'s linked site page (the drawn map, `publicBases` and
  `intruders`) is gated and tested on its own; this note only confirms the
  command replies with the link.
