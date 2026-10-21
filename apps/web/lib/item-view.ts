// The item view: a searched item drawn alone on the map, and the panel that says how it
// reaches players. Pure — the switches as values, the panel as lines — so map-view.tsx only
// wires it up and item-panel.tsx only renders it.
import { CARD_COPY, ITEM_COPY, tierLabel } from "./map-copy";
import type { ItemCard } from "./item-cards";
import { spawnsAnywhere, type ItemIndexEntry } from "./item-index";
import { ITEM_ALWAYS_MAX, eventLabel, type WorldLayerKey, type WorldMark, type WorldSwitches } from "./world-layers";
import type { WorldFile } from "./map-world";

/** `model`: a building or object picked from the Models tab, `className` then being its type name. */
export type ItemPick = { className: string; label: string; model?: true };
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
  // ⚠️ A model pick and an item pick share this one view: picking either replaces the other, and
  // `saved` still comes from the very first of them.
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

/**
 * A model's panel: the chip and how many the map places. `points` null (world file not in) leaves
 * the count out, as itemPanel does. Past ITEM_ALWAYS_MAX the points wait for a close zoom, so the
 * line says so, the same rule as an item's.
 */
export function modelPanel(label: string, points: readonly WorldMark[] | null, map: Pick<ItemPanelMap, "zoomedIn"> = { zoomedIn: false }): ItemPanelModel {
  const chip = ITEM_COPY.modelChip(label);
  if (points === null) return { chip, lines: [] };
  const n = ITEM_COPY.placed(points.length);
  return { chip, lines: [{ label: ITEM_COPY.onMap, text: points.length > ITEM_ALWAYS_MAX && !map.zoomedIn ? `${n} ${ITEM_COPY.zoomIn}` : n }] };
}

/** The card's head (picture, name, weight and size, description) and its lists as panel lines. */
export type ItemCardModel = { title: string; image: string | null; description: string; facts: ItemPanelLine[]; lines: ItemPanelLine[] };

/** How many names a card list shows before "and N more": a plate carrier takes 26 things. */
const CARD_LIST_SHOWN = 8;

/** 90 → "90 g", 2276 → "2.28 kg": the game's grams, as a player would say them. */
const weightText = (g: number) => (g < 1000 ? `${g} g` : `${Number((g / 1000).toFixed(2))} kg`);

/**
 * What the item is. Lists name each class by its own card's display name, once per name: the
 * three colours of the OE buttstock are one "M4-A1 OE Buttstock". A class with no card keeps
 * its class name rather than vanishing.
 */
export function itemCardView(card: ItemCard, cards: ReadonlyMap<string, ItemCard>): ItemCardModel {
  const facts: ItemPanelLine[] = [];
  if (card.weightG !== null) facts.push({ label: CARD_COPY.weight, text: weightText(card.weightG) });
  if (card.size) facts.push({ label: CARD_COPY.size, text: `${card.size[0]} × ${card.size[1]}` });
  const lines: ItemPanelLine[] = [];
  const list = (label: string, classes: readonly string[]) => {
    const names = [...new Set(classes.map((c) => cards.get(c)?.displayName ?? c))];
    if (names.length === 0) return;
    const rest = names.length - CARD_LIST_SHOWN;
    const shown = names.slice(0, CARD_LIST_SHOWN).join(", ");
    lines.push({ label, text: rest > 0 ? `${shown}${ITEM_COPY.more(rest)}` : shown });
  };
  list(CARD_COPY.attachments, card.attachments);
  list(CARD_COPY.magazines, card.magazines);
  list(CARD_COPY.ammo, card.ammo);
  return { title: card.displayName, image: card.image, description: card.description, facts, lines };
}

/**
 * The panel with the card's lists added AFTER its own lines: the panel is "where it spawns"
 * first. ⚠️ Into the panel's one scroller, not a second list in the card: a scroller inside the
 * phone's scrolling sheet traps a swipe. No card (cards failed to load) is the panel unchanged.
 */
export function withCard(model: ItemPanelModel, card: ItemCardModel | null): ItemPanelModel {
  return card ? { ...model, lines: [...model.lines, ...card.lines] } : model;
}
