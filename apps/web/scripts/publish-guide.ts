/**
 * Write the field guide into Discord, and keep it written.
 *
 * A reconciler, not a poster: it derives the channels and messages the
 * Field Guide category SHOULD hold from content/guide + lib/guide.ts (via
 * lib/guide-discord.ts), reads what the category DOES hold, and writes only
 * the difference — a channel that is missing, a message whose text changed,
 * a message that is no longer needed. Running it twice in a row does
 * nothing the second time. That is what makes it safe to run on every
 * deploy (deploy/deploy-web.sh) and every hour (deploy/systemd/
 * clan-wars-guide.timer): the Discord copy converges on the site's copy no
 * matter who edited what.
 *
 *   pnpm --filter @factions/web guide:publish            # reconcile
 *   pnpm --filter @factions/web guide:publish --dry-run  # say what would change
 *   pnpm --filter @factions/web guide:publish --prune    # also delete channels in the category it does not own
 *
 * Env: DISCORD_TOKEN, DISCORD_GUILD_ID, GUIDE_CATEGORY_ID (the "📖 Field Guide" category).
 *
 * ⚠️ Only the bot's own messages are managed. A message someone else posted
 * in one of these channels is left alone and reported; the category denies
 * Send Messages to @everyone, so there should be none.
 * ⚠️ `--prune` is the one destructive switch: it deletes hand-made channels
 * under the category. It is never passed by the deploy script or the timer.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHAPTERS, CONTENT_DIR } from "../lib/guide";
import { chapterMessages, contentsMessages, guideChannels } from "../lib/guide-discord";

const API = "https://discord.com/api/v10";
const DRY = process.argv.includes("--dry-run");
const PRUNE = process.argv.includes("--prune");
/** Suppress embeds (the site link would unfurl the share card under every chapter) and never ping. */
const MESSAGE_FLAGS = 4;
const NO_MENTIONS = { parse: [] as string[] };

function env(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`${key} is not set`);
  return v;
}
const TOKEN = env("DISCORD_TOKEN"), GUILD = env("DISCORD_GUILD_ID"), CATEGORY = env("GUIDE_CATEGORY_ID");

type Channel = { id: string; type: number; name: string; parent_id: string | null; topic: string | null; position: number; permission_overwrites: unknown[] };
type Message = { id: string; content: string; author: { id: string } };

let writes = 0;
async function discord<T>(method: string, path: string, body?: unknown): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${API}${path}`, {
      method, headers: { Authorization: `Bot ${TOKEN}`, "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 429) {
      const wait = Number((await res.json() as { retry_after: number }).retry_after) * 1000;
      await new Promise((r) => setTimeout(r, wait + 250));
      continue;
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text()}`);
    if (method !== "GET") { writes++; await new Promise((r) => setTimeout(r, 400)); }
    return res.status === 204 ? (undefined as T) : (await res.json() as T);
  }
}
async function write<T>(what: string, method: string, path: string, body?: unknown): Promise<T | undefined> {
  console.log(`${DRY ? "would " : ""}${what}`);
  return DRY ? undefined : discord<T>(method, path, body);
}

async function allMessages(channelId: string): Promise<Message[]> {
  const out: Message[] = [];
  let before = "";
  for (;;) {
    const page = await discord<Message[]>("GET", `/channels/${channelId}/messages?limit=100${before ? `&before=${before}` : ""}`);
    out.push(...page);
    if (page.length < 100) break;
    before = page[page.length - 1]!.id;
  }
  return out.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
}

async function main() {
  const me = await discord<{ id: string }>("GET", "/users/@me");
  const channels = await discord<Channel[]>("GET", `/guilds/${GUILD}/channels`);
  const category = channels.find((c) => c.id === CATEGORY && c.type === 4);
  if (!category) throw new Error(`GUIDE_CATEGORY_ID ${CATEGORY} is not a category in guild ${GUILD}`);
  const inCategory = channels.filter((c) => c.parent_id === CATEGORY && c.type === 0);

  // 1. Channels: one per chapter plus the contents, in order, with the category's permissions.
  const wanted = guideChannels();
  const byName = new Map(inCategory.map((c) => [c.name, c]));
  for (const [i, w] of wanted.entries()) {
    let ch = byName.get(w.name);
    if (!ch) {
      ch = await write<Channel>(`create #${w.name}`, "POST", `/guilds/${GUILD}/channels`, {
        name: w.name, type: 0, parent_id: CATEGORY, topic: w.topic, position: i, permission_overwrites: category.permission_overwrites,
      });
      if (ch) byName.set(w.name, ch);
      continue;
    }
    if ((ch.topic ?? "") !== w.topic) await write(`retitle #${w.name}`, "PATCH", `/channels/${ch.id}`, { topic: w.topic });
  }
  const order = wanted.map((w, i) => ({ id: byName.get(w.name)?.id, position: i })).filter((x): x is { id: string; position: number } => !!x.id);
  const misplaced = order.some((o) => inCategory.find((c) => c.id === o.id)?.position !== o.position);
  if (misplaced && order.length === wanted.length) await write("reorder the channels", "PATCH", `/guilds/${GUILD}/channels`, order);

  // 2. Messages: what each channel should say, given the channel ids that now exist.
  const ids = new Map<string, string>();
  for (const w of wanted) { const id = w.chapter && byName.get(w.name)?.id; if (w.chapter && id) ids.set(w.chapter.slug, id); }
  for (const w of wanted) {
    const ch = byName.get(w.name);
    if (!ch) { console.log(`skip #${w.name}: not created (dry run)`); continue; }
    const want = w.chapter
      ? chapterMessages(w.chapter, w.chapter.file ? readFileSync(join(CONTENT_DIR, w.chapter.file), "utf8") : null, ids)
      : contentsMessages(ids);
    const existing = await allMessages(ch.id);
    const foreign = existing.filter((m) => m.author.id !== me.id);
    if (foreign.length) console.log(`⚠️ #${w.name}: ${foreign.length} message(s) by someone else, left alone`);
    const mine = existing.filter((m) => m.author.id === me.id);
    let changed = 0;
    for (let i = 0; i < Math.max(mine.length, want.length); i++) {
      const have = mine[i], text = want[i];
      if (have && text !== undefined) {
        if (have.content !== text) { changed++; await write(`edit #${w.name} message ${i + 1}`, "PATCH", `/channels/${ch.id}/messages/${have.id}`, { content: text, flags: MESSAGE_FLAGS, allowed_mentions: NO_MENTIONS }); }
      } else if (text !== undefined) {
        changed++; await write(`post #${w.name} message ${i + 1}`, "POST", `/channels/${ch.id}/messages`, { content: text, flags: MESSAGE_FLAGS, allowed_mentions: NO_MENTIONS });
      } else if (have) {
        changed++; await write(`delete #${w.name} message ${i + 1}`, "DELETE", `/channels/${ch.id}/messages/${have.id}`);
      }
    }
    if (!changed) console.log(`#${w.name}: in sync (${want.length} message${want.length === 1 ? "" : "s"})`);
  }

  // 3. Channels in the category that are not the guide's.
  const owned = new Set(wanted.map((w) => w.name));
  for (const c of inCategory.filter((c) => !owned.has(c.name))) {
    if (PRUNE) await write(`delete #${c.name} (not part of the guide)`, "DELETE", `/channels/${c.id}`);
    else console.log(`ℹ️ #${c.name} is in the category but not part of the guide; pass --prune to delete it`);
  }
  console.log(DRY ? "dry run: nothing written" : `done: ${writes} write${writes === 1 ? "" : "s"}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
