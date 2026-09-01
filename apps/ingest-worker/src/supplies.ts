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
  const out: SpawnObject[] = [];
  for (const f of factions) {
    for (const o of offsets) {
      out.push({
        // The white flag in the template is the flag ITEM, not the pole.
        name: o.name === NEUTRAL_FLAG ? f.texture : o.name,
        pos: [o.pos[0] + f.x, o.pos[1] + f.y, o.pos[2] + f.z],
        ypr: o.ypr,
        scale: o.scale,
        enableCEPersistency: o.enableCEPersistency,
        // Ownership, so an operator can tell whose kit a stray barrel is.
        customString: f.tag,
      });
    }
  }
  return `{"Objects":[${out.map(objectLiteral).join(",")}]}`;
}
