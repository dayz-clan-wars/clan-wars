import { LEADERSHIP_TABLES, type LeadershipAction } from "@factions/copy";
export { LEADERSHIP_TABLES, type LeadershipAction, CLAIM_REFUSAL } from "@factions/copy";

export function leadershipCode<A extends LeadershipAction>(action: A, outcome: keyof (typeof LEADERSHIP_TABLES)[A] & string): string {
  return `${action}.${outcome}`;
}

/** Every code a leadership route can redirect with, flattened to "<action>.<outcome>". A null-prototype object, same reasoning as `RESULT_COPY`. */
export const LEADERSHIP_RESULT_COPY: Record<string, string> = Object.assign(Object.create(null), Object.fromEntries(
  Object.entries(LEADERSHIP_TABLES).flatMap(([action, table]) => Object.entries(table).map(([outcome, text]) => [`${action}.${outcome}`, text])),
));
