import { NEUTRAL_FLAG } from "@factions/domain";

export type SpawnObject = {
  name: string;
  pos: [number, number, number];
  ypr: [number, number, number];
  scale: number;
  enableCEPersistency: number;
  customString: string;
};

export type SupplyFaction = { tag: string; texture: string; x: number; y: number; z: number };

/** The template object whose position every other object is measured from. */
const ANCHOR = "TerritoryFlag";

/**
 * How many of each object a kit gets, where that differs from the count the
 * template was captured with. Keyed by the TEMPLATE's name, so the flag entry
 * is the white flag — before the faction's texture is substituted.
 *
 * Extra copies stack on the template's own entries, which is how the template
 * itself expresses quantity: its five Whetstones, and all twenty WoodenLogs,
 * each share one position and differ only in yaw drift from being piled up in
 * game. Nothing here moves an object.
 */
const KIT_QUANTITIES = new Map<string, number>([
  // A spare, so a raided faction can re-raise without waiting for a sweep.
  [NEUTRAL_FLAG, 2],
  ["WoodenLog", 50],
]);

/**
 * Copies to emit for template entry `i` of the `n` that share a name, so the
 * kit totals `total`.
 *
 * Round-robin rather than repeating one entry `total - n` times: the template's
 * duplicates carry slightly different ypr values, and spreading the copies
 * across them keeps that variety instead of stamping one yaw fifty times. The
 * remainder goes to the earliest entries, so the split is deterministic — the
 * uploaded bytes are hashed, and a total that varied between runs would
 * re-upload forever.
 */
function copiesFor(total: number, n: number, i: number): number {
  return Math.floor(total / n) + (i < total % n ? 1 : 0);
}

/**
 * Turn the captured template into offsets from its anchor.
 *
 * ⚠️ The anchor is REMOVED, not emitted. Each faction already built the pole
 * they claimed; spawning a TerritoryFlag would stack a second pole on top of
 * theirs. And a template with no anchor would yield absolute coordinates,
 * piling every faction's kit at one spot on the map — silent and map-wide,
 * so it throws instead.
 */
export function loadTemplate(json: unknown): SpawnObject[] {
  const objects = (json as { Objects?: SpawnObject[] })?.Objects;
  if (!Array.isArray(objects)) throw new Error("supplies template: no Objects array");
  const anchors = objects.filter((o) => o.name === ANCHOR);
  if (anchors.length !== 1) {
    throw new Error(`supplies template: expected exactly one ${ANCHOR} anchor, found ${anchors.length}`);
  }
  // ⚠️ A KIT_QUANTITIES key that matches nothing in the template is a typo,
  // and its only symptom would be the template's own count shipping unchanged
  // — a kit quietly short by thirty logs, with nothing anywhere reporting it.
  // Checked here, against the real captured template, rather than in
  // generateSupplies, which is legitimately called with arbitrary offsets.
  const names = new Set(objects.map((o) => o.name));
  for (const name of KIT_QUANTITIES.keys()) {
    if (!names.has(name)) {
      throw new Error(`supplies template: KIT_QUANTITIES names ${name}, which the template does not contain`);
    }
  }

  const [ax, ay, az] = anchors[0]!.pos;
  return objects
    .filter((o) => o.name !== ANCHOR)
    .map((o) => ({ ...o, pos: [o.pos[0] - ax, o.pos[1] - ay, o.pos[2] - az] as [number, number, number] }));
}

/**
 * Render a number the way the template's own -0.0 yaw/pitch/roll values need:
 * JSON.stringify silently collapses -0 to "0", which would make the output
 * differ from a byte-identical re-run of the same input over that boundary.
 */
function numberLiteral(n: number): string {
  return Object.is(n, -0) ? "-0" : JSON.stringify(n);
}

function objectLiteral(o: SpawnObject): string {
  return (
    `{"name":${JSON.stringify(o.name)},` +
    `"pos":[${o.pos.map(numberLiteral).join(",")}],` +
    `"ypr":[${o.ypr.map(numberLiteral).join(",")}],` +
    `"scale":${numberLiteral(o.scale)},` +
    `"enableCEPersistency":${numberLiteral(o.enableCEPersistency)},` +
    `"customString":${JSON.stringify(o.customString)}}`
  );
}

/**
 * The exact bytes of the spawner file for these factions.
 *
 * Returns a string rather than an object because the upload tick hashes what
 * it uploads; hashing a re-serialised object could differ from the bytes sent.
 * Serialised by hand rather than via JSON.stringify so that -0.0 values in
 * the template (present in some ypr entries) survive round-tripping instead
 * of silently collapsing to 0 — see numberLiteral above.
 */
export function generateSupplies(offsets: SpawnObject[], factions: SupplyFaction[]): string {
  // How many of each name the template holds, so a KIT_QUANTITIES total can be
  // spread across them.
  const templateCounts = new Map<string, number>();
  for (const o of offsets) templateCounts.set(o.name, (templateCounts.get(o.name) ?? 0) + 1);

  const out: SpawnObject[] = [];
  for (const f of factions) {
    const seen = new Map<string, number>();
    for (const o of offsets) {
      const index = seen.get(o.name) ?? 0;
      seen.set(o.name, index + 1);
      const total = KIT_QUANTITIES.get(o.name);
      const copies = total === undefined ? 1 : copiesFor(total, templateCounts.get(o.name)!, index);
      const spawn: SpawnObject = {
        // The white flag in the template is the flag ITEM, not the pole.
        name: o.name === NEUTRAL_FLAG ? f.texture : o.name,
        pos: [o.pos[0] + f.x, o.pos[1] + f.y, o.pos[2] + f.z],
        ypr: o.ypr,
        scale: o.scale,
        enableCEPersistency: o.enableCEPersistency,
        // Ownership, so an operator can tell whose kit a stray barrel is.
        customString: f.tag,
      };
      for (let i = 0; i < copies; i++) out.push(spawn);
    }
  }
  return `{"Objects":[${out.map(objectLiteral).join(",")}]}`;
}
