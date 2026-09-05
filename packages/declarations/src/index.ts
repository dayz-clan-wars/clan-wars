/**
 * @factions/declarations — the ONLY writer of the `declarations` table
 * (target spec §4.1, §14), shared by the bot and by @factions/roster.
 *
 * It left apps/bot in increment 2b because the site's solo declare and
 * unlink need `declareTx`/`releaseTx`, and a package cannot import an app.
 * Nothing about the rules moved with it: the 200 m check, the advisory lock
 * and the grace stamps are exactly where they were, in store.ts.
 */
export * from "./store";
