import type { LiveHitLine, LiveHitRun, LiveKill, LiveLongRange, LiveSide, LiveStreak } from "@factions/domain";

/**
 * The feeds' wording as data, shared by the bot (Discord markdown) and the
 * site (JSX) so the two can never say different things
 * (spec 2026-09-30-website-live-feeds). Each feed's text is a list of Lines;
 * a Line is a list of segments. Fixed copy is a bare string. Player data is
 * `{ text }` when the bot has always escaped it and `{ raw }` when it has
 * always printed it bare: that split is what keeps Discord byte-identical.
 *
 * ⚠️ No Discord tokens here (`no-discord-tokens.test.ts`). An instant is a
 * `{ time, style }` segment, emitted only when it parses; each renderer
 * formats it its own way.
 */
export type Seg =
  | string
  | { text: string }
  | { raw: string }
  | { bold: Seg[] }
  | { player: string }
  | { clan: string; name?: string }
  | { time: string; style: "at" | "rel" }
  | { page: string; label: string };
export type Line = Seg[];

/** Title (an embed title on Discord), the page it links to, the body lines, and the per-hit lines below a gap. */
export type LiveCard = { title: Line; href: string; lines: Line[]; detail: Line[] };

/** ⚠️ Ten, not Discord's limit: a long firefight stops being readable first. */
export const DETAIL_LINE_CAP = 10;

export const playerPath = (gamertag: string): string => `/players/${encodeURIComponent(gamertag)}`;
export const clanPath = (tag: string): string => `/clans/${encodeURIComponent(tag)}`;

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const finite = (n: number | null): n is number => n !== null && Number.isFinite(n);

/** Join non-empty parts with " · ". */
function dotted(parts: Line[]): Line {
  const out: Line = [];
  for (const p of parts.filter((x) => x.length > 0)) {
    if (out.length > 0) out.push(" · ");
    out.push(...p);
  }
  return out;
}

export function who(side: LiveSide): Line {
  const name: Seg = { bold: [{ player: side.gamertag }] };
  return side.tag ? [name, " [", { clan: side.tag }, "]"] : [name];
}

/** The embed title: gamertag bare, tag escaped, exactly as the bot built it. */
function titleOf(prefix: string, side: LiveSide): Line {
  return [...(prefix ? [prefix] : []), { raw: side.gamertag }, ...(side.tag ? [" [", { text: side.tag }, "]"] : [])];
}

/** `KA-74 · 41 m`, or whichever half there is. */
export function howLine(weapon: string | null, distanceM: number | null): Line {
  return dotted([weapon ? [{ text: weapon }] : [], finite(distanceM) ? [`${Math.round(distanceM)} m`] : []]);
}

/** `38 dmg · Torso · KA-74 · 41 m`. The weapon only when asked: the hit feed names it once in the header. */
export function detailLine(d: LiveHitLine, opts: { weapon?: boolean } = {}): Line {
  return dotted([
    finite(d.damage) ? [`${Math.round(d.damage)} dmg`] : [],
    d.bodyPart ? [{ text: d.bodyPart }] : [],
    opts.weapon && d.weapon ? [{ text: d.weapon }] : [],
    finite(d.distanceM) ? [`${Math.round(d.distanceM)} m`] : [],
  ]);
}

export function cappedLines(lines: Line[], noun: string): Line[] {
  if (lines.length <= DETAIL_LINE_CAP) return lines;
  return [...lines.slice(0, DETAIL_LINE_CAP), [`… and ${lines.length - DETAIL_LINE_CAP} more ${noun}`]];
}

export function killCard(k: LiveKill): LiveCard {
  const verb = k.cause === "finished" ? "finished" : "killed";
  const scope = k.tally.season === null ? "all-time" : "this season";
  const how = howLine(k.weapon, k.distanceM);
  return {
    title: titleOf(k.atHub ? "At the Hub — " : k.friendlyFire ? "Friendly fire — " : "", k.killer),
    href: playerPath(k.killer.gamertag),
    lines: [
      k.friendlyFire ? [`${verb} their own clanmate `, ...who(k.victim)] : [`${verb} `, ...who(k.victim)],
      ...(how.length > 0 ? [how] : []),
      [`${plural(k.tally.killerKills, "kill")} for `, { text: k.killer.gamertag }, ` · ${plural(k.tally.victimDeaths, "death")} for `, { text: k.victim.gamertag }, ` ${scope}`],
    ],
    detail: cappedLines(k.hits.map((h) => detailLine(h, { weapon: true })).filter((l) => l.length > 0), "hits"),
  };
}

export function hitCard(h: LiveHitRun): LiveCard {
  const times = h.hits.length === 1 ? "once" : `${h.hits.length} times`;
  const head: Line = [`hit `, ...who(h.victim), ` ${times}`, ...(h.weapon ? [" · ", { text: h.weapon }] : [])];
  const summary = dotted([
    finite(h.totalDamage) ? [`${Math.round(h.totalDamage)} damage`] : [],
    finite(h.victimHpAfter) ? [`left them at ${Math.round(h.victimHpAfter)} HP`] : [],
  ]);
  return {
    title: titleOf(h.friendlyFire ? "Friendly fire — " : "", h.attacker),
    href: playerPath(h.attacker.gamertag),
    lines: [head, ...(summary.length > 0 ? [summary] : [])],
    detail: cappedLines(h.hits.map((x) => detailLine(x)).filter((l) => l.length > 0), "hits"),
  };
}

function elapsed(fromIso: string, toIso: string): string {
  const s = Math.max(0, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000));
  if (!Number.isFinite(s)) return plural(0, "second");
  if (s < 60) return plural(s, "second");
  const m = Math.round(s / 60);
  if (m < 60) return plural(m, "minute");
  return plural(Math.round(s / 3600), "hour");
}

export function streakCard(s: LiveStreak): LiveCard {
  const names = cappedLines(s.victims.map((v) => [{ text: v }]), "victims");
  const joined: Line = [];
  names.forEach((n, i) => { if (i > 0) joined.push(", "); joined.push(...n); });
  return {
    title: titleOf("", s.killer),
    href: playerPath(s.killer.gamertag),
    lines: [
      ["🔥 ", { bold: [`${s.streak} kill streak`] }],
      ...(s.victims.length > 0 ? [[`last ${s.victims.length}: `, ...joined]] : []),
      [`started ${elapsed(s.startedAt, s.occurredAt)} ago`],
    ],
    detail: [],
  };
}

function ordinal(n: number): string {
  const r = n % 100;
  if (r >= 11 && r <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
}

export function longRangeCard(l: LiveLongRange): LiveCard {
  const scope = l.season === null ? "all-time" : "this season";
  const records = dotted([
    l.personalBest ? [{ text: l.killer.gamertag }, "'s longest yet"] : [],
    l.seasonRank !== null ? [l.seasonRank === 1 ? `longest ${scope}` : `${ordinal(l.seasonRank)} longest ${scope}`] : [],
  ]);
  return {
    title: titleOf(l.friendlyFire ? "Friendly fire — " : "", l.killer),
    href: playerPath(l.killer.gamertag),
    lines: [
      ["🎯 ", { bold: [`${l.distanceM === null ? "—" : Math.round(l.distanceM)} m`] }],
      ["killed ", ...who(l.victim), ...(l.weapon ? [" · ", { text: l.weapon }] : [])],
      ...(records.length > 0 ? [records] : []),
    ],
    detail: [],
  };
}
