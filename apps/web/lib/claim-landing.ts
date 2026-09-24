/**
 * Where a claim POST lands.
 *
 * ⚠️ H1 (UX review 2026-09-24): /claim/{id} renders only an OPEN ceremony and
 * is notFound() otherwise. The first "Found the clan" consumes the ceremony,
 * so a second POST (a double tap, a retry) came back with no-such-ceremony
 * and put a founder whose clan had just been created on a 404. Every outcome
 * that means "this ceremony is spent" lands on /clan instead, which shows the
 * clan if they are in it and the refusal if they are not.
 */
const SPENT = new Set(["ok", "no-such-ceremony", "ceremony-taken"]);

export function claimLanding(ceremonyId: number, outcome: string): string {
  return SPENT.has(outcome) ? "/clan" : `/claim/${ceremonyId}`;
}
