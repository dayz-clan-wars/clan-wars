# Deploy step — targeted identity linking

Run BEFORE applying migration 0012 to any database holding rows.

    delete from challenge_attempts;
    delete from verification_challenges;

Every pre-change challenge is unwinnable under the new rules: it has no target
UID, and the tick now requires one. `identity_links` is untouched and must not
be cleared — a completed link stays valid.

Verified 2026-09-01: `factions_live` held 1 challenge, 0 attempts, 0 links.
