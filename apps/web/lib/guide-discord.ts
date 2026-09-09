import { GUIDE_GROUPS, GUIDE_NUMBERS } from "@factions/domain";
import { CHAPTERS, hrefFor, type Chapter } from "./guide";
import { substituteTokens } from "@/app/guide/render";

/**
 * The field guide as Discord messages. One channel per chapter under the
 * Field Guide category, each chapter a run of messages under Discord's
 * 2000-character cap, rendered from the SAME fragments and the SAME number
 * tokens the site renders — so the two cannot say different things. The
 * reconciler in scripts/publish-guide.ts writes what this file returns and
 * nothing else; everything here is pure so test/guide-discord.test.ts can
 * hold every chapter to the cap.
 *
 * Discord's markdown is a small subset, and it renders in a narrow column on
 * a phone, so the conversion is opinionated: headings become `##`, rules and
 * "what the server can see" callouts become quotes, a short table becomes a
 * code block and a wide one becomes bullet rows, and a link to another
 * chapter becomes that chapter's channel mention when the channel exists.
 *
 * ⚠️ The fragments are our own HTML (content/guide), not user input. The
 * parser below understands exactly the elements they use — the test fails
 * on any element it does not, which is the signal to extend it here rather
 * than let a new tag leak into Discord as angle brackets.
 */

export const SITE = "https://dayzclanwars.com";
/** Discord's hard cap is 2000; the margin keeps edits safe from the odd escape. */
export const MESSAGE_MAX = 1900;
/** The channel that opens the category: the table of contents. */
export const CONTENTS_CHANNEL = "00-start-here";

/** `01-what-this-is` … `13-rules-on-one-page`, `a-every-number`. Discord lowercases and dashes channel names; these already are. */
export function channelNameFor(c: Chapter): string {
  const n = /^\d+$/u.test(c.number) ? c.number.padStart(2, "0") : c.number.toLowerCase();
  const slug = c.slug || "what-this-is";
  return `${n}-${slug}`;
}

/** Every channel the publisher owns, in sidebar order. */
export function guideChannels(): { name: string; chapter: Chapter | null; topic: string }[] {
  return [
    { name: CONTENTS_CHANNEL, chapter: null, topic: `The player's guide to Clan Wars, chapter by chapter. Also at ${SITE}/guide` },
    ...CHAPTERS.map((c) => ({ name: channelNameFor(c), chapter: c, topic: `${c.lede} ${SITE}${hrefFor(c)}`.slice(0, 1024) })),
  ];
}

/** slug → channel id, from what exists in Discord. Empty before the channels are created (a dry run): links fall back to the site. */
export type ChannelIds = ReadonlyMap<string, string>;

// ---------------------------------------------------------------- HTML → tree

type El = { tag: string; attrs: Record<string, string>; children: (El | string)[] };
const VOID = new Set(["br"]);
const KNOWN = new Set(["div", "p", "h2", "h3", "ul", "ol", "li", "strong", "em", "code", "a", "span", "br", "table", "tbody", "thead", "tr", "th", "td"]);

export function parse(html: string): El {
  const root: El = { tag: "#root", attrs: {}, children: [] };
  const stack: El[] = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*?)(\/?)>|([^<]+)/gu;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    if (m[0].startsWith("<!--")) continue;
    const [, close, tagRaw, attrText, selfClose, text] = m;
    if (text !== undefined) { stack[stack.length - 1]!.children.push(text); continue; }
    const tag = tagRaw!.toLowerCase();
    if (!KNOWN.has(tag)) throw new Error(`guide-discord: no rendering for <${tag}>`);
    if (close) {
      const i = stack.map((e) => e.tag).lastIndexOf(tag);
      if (i > 0) stack.length = i;
      continue;
    }
    const attrs: Record<string, string> = {};
    for (const a of attrText!.matchAll(/([a-zA-Z-]+)="([^"]*)"/gu)) attrs[a[1]!] = a[2]!;
    const el: El = { tag, attrs, children: [] };
    stack[stack.length - 1]!.children.push(el);
    if (!VOID.has(tag) && !selfClose) stack.push(el);
  }
  return root;
}

// ---------------------------------------------------------------- inline text

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“",
  mdash: "—", ndash: "–", hellip: "…", larr: "←", rarr: "→", times: "×",
};
export function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/giu, (whole, e: string) => {
    if (e.startsWith("#x")) return String.fromCodePoint(parseInt(e.slice(2), 16));
    if (e.startsWith("#")) return String.fromCodePoint(parseInt(e.slice(1), 10));
    return ENTITIES[e] ?? whole;
  });
}
/** Plain text, safe inside Discord markdown: nothing in it can open a style, a spoiler or a mention. */
export function escape(s: string): string {
  return decode(s).replace(/[\\*_~`|]/gu, (c) => `\\${c}`).replace(/@/gu, "@​");
}
const ws = (s: string) => s.replace(/\s+/gu, " ");

function inline(nodes: (El | string)[], ids: ChannelIds): string {
  let out = "";
  for (const n of nodes) {
    if (typeof n === "string") { out += escape(ws(n)); continue; }
    switch (n.tag) {
      case "strong": out += `**${inline(n.children, ids).trim()}**`; break;
      case "em": out += `*${inline(n.children, ids).trim()}*`; break;
      case "code": out += `\`${decode(text(n.children)).replace(/`/gu, "'")}\``; break;
      case "br": out += "\n"; break;
      case "a": out += link(n, ids); break;
      case "span": out += inline(n.children, ids); break;
      default: out += inline(n.children, ids);
    }
  }
  return out;
}
function text(nodes: (El | string)[]): string {
  return nodes.map((n) => (typeof n === "string" ? n : text(n.children))).join("");
}
/** A chapter link → its channel, when the channel exists; any other link → the site. */
function link(a: El, ids: ChannelIds): string {
  const label = inline(a.children, ids).trim();
  const href = a.attrs.href ?? "";
  const m = /^\/guide(?:\/([a-z0-9-]+))?(?:#.*)?$/u.exec(href);
  if (m) {
    const slug = m[1] ?? "";
    const id = ids.get(slug);
    return id ? `${label} <#${id}>` : `${label} (${SITE}${href.replace(/#.*$/u, "")})`;
  }
  return href.startsWith("/") ? `${label} (${SITE}${href})` : href ? `${label} (${href})` : label;
}

// ---------------------------------------------------------------- blocks

/** A block is one paragraph-level unit; chunks are built from whole blocks so a message never opens a list or a quote it cannot close. */
function blocks(nodes: (El | string)[], ids: ChannelIds, quote = false): string[] {
  const out: string[] = [];
  const q = (s: string) => (quote ? s.split("\n").map((l) => `> ${l}`).join("\n") : s);
  for (const n of nodes) {
    if (typeof n === "string") { if (n.trim()) out.push(q(escape(ws(n)).trim())); continue; }
    switch (n.tag) {
      case "h2": out.push(q(`## ${inline(n.children, ids).trim()}`)); break;
      case "h3": out.push(q(`### ${inline(n.children, ids).trim()}`)); break;
      case "p": { const t = inline(n.children, ids).trim(); if (t) out.push(q(t)); break; }
      case "ul": case "ol": {
        const items = n.children.filter((c): c is El => typeof c !== "string" && c.tag === "li");
        out.push(items.map((li, i) => q(`${n.tag === "ol" ? `${i + 1}.` : "-"} ${inline(li.children, ids).trim()}`)).join("\n"));
        break;
      }
      case "div": out.push(...callout(n, ids, quote)); break;
      case "table": out.push(q(table(n, ids))); break;
      case "span": { const t = inline(n.children, ids).trim(); if (t) out.push(q(t)); break; }
      default: out.push(...blocks(n.children, ids, quote));
    }
  }
  return out;
}

/**
 * The guide's boxes. `rule` and `human` are the rule itself, quoted.
 * `log` is "what the server can see": quoted under its own bold title.
 * `post` is a mock Discord message: quoted, channel name bold. `onepage`
 * and `tablewrap` are layout only.
 */
function callout(div: El, ids: ChannelIds, quote: boolean): string[] {
  const cls = div.attrs.class ?? "";
  if (cls === "onepage" || cls === "tablewrap") return blocks(div.children, ids, quote);
  if (cls === "log") {
    const title = div.children.find((c): c is El => typeof c !== "string" && c.tag === "span");
    const rest = div.children.filter((c) => c !== title);
    const head = `> 🛰️ **${title ? inline(title.children, ids).trim() : "What the server can see"}**`;
    return [[head, ...blocks(rest, ids, true)].join("\n")];
  }
  if (cls === "post") {
    const ch = div.children.find((c): c is El => typeof c !== "string" && c.tag === "span");
    const rest = div.children.filter((c) => c !== ch);
    const body = inline(rest, ids).trim().split("\n").map((l) => `> ${l.trim()}`).join("\n");
    return [`> **${ch ? decode(text(ch.children)) : "#channel"}**\n${body}`];
  }
  // rule, human, or an unclassed div: the whole thing as one quote.
  return [blocks(div.children, ids, true).join("\n> \n")];
}

/**
 * A short table (every cell ≤ 32 chars) becomes a code block with aligned
 * columns — the towns list. A wide one becomes bullet rows: first cell bold,
 * the rest joined with " — ", under an italic line naming the columns.
 */
function table(t: El, ids: ChannelIds): string {
  const rows: { cells: string[]; group: boolean }[] = [];
  const walk = (nodes: (El | string)[]) => {
    for (const n of nodes) {
      if (typeof n === "string") continue;
      if (n.tag === "tr") {
        const cells = n.children.filter((c): c is El => typeof c !== "string" && (c.tag === "td" || c.tag === "th"));
        rows.push({ cells: cells.map((c) => inline(c.children, ids).trim()), group: (n.attrs.class ?? "").includes("group") });
      } else walk(n.children);
    }
  };
  walk(t.children);
  const plain = (s: string) => s.replace(/\\([\\*_~`|])/gu, "$1").replace(/\*\*/gu, "");
  const wide = rows.some((r) => r.cells.some((c) => plain(c).length > 32));
  if (wide) {
    const [head, ...body] = rows;
    const lines = body.map((r) => (r.group ? `**${r.cells[0]}**` : `- ${r.cells[0]} — ${r.cells.slice(1).join(" — ")}`));
    return [head ? `*${head.cells.map(plain).join(" — ")}*` : "", ...lines].filter(Boolean).join("\n");
  }
  const widths: number[] = [];
  for (const r of rows) if (!r.group) r.cells.forEach((c, i) => { widths[i] = Math.max(widths[i] ?? 0, plain(c).length); });
  const line = (r: { cells: string[]; group: boolean }) => r.group
    ? `— ${plain(r.cells[0] ?? "")} —`
    : r.cells.map((c, i) => plain(c).padEnd(i === r.cells.length - 1 ? 0 : widths[i]!)).join("  ").trimEnd();
  return `\`\`\`\n${rows.map(line).join("\n")}\n\`\`\``;
}

// ---------------------------------------------------------------- chunks

/** Whole blocks per message, under the cap; a code block too long for one message is split at line breaks and re-fenced. */
export function chunk(blocksIn: string[], max = MESSAGE_MAX): string[] {
  const out: string[] = [];
  let cur = "";
  const push = () => { if (cur.trim()) out.push(cur.trim()); cur = ""; };
  for (const b of blocksIn) {
    const pieces = b.length > max ? splitLong(b, max) : [b];
    for (const p of pieces) {
      if (cur && cur.length + 2 + p.length > max) push();
      cur = cur ? `${cur}\n\n${p}` : p;
    }
  }
  push();
  return out;
}
function splitLong(b: string, max: number): string[] {
  const fenced = b.startsWith("```") && b.endsWith("```");
  const lines = (fenced ? b.slice(4, -4) : b).split("\n");
  const out: string[] = [];
  let cur: string[] = [];
  const budget = max - 8;
  for (const l of lines) {
    if (cur.join("\n").length + l.length + 1 > budget && cur.length) { out.push(cur.join("\n")); cur = []; }
    cur.push(l);
  }
  if (cur.length) out.push(cur.join("\n"));
  return out.map((s) => (fenced ? `\`\`\`\n${s}\n\`\`\`` : s));
}

// ---------------------------------------------------------------- chapters

/** A chapter's messages: the opener, the body in order, the site link last. */
export function chapterMessages(c: Chapter, fragment: string | null, ids: ChannelIds): string[] {
  const opener = `# ${c.number}. ${escape(c.title)}\n*${escape(c.lede)}*`;
  const body = fragment === null ? appendixBlocks() : blocks(parse(substituteTokens(fragment)).children, ids);
  const footer = `-# Read this chapter on the site: ${SITE}${hrefFor(c)}`;
  return chunk([opener, ...body, footer]);
}

/** The "Every number" appendix, from the same table the site renders. */
export function appendixBlocks(): string[] {
  const out = ["Every timer, cap, radius and cooldown in the guide, in one place. Each one is read from the same rule the server enforces, so this table and the chapters cannot disagree."];
  for (const g of GUIDE_GROUPS) {
    const rows = GUIDE_NUMBERS.filter((r) => r.group === g);
    if (rows.length === 0) continue;
    out.push(`## ${escape(g)}\n${rows.map((r) => `- ${escape(r.label)}: **${escape(r.value)}**`).join("\n")}`);
  }
  return out;
}

/** The contents channel: every chapter, its channel, its lede. */
export function contentsMessages(ids: ChannelIds): string[] {
  const rows = CHAPTERS.map((c) => {
    const id = ids.get(c.slug);
    const where = id ? `<#${id}>` : `${SITE}${hrefFor(c)}`;
    return `**${c.number}.** ${where}\n-# ${escape(c.lede)}`;
  });
  return chunk([
    `# Field Guide\nThe player's guide to Clan Wars. One chapter per channel, in order. The same guide is on the site at ${SITE}/guide — this copy is written from it and rewritten whenever it changes, so edit the site, never these channels.`,
    ...rows,
  ]);
}
