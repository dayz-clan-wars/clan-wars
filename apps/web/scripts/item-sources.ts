// Pure helpers for build-item-index.ts, kept out of the script so a test can call them without
// running the build.
import { CLAIMABLE_FLAGS } from "@factions/domain";
// ⚠️ supplies.ts is pure (its only import is @factions/domain); it's supply-tick.ts that opens a
// database. Importing it means the index reads the kit from the worker's own generator instead
// of a second statement of its substitution rules.
import { generateSupplies, loadTemplate } from "../../ingest-worker/src/supplies";

/**
 * Every class the supply kit can spawn, from the worker's captured template: the file the
 * worker would write for one supplied clan per claimable flag.
 */
export function supplyKitClasses(template: unknown): string[] {
  const clans = CLAIMABLE_FLAGS.map((texture) => ({ tag: "X", texture, x: 0, y: 0, z: 0, supplied: true }));
  const file = JSON.parse(generateSupplies(loadTemplate(template), clans)) as { Objects: { name: string }[] };
  return [...new Set(file.Objects.map((o) => o.name))].sort();
}
