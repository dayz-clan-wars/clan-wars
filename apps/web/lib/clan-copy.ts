import { TABLES, type Action } from "@factions/copy";
export { REFUSAL, DISBAND_WARNING, TABLES, type Action } from "@factions/copy";

export function code<A extends Action>(action: A, outcome: keyof (typeof TABLES)[A] & string): string {
  return `${action}.${outcome}`;
}

/** Every code a roster route can redirect with, flattened to "<action>.<outcome>". A null-prototype object so a query-string key cannot reach Object.prototype. */
export const RESULT_COPY: Record<string, string> = Object.assign(Object.create(null), Object.fromEntries(
  Object.entries(TABLES).flatMap(([action, table]) => Object.entries(table).map(([outcome, text]) => [`${action}.${outcome}`, text])),
));
