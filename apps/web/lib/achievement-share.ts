/**
 * The owner line under a share card's description: `{gamertag} · [{tag}] ·
 * earned {date}`, each part optional, from the card URL's query. Clipped
 * hard — the line is drawn into an image at a fixed width, and a long or
 * odd value must degrade to a short one rather than run off the card.
 */
export type ShareCardParams = { gamertag: string | null; tag: string | null; earned: Date | null };

const GAMERTAG_MAX = 24;
const TAG_MAX = 5;
/** Printable, single-line: control characters and line breaks are dropped, not drawn. */
const clean = (v: string | null, max: number): string | null => {
  const s = (v ?? "").replace(/[^\x20-\x7e]/gu, "").trim().slice(0, max);
  return s.length ? s : null;
};

export function shareCardParams(q: URLSearchParams): ShareCardParams {
  const earned = q.get("earned");
  const d = earned ? new Date(earned) : null;
  return { gamertag: clean(q.get("gamertag"), GAMERTAG_MAX), tag: clean(q.get("tag"), TAG_MAX)?.toUpperCase() ?? null, earned: d && !Number.isNaN(d.getTime()) ? d : null };
}

/** ⚠️ UTC, like every date the site prints. */
const day = (d: Date) => d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export function shareCardLine(p: ShareCardParams): string {
  return [p.gamertag, p.tag ? `[${p.tag}]` : null, p.earned ? `earned ${day(p.earned)}` : null].filter((s): s is string => s !== null).join(" · ");
}
