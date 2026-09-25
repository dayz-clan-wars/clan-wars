/**
 * Where a claim POST lands.
 *
 * ⚠️ H1 (UX review 2026-09-24): /claim/{id} renders only an OPEN ceremony and
 * is notFound() otherwise. `no-such-ceremony` does not mean only "a double
 * tap or retry raced its own successful claim" — `openCeremonyByIdFor`
 * (packages/roster/src/internal/faction-store.ts) answers null for ANY
 * ceremony no longer `provisional`: one this same claim just consumed, yes,
 * but just as often one `ceremony-tick.ts` expired on its own clock while the
 * player was still filling the form, or one settled some other way entirely.
 * Landing on /clan rather than a 404 is right either way: if the claim in
 * flight actually went through, the viewer now holds a clan and the page
 * shows it; if it did not, /clan shows the refusal instead of a dead link to
 * a ceremony that is gone regardless of why.
 */
const SPENT = new Set(["ok", "no-such-ceremony", "ceremony-taken"]);

export function claimLanding(ceremonyId: number, outcome: string): string {
  return SPENT.has(outcome) ? "/clan" : `/claim/${ceremonyId}`;
}
