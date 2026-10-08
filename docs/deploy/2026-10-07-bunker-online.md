# Deploy: bunker online (2026-10-07)

Spec `docs/superpowers/specs/2026-10-07-bunker-online-design.md`. Migration 0064
(additive: `airdrop_events.colour` nullable, `kind`, exactly-one check) is applied
by the release deployer.

1. **Chernarus first.** The room-renames PR is merged and its Release has deployed
   (`custom/keycard-rooms.json` says Kamensk Military, Pavlovo Military, Tisy
   Military, Zelenogorsk). The templates `custom/keycard-bunker-boom.json` and
   `-guns.json` are on the server.
2. **Switch the automatic event off** on the host, before tagging the release:
   back up `.env` (`cp -p .env .env.bak-<UTC>-bunker`), set `AIRDROP_TICK=0`,
   `sudo -n systemctl restart clan-wars-bot`, and confirm the journal shows
   `AIRDROP_TICK is off: airdrops are not being placed automatically.` This stops the automatic event deciding a bunker between
   the release and the live check. ⚠️ With it off, `/bunker place` refuses
   ("AIRDROP_TICK is off"), which is why step 4 turns it back on first.
3. **Release clan-wars** and wait for `[DEPLOYED]` in `journalctl -u clan-wars-deploy`.
4. **Live check on production.** Set `AIRDROP_TICK=1` again and restart the bot.
   Immediately, before the automatic tick's next decision instant (30 min before a
   restart), run `/bunker place room:<any> kind:boom` for the next restart. From
   then on the manual bunker itself keeps the automatic event away: the
   one-at-a-time guard while it is announced or live, then the 24 h gap after it
   (manual events hold the gap), which is the window for this check. After
   that restart, an admin walks into the room and confirms the door panel, the
   lever, the crates and the loot sit inside it, the right way round. A
   misplacement is gone at the restart after; if one is seen, set `AIRDROP_TICK=0`
   again and report it.
5. Once step 4 passes, leave `AIRDROP_TICK=1`. Nothing else changes in `.env`.
