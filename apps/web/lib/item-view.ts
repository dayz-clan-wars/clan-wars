// The item view: a searched item drawn alone on the map, and the panel that says how it
// reaches players. Pure — the switches as values, the panel as lines — so map-view.tsx only
// wires it up and item-panel.tsx only renders it.
import { ITEM_COPY, tierLabel } from "./map-copy";
import { spawnsAnywhere, type ItemIndexEntry } from "./item-index";
import { ITEM_ALWAYS_MAX, eventLabel, type WorldLayerKey, type WorldMark, type WorldSwitches } from "./world-layers";
import type { WorldFile } from "./map-world";

export type ItemPick = { className: string; label: string };
/** The item shown, and the switches as they were before the first pick: what Clear puts back. */
export type ItemView = ItemPick & { saved: WorldSwitches };
export type WorldState = { sw: WorldSwitches; view: ItemView | null };

/**
 * Show one item: every world layer off, so its points stand alone.
 * ⚠️ `saved` is taken from the FIRST pick only. A second pick while one is shown must not
 * save the all-off switches, or Clear would leave the player with an empty layers panel.
 * The tiers stay as they are: they hide nothing while every layer is off.
 */
export function pickItem(s: WorldState, pick: ItemPick): WorldState {
  const saved = s.view?.saved ?? s.sw;
  return { sw: { on: Object.fromEntries(Object.keys(saved.on).map((k) => [k, false])), tiers: saved.tiers }, view: { ...pick, saved } };
}

/** Clear: the switches exactly as they were before the item was picked. */
export function clearItem(s: WorldState): WorldState {
  return s.view ? { sw: s.view.saved, view: null } : s;
}

/**
 * A layer switch clicked while an item is shown ends the item view first: the player asked
 * for layers back, and flipping one switch on an all-off panel would lose the rest of theirs.
 * ⚠️ During the view the click turns that layer ON, never flips the saved value: every switch
 * reads off, so flipping one that was on before the pick did the opposite of the click.
 */
export function toggleWorldLayer(s: WorldState, key: WorldLayerKey): WorldState {
  const { sw } = clearItem(s);
  return { sw: { ...sw, on: { ...sw.on, [key]: s.view ? true : !sw.on[key] } }, view: null };
}

export function toggleWorldTier(s: WorldState, bit: number): WorldState {
  const { sw } = clearItem(s);
  return { sw: { ...sw, tiers: sw.tiers ^ bit }, view: null };
}

export type ItemPanelLine = { label: string; text: string };
export type ItemPanelModel = { chip: string; lines: ItemPanelLine[] };

/** How many parents "Comes on" names before "and N more": a Rag rides on 179 zombie and clothing classes. */
const COMES_ON_SHOWN = 6;

/** "ContaminatedArea" → "Contaminated area", "MilitaryEast" → "Military east". */
const usageLabel = (name: string) => name.replace(/([a-z])([A-Z])/gu, (_, a: string, b: string) => `${a} ${b.toLowerCase()}`);
const namesOf = (list: readonly string[], mask: number) => list.filter((_, i) => (mask & (1 << i)) !== 0);

/**
 * What the panel reads from the map rather than the item. `delootAt`: the events whose wrecks
 * hold this deloot item (world-layers.ts delootEvents), null without the world file.
 * `zoomedIn`: the map is at LOOT_MIN_ZOOM or closer, where every item point is drawn.
 */
export type ItemPanelMap = { delootAt: readonly string[] | null; zoomedIn: boolean };

/**
 * The panel's lines, in order: where it is on the map, how many the server keeps, where and
 * which tier as building loot, then every other way it arrives.
 *
 * `points` is null when the world file is not in: the spot count is then left out rather than
 * read as "no spot". `limits` names the item's masks (items.json and world.json share them).
 */
export function itemPanel(
  item: ItemIndexEntry,
  label: string,
  points: readonly WorldMark[] | null,
  limits: WorldFile["limits"],
  map: ItemPanelMap = { delootAt: null, zoomedIn: false },
): ItemPanelModel {
  const chip = ITEM_COPY.chip(label);
  if (!spawnsAnywhere(item)) return { chip, lines: [{ label: ITEM_COPY.where, text: ITEM_COPY.none }] };
  const lines: ItemPanelLine[] = [];
  if (points !== null) {
    if (points.length === 0) lines.push({ label: ITEM_COPY.where, text: ITEM_COPY.noSpot });
    else {
      const spots = ITEM_COPY.spots(points.length);
      // Past ITEM_ALWAYS_MAX the points wait for LOOT_MIN_ZOOM, so only a zoomed-out map hides them.
      lines.push({ label: ITEM_COPY.onMap, text: points.length > ITEM_ALWAYS_MAX && !map.zoomedIn ? `${spots} ${ITEM_COPY.zoomIn}` : spots });
    }
  }
  if (item.nominal > 0) {
    lines.push({ label: ITEM_COPY.howMany, text: item.min > 0 ? `${ITEM_COPY.upTo(item.nominal)} ${ITEM_COPY.restock(item.min)}` : ITEM_COPY.upTo(item.nominal) });
  }
  // Building loot only: deloot and usage-less items never sit at a building's loot point (canSpawnAt).
  if (item.nominal > 0 && item.usage !== 0 && !item.deloot) {
    lines.push({ label: ITEM_COPY.foundIn, text: namesOf(limits.usage, item.usage).map(usageLabel).join(", ") });
    lines.push({ label: ITEM_COPY.tiers, text: item.value === 0 ? ITEM_COPY.anyTier : namesOf(limits.value, item.value).map(tierLabel).join(", ") });
  }
  // Only the events whose wrecks match it; none is no line (the "Where" line already says no spot).
  const at = map.delootAt;
  if (item.deloot && at === null) lines.push({ label: ITEM_COPY.crashLabel, text: ITEM_COPY.crash });
  else if (item.deloot && at !== null && at.length > 0) lines.push({ label: ITEM_COPY.crashLabel, text: at.map(eventLabel).join(", ") });
  if (item.events.length > 0) lines.push({ label: ITEM_COPY.events, text: [...new Set(item.events.map(eventLabel))].join(", ") });
  if (item.proxy) lines.push({ label: ITEM_COPY.proxyLabel, text: ITEM_COPY.proxy });
  if (item.attachedTo.length > 0) {
    const shown = item.attachedTo.slice(0, COMES_ON_SHOWN).join(", ");
    const rest = item.attachedTo.length - COMES_ON_SHOWN;
    lines.push({ label: ITEM_COPY.comesOn, text: rest > 0 ? `${shown}${ITEM_COPY.more(rest)}` : shown });
  }
  if (item.spawnGear) lines.push({ label: ITEM_COPY.spawnGearLabel, text: ITEM_COPY.spawnGear });
  for (const c of item.clanWars) lines.push({ label: ITEM_COPY.clanWarsLabel, text: ITEM_COPY.clanWars[c] });
  return { chip, lines };
}
