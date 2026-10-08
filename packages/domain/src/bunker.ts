import rooms from "../assets/bunker-rooms.json";

/** Which template a bunker comes online with (spec 2026-10-07-bunker-online §2). Never announced. */
export type BunkerKind = "boom" | "guns";
export const BUNKER_KINDS: readonly BunkerKind[] = ["boom", "guns"];

export type BunkerRoom = { name: string; slug: string; x: number; y: number; z: number; yaw: number };
/**
 * The 11 keycard rooms, vendored from chernarus/custom/keycard-rooms.json;
 * bunker-drift.test.ts holds them together. ⚠️ Picking and announcing read this
 * list; the placement reads the room from the SERVER's file at the opening
 * (bunker-stage.ts), so a room edited there is caught rather than placed stale.
 */
export const BUNKER_ROOMS: readonly BunkerRoom[] = rooms;

/**
 * The 16 Livonia airdrop locations, retired 2026-10-07. Names only: past rows
 * store these slugs and must keep printing a place, never be drawn again.
 */
const RETIRED_AIRDROP_LOCATIONS: readonly string[] = [
  "airfield", "bielawa", "brena", "dolnik", "gieraltow", "gliniska", "grabin", "lukow",
  "nadbor", "polana", "sarnowek", "sitnik", "sobotka", "tarnow", "topolin", "zalesie",
];

export function bunkerRoom(slug: string): BunkerRoom | null {
  return BUNKER_ROOMS.find((r) => r.slug === slug) ?? null;
}

/** A display name for any event's location, past or present; the slug itself if unknown. */
export function bunkerRoomName(slug: string): string {
  const room = bunkerRoom(slug);
  if (room) return room.name;
  if (RETIRED_AIRDROP_LOCATIONS.includes(slug)) return slug.charAt(0).toUpperCase() + slug.slice(1);
  return slug;
}

/**
 * The one spawner path the feature ever registers. ⚠️ A fixed file the bot
 * rewrites at every opening, so `objectSpawnersArr` never needs one entry per
 * room and kind.
 */
export const BUNKER_SPAWNER_PATH = "./custom/bunker-online.json";

/** The template a kind is built from, in the mission's custom/ directory. */
export function bunkerTemplateFile(kind: BunkerKind): string {
  return `keycard-bunker-${kind}.json`;
}

export type SpawnerObject = {
  name: string; pos: [number, number, number]; ypr: [number, number, number];
  scale: number; enableCEPersistency: number; customString: string;
};
export type BunkerAnchor = { x: number; y: number; z: number; yaw: number };

const ANCHOR = "Land_Underground_Stairs_Exit";
const RAD = Math.PI / 180;

/** Yaw in (-180, 180]. */
function normaliseYaw(deg: number): number {
  const r = ((deg % 360) + 360) % 360;
  return r > 180 ? r - 360 : r;
}

/**
 * The template moved onto a room: every object keeps its offset from the
 * template's stairs exit, turned by the difference in yaw, and the template's
 * own exit is left out because the room already spawns one (spec §4).
 *
 * ⚠️ DayZ yaw is degrees clockwise from north (+z), so turning by θ maps an
 * offset (dx, dz) to (dx·cos θ + dz·sin θ, −dx·sin θ + dz·cos θ). No file in
 * either repo proves this; the first bunker on production is checked in game
 * before the automatic event runs (spec §8).
 */
export function placeBunker(template: { Objects: SpawnerObject[] }, room: BunkerAnchor): { Objects: SpawnerObject[] } {
  const anchors = template.Objects.filter((o) => o.name === ANCHOR);
  if (anchors.length !== 1) throw new Error(`bunker template: expected one ${ANCHOR}, found ${anchors.length}`);
  const a = anchors[0]!;
  const turn = room.yaw - a.ypr[0];
  const c = Math.cos(turn * RAD), s = Math.sin(turn * RAD);
  return {
    Objects: template.Objects.filter((o) => o !== a).map((o) => {
      const dx = o.pos[0] - a.pos[0], dy = o.pos[1] - a.pos[1], dz = o.pos[2] - a.pos[2];
      return {
        ...o,
        pos: [room.x + dx * c + dz * s, room.y + dy, room.z - dx * s + dz * c],
        ypr: [normaliseYaw(o.ypr[0] + turn), o.ypr[1], o.ypr[2]],
      };
    }),
  };
}
