export const YOUTUBE_TITLE_MAX = 100;
export const YOUTUBE_DESCRIPTION_MAX = 5000;
const TRUNC_NOTICE = "… [transcript truncated]";
const PREFIX = "The Bloodbag and Painkiller Show: Clan Wars ";

// YouTube rejects `<` and `>` anywhere in a title or description.
const noAngles = (s: string) => s.replace(/[<>]/gu, "");
// Plain text for the description: markdown backticks and bold/italic markers go, names stay (KOTH).
const stripMarkdown = (s: string) => s.replace(/[`*_]/gu, "");

/** Spec §2.4. The series prefix keeps these apart from the KOTH episodes on the same channel. */
export function videoTitle(code: string, subtitle: string): string {
  const head = `${PREFIX}${code} · `;
  return head + noAngles(subtitle).slice(0, YOUTUBE_TITLE_MAX - head.length).trim();
}

export function buildVideoMeta(o: { code: string; subtitle: string; transcript: string }): { title: string; description: string } {
  let description = noAngles(stripMarkdown(o.transcript));
  if (description.length > YOUTUBE_DESCRIPTION_MAX) description = description.slice(0, YOUTUBE_DESCRIPTION_MAX - TRUNC_NOTICE.length) + TRUNC_NOTICE;
  return { title: videoTitle(o.code, o.subtitle), description };
}
