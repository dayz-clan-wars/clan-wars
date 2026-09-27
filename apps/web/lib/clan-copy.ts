import { TABLES, type Action, REFERRAL_COPY } from "@factions/copy";
import type { ReferrerRefusal } from "@factions/roster";
export { REFUSAL, DISBAND_WARNING, TABLES, type Action } from "@factions/copy";

/**
 * `/api/referral`'s own outcomes, kept local rather than added to the shared
 * `TABLES` in `@factions/copy` — nothing on the bot side ever renders these,
 * and `REFERRAL_COPY`'s entries take a `{ referrerGamertag }` argument, so
 * they are flattened to plain strings here (called with `{}`) the same way
 * every other result code is a fixed sentence, never one built from what a
 * player typed.
 */
const REFERRAL_TABLE: Record<"input" | "recorded" | ReferrerRefusal, string> = {
  ...(Object.fromEntries(Object.entries(REFERRAL_COPY).map(([outcome, copy]) => [outcome, copy({})])) as Record<ReferrerRefusal, string>),
  input: "Type a gamertag.",
  recorded: "Saved. This can't be changed.",
};

export function code<A extends Action>(action: A, outcome: keyof (typeof TABLES)[A] & string): string;
export function code(action: "referral", outcome: keyof typeof REFERRAL_TABLE): string;
export function code(action: string, outcome: string): string {
  return `${action}.${outcome}`;
}

/** Every code a roster route can redirect with, flattened to "<action>.<outcome>". A null-prototype object so a query-string key cannot reach Object.prototype. */
export const RESULT_COPY: Record<string, string> = Object.assign(Object.create(null), Object.fromEntries([
  ...Object.entries(TABLES).flatMap(([action, table]) => Object.entries(table).map(([outcome, text]) => [`${action}.${outcome}`, text])),
  ...Object.entries(REFERRAL_TABLE).map(([outcome, text]) => [`referral.${outcome}`, text]),
]));
