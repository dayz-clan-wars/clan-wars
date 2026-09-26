import { cutHash } from "../engine/animation/episodeCache.js";
import { formatBanter } from "../engine/llm/formatBanter.js";
import type { DiscordEmbed, OutMessage } from "../engine/publish/discord.js";
import type { Redaction } from "../screening/redact.js";
import { escapeRe } from "../screening/redact.js";

export const DRAFT_MARKER_PREFIX = "show:";
const EMBED_MAX = 4096;
const MESSAGE_EMBED_TOTAL = 6000;
const CONTENT_MAX = 2000;

const day = (d: Date) => d.toISOString().slice(0, 10);
/**
 * ⚠️ Keyed on the cut, not only the week: after `--force` the new cut must never adopt the old
 * cut's draft, whose ❌ would re-reject it silently or whose ✅ would publish an unreviewed cut.
 */
export const draftMarker = (weekStart: Date, narrative: string) => `${DRAFT_MARKER_PREFIX}${day(weekStart)}:${cutHash(narrative)}`;

/** Spec §7.3: a redacted name is drawn as `[REDACTED]`; the same goes for every published string. */
export const publicText = (s: string) => s.replace(/REDACTED_(?:PLAYER|CLAN)_\d+/gu, "[REDACTED]");
// ⚠️ Player-facing copy carries no em or en dash (standing rule); the model's are normalized in parse, this is the net.
export const noDashes = (s: string) => s.replace(/\s*[–—]\s*/gu, ", ");
/** The same net applied everywhere published copy leaves this process: YouTube, Discord, Facebook. */
export const publicCopy = (s: string) => noDashes(publicText(s));

export const forumThreadName = (code: string, subtitle: string) => `Clan Wars ${code} · ${publicCopy(subtitle)}`.slice(0, 100);

/**
 * ⚠️ The ops channel is a Discord channel, not the operator's terminal: a held reason or an
 * error must not carry a blocked gamertag, a blocklist term or a moderator's quote of one.
 * Reasons are reduced to their category; anything else has each blocked string masked.
 */
export function opsSafe(reason: string, blocked: string[]): string {
  const m = /^(attempt \d+(?: \(trimmed(?: \d+)?\))?): (.*)$/su.exec(reason);
  const [prefix, body] = m ? [`${m[1]}: `, m[2]!] : ["", reason];
  if (body.startsWith("blocklist:")) return `${prefix}blocklist hit`;
  if (body.startsWith("blocked text:")) return `${prefix}a blocked name came back`;
  if (body.startsWith("moderation:")) return `${prefix}moderation flagged it`;
  // ⚠️ OpenRouter's error body (engine/llm/openrouter.ts: `openrouter <status>: <body>`) can quote
  // flagged model output; only the status goes to the ops channel.
  const or = /^openrouter (\d{3}): /u.exec(body);
  if (or) return `${prefix}openrouter ${or[1]}`;
  // ⚠️ Unparsed script content quoted after "not a dialogue line:" is never screened; drop the excerpt
  if (body.startsWith("not a dialogue line:")) return `${prefix}not a dialogue line`;
  const masked = [...blocked].sort((a, b) => b.length - a.length)
    .reduce((acc, b) => acc.replace(new RegExp(escapeRe(b), "giu"), "[blocked text]"), body);
  return prefix + masked;
}

function redactionSummary(rs: Redaction[]): string {
  if (rs.length === 0) return "Screening: nothing redacted.";
  const names = rs.filter((r) => r.replacement !== null).length;
  const dropped = rs.length - names;
  const parts = [names ? `${names} name${names === 1 ? "" : "s"} redacted` : "", dropped ? `${dropped} pitch or bounty reason dropped` : ""].filter(Boolean);
  return `Screening: ${parts.join(", ")}. See \`pnpm show:screening --show <week>\` on the host.`;
}

export function draftMessage(o: { weekStart: Date; code: string; subtitle: string; youtubeVideoId: string; narrative: string; redactions: Redaction[]; scriptAttempts: number }): OutMessage {
  const content = [
    `**Clan Wars ${o.code} · ${publicText(o.subtitle)}** is ready for review (unlisted): https://youtu.be/${o.youtubeVideoId}`,
    "React ✅ to publish or ❌ to reject. Only approvers count.",
    redactionSummary(o.redactions),
    `Script passed on attempt ${o.scriptAttempts}.`,
    `-# ${draftMarker(o.weekStart, o.narrative)}`,
  ].join("\n");
  return {
    content: content.slice(0, CONTENT_MAX),
    files: [{ name: "transcript.txt", data: Buffer.from(noDashes(publicText(o.narrative)), "utf8"), contentType: "text/plain; charset=utf-8" }],
  };
}

const lengthOnly = (reasons: string[]) => reasons.length > 0 && reasons.every((r) => /: script is \d+ characters, cap is \d+$/u.test(r));

export function heldMessage(o: { code: string; weekStart: Date; reasons: string[]; blocked: string[] }): OutMessage {
  const lines = [
    `⚠️ Clan Wars ${o.code} is held: no script passed its checks in two attempts.`,
    ...o.reasons.map((r) => `- ${opsSafe(r, o.blocked)}`),
    // A length-only hold needs nothing but another roll; a screening hold needs an override first.
    lengthOnly(o.reasons)
      ? `Every attempt was too long. Run \`pnpm run show --week ${day(o.weekStart)} --force\` to try again.`
      : `Change the overrides with \`pnpm show:screening\`, then run \`pnpm run show --week ${day(o.weekStart)} --force\`.`,
  ];
  return { content: lines.join("\n").slice(0, CONTENT_MAX) };
}

export function alertMessage(o: { code: string; stage: string; attempts: number; error: string; blocked: string[] }): OutMessage {
  const err = opsSafe(o.error, o.blocked).slice(0, 1500);
  return { content: `⚠️ Clan Wars ${o.code} has failed ${o.attempts} times at stage "${o.stage}". Timer runs keep retrying.\n\`\`\`\n${err}\n\`\`\``.slice(0, CONTENT_MAX) };
}

/** Line-boundary chunks of at most `max` characters (a single longer line is hard-split). */
function chunk(text: string, max: number): string[] {
  const out: string[] = [];
  let cur = "";
  for (const line of text.split("\n")) {
    for (let piece = line; ; ) {
      const add = cur ? `${cur}\n${piece}` : piece;
      if (add.length <= max) { cur = add; break; }
      if (cur) { out.push(cur); cur = ""; continue; }
      out.push(piece.slice(0, max));
      piece = piece.slice(max);
      if (!piece) break;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * The forum transcript (spec §9.3): `formatBanter` (hosts bold caps, names in backticks), in
 * embeds of at most 4,096 characters packed into messages of at most 6,000, the mp3 attached
 * to the first message.
 */
export function transcriptMessages(o: { narrative: string; names: string[]; mp3: Buffer }): OutMessage[] {
  const text = formatBanter(noDashes(publicText(o.narrative)), o.names);
  const embeds: DiscordEmbed[] = chunk(text, EMBED_MAX).map((description) => ({ description }));
  const messages: OutMessage[] = [];
  let cur: DiscordEmbed[] = [];
  let total = 0;
  for (const e of embeds) {
    if (cur.length === 10 || total + e.description.length > MESSAGE_EMBED_TOTAL) { messages.push({ embeds: cur }); cur = []; total = 0; }
    cur.push(e);
    total += e.description.length;
  }
  if (cur.length) messages.push({ embeds: cur });
  if (messages.length === 0) messages.push({ content: "(no transcript)" });
  messages[0] = { ...messages[0], files: [{ name: "episode.mp3", data: o.mp3, contentType: "audio/mpeg" }] };
  return messages;
}
