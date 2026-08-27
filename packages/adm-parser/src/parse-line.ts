import type { EventType, Vec3 } from "@factions/domain";
import { parseFlagChange, type FlagChange } from "./flag.js";
import { parseFlagPole, type FlagPoleEvent, type FlagPoleAction } from "./flagpole.js";
import { parseRosterHeader, parsePlayerListEntry } from "./playerlist.js";

export type ParsedLine =
  | { kind: "flag"; change: FlagChange }
  | { kind: "flagpole"; event: FlagPoleEvent }
  | { kind: "roster"; count: number }
  | { kind: "position"; gamertag: string; dayzId: string; pos: Vec3 };

/**
 * Every ParsedLine a single raw line yields, in a FIXED order.
 *
 * ⚠️ `subIndex` in the event log is this array's index. Changing the order renumbers
 * every historical event and collides with the idempotency unique index. Do not reorder.
 */
export function parseLine(raw: string): ParsedLine[] {
  const roster = parseRosterHeader(raw);
  if (roster) return [{ kind: "roster", count: roster.count }];

  const change = parseFlagChange(raw);
  if (change) return [{ kind: "flag", change }];

  const pole = parseFlagPole(raw);
  if (pole) return [{ kind: "flagpole", event: pole }];

  const entry = parsePlayerListEntry(raw);
  if (entry) {
    return [{ kind: "position", gamertag: entry.gamertag, dayzId: entry.dayzId, pos: entry.pos }];
  }

  return [];
}

const FLAGPOLE_ACTION_TO_EVENT_TYPE: Record<FlagPoleAction, EventType> = {
  placed_kit: "flagpole.placed",
  folded: "flagpole.folded",
  built: "flagpole.built",
  dismantled: "flagpole.dismantled",
};

export function eventTypeFor(line: ParsedLine): EventType | null {
  switch (line.kind) {
    case "flag":
      return line.change.action === "raised" ? "flag.raised" : "flag.lowered";
    case "flagpole":
      return FLAGPOLE_ACTION_TO_EVENT_TYPE[line.event.action];
    case "position":
      return "player.position";
    case "roster":
      return null;
  }
}
