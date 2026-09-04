/**
 * The eight screens the shell can show, and the five the bottom nav selects.
 *
 * ⚠️ `Screen` is deliberately wider than `Tab`. `invites`, `claim` and `rebind`
 * are pushed screens reached from inside a tab, and Back returns to the tab you
 * came from rather than to whatever was last on screen — which is why these are
 * two types rather than one union with a comment.
 */
export type Screen =
  | "map"
  | "faction"
  | "feed"
  | "directory"
  | "me"
  | "invites"
  | "claim"
  | "rebind";

export type Tab = Extract<Screen, "map" | "faction" | "feed" | "directory" | "me">;

/** Title and subtitle for the top bar, per screen. */
export const TITLES: Readonly<Record<Screen, readonly [string, string]>> = {
  map: ["Faction map", "Wolf Tang Clan · Livonia"],
  faction: ["My faction", "Roster and management"],
  feed: ["Activity", "Raids, defenses, transitions"],
  directory: ["Factions", "12 of 33 flags held"],
  me: ["Me", "Identity and linking"],
  invites: ["Invitations", "2 pending"],
  claim: ["Found a faction", "Ceremony witnessed"],
  rebind: ["Move the base", "One candidate pole"],
};

export const NAV: readonly (readonly [Tab, string])[] = [
  ["map", "Map"],
  ["faction", "Faction"],
  ["feed", "Activity"],
  ["directory", "Factions"],
  ["me", "Me"],
];
