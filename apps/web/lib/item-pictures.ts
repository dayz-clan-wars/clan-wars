// Matches supplied item pictures (files named by in-game name) to item cards. Pure, so the
// rules are tested without the pictures. The pictures are community-supplied with an
// unconfirmed source: see public/map-data/nasdara/pictures/README.md.
import type { ItemCard } from "./item-cards";

/** Lowercase letters and digits only, so "M4-A1" and "m4 a1" meet. */
export const normalise = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/gu, "");

const BRACKET = /\(([^()]*)\)\s*$/u;
const stem = (file: string) => file.replace(/\.[^.]+$/u, "");

/**
 * className → file. ⚠️ Order matters: a file with "(class)" in its name belongs to that one
 * class and is never offered to other cards by display name (a "Glass Bottle (winebottle)"
 * must not dress every other "Glass Bottle"); plain files match by normalised display name
 * and may serve several cards (colour variants). Files are taken in sorted order so a
 * duplicate normalised name resolves the same way every run.
 */
export function matchPictures(files: string[], cards: Pick<ItemCard, "className" | "displayName">[]): Map<string, string> {
  const out = new Map<string, string>();
  const byClass = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const f of [...files].sort()) {
    const s = stem(f);
    const m = BRACKET.exec(s);
    if (m) {
      const k = m[1]!.trim().toLowerCase();
      if (!byClass.has(k)) byClass.set(k, f);
    } else {
      const k = normalise(s);
      if (k && !byName.has(k)) byName.set(k, f);
    }
  }
  for (const c of cards) {
    const file = byClass.get(c.className.toLowerCase()) ?? byName.get(normalise(c.displayName));
    if (file) out.set(c.className, file);
  }
  return out;
}
