# Clan role colours — deploy runbook

Every clan's Discord role gets a colour, so a member list reads as a clan roster at a
glance. No migration, no env var, no channel. Deploy the release and the reconciler
converges on the next tick.

⚠️ **The colours have nothing to do with the flag art, deliberately.** The flags' own
art samples mostly dark (24 of 33 below 32% lightness), four are near-black, and the
hues pile up — nine olives and nine navies — so a palette taken from the art would be
unreadable on Discord and would make a third of the clans indistinguishable. The flag
is used only as a stable, already-unique key: a flag is unique among holding clans, so
two clans can never be handed the same colour. The table is `FLAG_COLORS` in
`packages/domain/src/flags.ts`.

1. **Nothing to configure.** No new env var. Deploy the release as usual.

2. **Confirm on the first tick** (`journalctl -u clan-wars-bot -f`). The four clans
   that already have roles are repainted by the reconciler's repair step, so expect
   one line:

       structure tick: colorsFixed 4

   A new clan founded after this gets its colour at role-creation time instead, with
   no `colorsFixed` line — its members are the right colour immediately rather than a
   tick later.

3. **Verify in Discord.** Open the member list. Every clan member's name should be
   their clan's colour.

## ⚠️ What makes the colours visible, and what would hide them

Discord paints a name with the **highest-positioned role that has a colour**. A role
set to "default" has no colour at all and is skipped, whatever its position.

As of 2026-09-18 every other role in the guild is on default, so a clan role is the
only coloured role anyone holds and it always wins. **Giving any role above the clan
roles a colour again takes the clan colour away from everyone holding it** — Admin
(position 20), Linked (17) and Alpha (16) are all above. If clan colours ever stop
showing for some members, that is the first thing to check, before suspecting this
code.

The nine crown roles sit at positions 1-9, below the clan roles, so they never paint a
name even if they were given colours. Making crown colours show would mean moving them
above the clan roles, which takes the clan colour away from exactly the players who are
winning.

## Hazards

⚠️ **The repair step skips a role the cache cannot answer for.** `roleColor` returns
null for a cold or failed guild fetch — which is NOT the same as "no colour", which is
0. Skipping then is the same under-acting discipline the `mentionable` repair uses: a
blind cache must never provoke a write it cannot verify, once per clan per tick,
forever.

⚠️ **A flag outside the pool leaves the role's colour alone rather than blanking it.**
`flagColor` is null for the neutral flag and anything unknown. An unknown texture is a
bug or a hand-edited row, and stripping a clan's colour would be a worse answer than
leaving what is there.

⚠️ **A colour changed by hand reverts within a tick.** The reconciler owns it, the same
way it owns the role's name and its mentionable flag. To change a clan's colour for
good, change `FLAG_COLORS`.

⚠️ **Changing a value in `FLAG_COLORS` repaints that clan on the next tick.** That is
the intended way to adjust one, but it is a visible change to a clan's identity — not a
silent edit.
