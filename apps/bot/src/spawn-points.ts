import { maskComments } from "./events-xml.js";

/**
 * cfgplayerspawnpoints.xml with every `<group>` inside `<fresh>`'s
 * `<generator_posbubbles>` removed except `group`: a King of the Hill session
 * spawns every fresh character at that one town's spots (spec
 * 2026-10-07-koth-chernarus §3.1).
 *
 * ⚠️ A targeted splice, never a parse-and-reserialize: the file belongs to the
 * chernarus repo, and everything but the removed group lines comes back
 * byte-identical, `<hop>`/`<travel>` groups of the same name included.
 * Located in the comment-masked text, so a commented-out group is neither taken
 * for the real one nor counted as a duplicate.
 *
 * ⚠️ Throws rather than returning the input: an un-narrowed file would open a
 * "King of the Hill" with players spawning all over the map, and report success.
 */
export function narrowFreshSpawns(xml: string, group: string): string {
  const masked = maskComments(xml);
  const fresh = /<fresh>[\s\S]*?<\/fresh>/.exec(masked);
  if (!fresh) throw new Error("cfgplayerspawnpoints.xml: no <fresh> section");
  const bubbles = /<generator_posbubbles>([\s\S]*?)<\/generator_posbubbles>/.exec(fresh[0]);
  if (!bubbles) throw new Error("cfgplayerspawnpoints.xml: <fresh> has no <generator_posbubbles>");
  const innerFrom = fresh.index + bubbles.index + "<generator_posbubbles>".length;
  const inner = masked.slice(innerFrom, innerFrom + bubbles[1]!.length);
  // Whole lines: leading indent, the block, trailing spaces and one newline.
  // ⚠️ A self-closing `<group … />` is its own alternative: matched as an open tag,
  // it ran on to the NEXT group's `</group>` and took that group with it.
  const groups = [...inner.matchAll(/[ \t]*<group\s+name="([^"]*)"(?:[^>]*\/>|[^>]*>[\s\S]*?<\/group>)[ \t]*\r?\n?/g)];
  const keep = groups.filter((g) => g[1] === group);
  if (keep.length === 0) throw new Error(`cfgplayerspawnpoints.xml: <fresh> has no group "${group}"`);
  if (keep.length > 1) throw new Error(`cfgplayerspawnpoints.xml: <fresh> group "${group}" appears more than once — refusing to guess`);
  if (!/<pos\s/.test(keep[0]![0])) throw new Error(`cfgplayerspawnpoints.xml: <fresh> group "${group}" has no <pos>`);
  let out = "";
  let cursor = 0;
  for (const g of groups) {
    if (g[1] === group) continue;
    const from = innerFrom + g.index!;
    out += xml.slice(cursor, from);
    cursor = from + g[0].length;
  }
  return out + xml.slice(cursor);
}
