import { BAN_REASON_TEXT, type BanAnnouncementKind, type BanReason, type FactionEventKind, type LiveHitLine, type LiveHitRun, type LiveKill, type LiveLongRange, type LiveSide, type LiveStreak, type WarLogKind } from "@factions/domain";

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

/** An ISO instant as a time segment, or null when it does not parse: the caller drops the clause (war-log-text.ts's rule). */
function instant(iso: unknown, style: "at" | "rel"): Seg | null {
  if (typeof iso !== "string") return null;
  return Number.isFinite(Date.parse(iso)) ? { time: iso, style } : null;
}

export const flagLabel = (texture: string): string => texture.replace(/^Flag_/u, "");

export const flagDownDuration = (seconds: number): string =>
  `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;

export type ClanFeedPayload = { name: string; tag: string; texture: string; actor?: string; previousName?: string; disbandAt?: string };

const DORMANT_SENTENCE = "Gone dormant — the flag has not been raised, and supplies are cut.";
const by = (actor: string | undefined): Line => (actor ? [" by ", { bold: [{ raw: actor }] }] : []);

function clanFeedLine(kind: FactionEventKind, p: ClanFeedPayload): Line {
  switch (kind) {
    case "founded": return ["Founded", ...by(p.actor), ". The ritual is complete — the flag is reserved."];
    case "activated": return ["Colors raised", ...by(p.actor), ". The clan is live."];
    case "renamed": return ["Now flying as ", { bold: [{ raw: p.name }] }, " — formerly ", { bold: [{ raw: p.previousName ?? "its former name" }] }, "."];
    case "rebound": return ["Moved its base", ...by(p.actor), "."];
    case "dormant": {
      const t = instant(p.disbandAt, "rel");
      return t ? [`${DORMANT_SENTENCE} The flag, tag and pole return to the pool `, t, "."] : [DORMANT_SENTENCE];
    }
    case "revived": return ["Active again — the flag is flying and supplies resume at the next restart."];
    case "disbanded": return ["Disbanded. Its flag, tag and pole return to the pool."];
    case "lapsed": return [`Never raised their flag. ${flagLabel(p.texture)} is back in the pool.`];
  }
}

export function clanFeedCard(kind: FactionEventKind, p: ClanFeedPayload): LiveCard {
  return { title: [{ raw: p.name }, " [", { raw: p.tag }, "]"], href: clanPath(p.tag), lines: [clanFeedLine(kind, p)], detail: [] };
}

const clanSeg = (name: unknown, tag: unknown): Seg =>
  typeof tag === "string" && tag !== "" ? { clan: tag, name: String(name) } : { bold: [{ raw: String(name) }] };

export function warLogLine(kind: WarLogKind, p: Record<string, unknown>, occurredAt?: string): Line {
  switch (kind) {
    case "raid":
      return p.solo
        ? ["⚔️ ", clanSeg(p.victimClan, p.victimTag), " was raided — flag lowered by ", { player: String(p.gamertag) }, " (no clan)"]
        : ["⚔️ ", clanSeg(p.raiderClan, p.raiderTag), " raided ", clanSeg(p.victimClan, p.victimTag), " — flag lowered by ", { player: String(p.gamertag) }];
    case "defense":
      return ["🛡️ ", clanSeg(p.victimClan, p.victimTag), ` raised their colors again — ${flagDownDuration(Number(p.durationSeconds))} under siege`];
    case "week_closed": {
      if (p.first === null) return ["🏆 No Alphas this week — nobody scored."];
      const entries: [unknown, unknown, unknown][] = [[p.first, p.t1, p.p1], [p.second, p.t2, p.p2], [p.third, p.t3, p.p3]];
      const present = entries.filter((e) => e[0] !== null && e[0] !== undefined);
      const names: Line = [];
      present.forEach(([name, tag], i) => { if (i > 0) names.push(", "); names.push(clanSeg(name, tag)); });
      return ["🏆 Alphas this week: ", ...names, ` — ${present.map(([, , pts]) => pts).join(" / ")}`];
    }
    case "season_closed": {
      const t = instant(occurredAt, "at");
      const closed: Line = t ? [`Season ${p.number} is over `, t, "."] : [`Season ${p.number} is over.`];
      const link: Line = ["Full table: ", { page: "/seasons", label: "seasons" }];
      return p.clan === null
        ? ["🏁 ", ...closed, " Nobody scored. ", ...link]
        : ["🏁 ", ...closed, " Champion: ", clanSeg(p.clan, p.tag), ` with ${p.points}. `, ...link];
    }
  }
}

export function banLine(a: { kind: BanAnnouncementKind; gamertag: string; reason: BanReason; expiresAt: string | null }): Line {
  const tag: Seg = { bold: [{ text: a.gamertag }] };
  if (a.kind === "expired") return ["🔓 ", tag, " unbanned — ban served."];
  if (a.kind === "lifted") return a.reason === "unlinked_pc" ? ["🔓 ", tag, " unbanned — account linked."] : ["🔓 ", tag, " unbanned."];
  if (a.reason === "unlinked_pc") return ["🔨 ", tag, " banned — playing on PC without a linked account. Link your account to lift it."];
  if (a.expiresAt === null) return ["🔨 ", tag, ` banned permanently — ${BAN_REASON_TEXT[a.reason]}.`];
  const t = instant(a.expiresAt, "at");
  return t
    ? ["🔨 ", tag, " banned until ", t, ` — ${BAN_REASON_TEXT[a.reason]}.`]
    : ["🔨 ", tag, ` banned — ${BAN_REASON_TEXT[a.reason]}.`];
}

const DISCORD_ID = /^\d+$/u;

export function achievementLine(p: Record<string, unknown>): Line {
  const owner: Seg = p.ownerKind === "clan"
    ? (p.clanTag ? { bold: [{ clan: String(p.clanTag) }] } : { bold: [{ raw: `[${p.ownerName}]` }] })
    : (p.gamertag
      ? { bold: [{ player: String(p.gamertag) }] }
      : { bold: [{ raw: p.ownerName === null || p.ownerName === undefined || DISCORD_ID.test(String(p.ownerName)) ? "A player" : String(p.ownerName) }] });
  return [owner, " unlocked ", { bold: [{ raw: String(p.name) }] }, " · ", { raw: String(p.description) }];
}

export const ONLINE_TITLE = (n: number): string => `Players online · ${n}`;
export const ONLINE_EMPTY = "Nobody on the server.";

export function onlineLine(p: { gamertag: string; tag: string | null; connectedAt: string }): Line {
  const t = instant(p.connectedAt, "rel");
  return [{ bold: [{ player: p.gamertag }] }, ...(p.tag ? [" [", { clan: p.tag }, "]"] as Line : []), " · on since ", t ?? "an unknown time"];
}
