export const DISCORD_API = "https://discord.com/api/v10";
/** ⚠️ Discord's Cloudflare front rejects a request with no User-Agent (house memory: Discord post mechanics). */
export const DISCORD_USER_AGENT = "DiscordBot (https://dayzclanwars.com, 1.0)";

export type DiscordFile = { name: string; data: Buffer; contentType: string };
export type DiscordEmbed = { description: string; title?: string };
export type OutMessage = { content?: string; embeds?: DiscordEmbed[]; files?: DiscordFile[] };
export type SeenMessage = { id: string; content: string; authorId: string; embeds: number; attachments: number };
export type Discord = {
  me(): Promise<string>;
  post(channelId: string, msg: OutMessage): Promise<{ id: string }>;
  react(channelId: string, messageId: string, emoji: string): Promise<void>;
  reactionUserIds(channelId: string, messageId: string, emoji: string): Promise<string[]>;
  recentMessages(channelId: string, limit?: number): Promise<SeenMessage[]>;
  createForumThread(forumId: string, name: string, msg: OutMessage): Promise<{ threadId: string }>;
  /** Every thread with the name: Discord allows duplicates, and a `--repost` makes one. */
  findForumThreads(guildId: string, forumId: string, name: string): Promise<string[]>;
  /** One message, or null when it is gone (404). */
  message(channelId: string, messageId: string): Promise<SeenMessage | null>;
};

export class DiscordHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

type RawMessage = { id: string; content: string; author: { id: string }; embeds?: unknown[]; attachments?: unknown[] };
const seen = (m: RawMessage): SeenMessage => ({ id: m.id, content: m.content, authorId: m.author.id, embeds: m.embeds?.length ?? 0, attachments: m.attachments?.length ?? 0 });

// ⚠️ Gamertags and clan names are player-controlled; a message must never ping anyone.
const NO_MENTIONS = { parse: [] as string[] };

const MAX_429_ATTEMPTS = 5;

/** Bot-token REST, no gateway (spec §9.3). Retries a 429 after Discord's retry_after (bounded); any other non-2xx throws. */
export function createDiscord(deps: { token: string; fetchImpl?: typeof fetch; sleep?: (ms: number) => Promise<void> }): Discord {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function call<T>(method: string, path: string, body?: unknown, form?: FormData): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const headers: Record<string, string> = { Authorization: `Bot ${deps.token}`, "User-Agent": DISCORD_USER_AGENT };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetchImpl(`${DISCORD_API}${path}`, { method, headers, body: form ?? (body === undefined ? undefined : JSON.stringify(body)) });
      if (res.status === 429) {
        const text = await res.text();
        let retryAfter: unknown;
        try { retryAfter = (JSON.parse(text) as { retry_after?: unknown }).retry_after; } catch { /* not JSON: see below */ }
        // ⚠️ Bounded: a Cloudflare 1015 ban answers 429 with an HTML page and no retry_after, and
        // retrying it forever would hang the run while it holds the advisory lock. No numeric
        // retry_after throws at once; a real rate limit gets at most MAX_429_ATTEMPTS tries.
        if (typeof retryAfter !== "number" || !Number.isFinite(retryAfter)) throw new DiscordHttpError(`Discord ${method} ${path} failed 429 with no retry_after: ${text.slice(0, 300)}`, 429);
        if (attempt >= MAX_429_ATTEMPTS) throw new DiscordHttpError(`Discord ${method} ${path} failed 429 after ${attempt} attempts`, 429);
        await sleep(Math.ceil(retryAfter * 1000) + 250);
        continue;
      }
      if (!res.ok) throw new DiscordHttpError(`Discord ${method} ${path} failed ${res.status}: ${(await res.text()).slice(0, 300)}`, res.status);
      return (res.status === 204 ? undefined : await res.json()) as T;
    }
  }

  const payload = (msg: OutMessage) => ({
    ...(msg.content !== undefined ? { content: msg.content } : {}),
    ...(msg.embeds?.length ? { embeds: msg.embeds } : {}),
    allowed_mentions: NO_MENTIONS,
  });

  return {
    async me() {
      return (await call<{ id: string }>("GET", "/users/@me")).id;
    },
    async post(channelId, msg) {
      if (!msg.files?.length) return call<{ id: string }>("POST", `/channels/${channelId}/messages`, payload(msg));
      const form = new FormData();
      form.append("payload_json", JSON.stringify({ ...payload(msg), attachments: msg.files.map((f, i) => ({ id: i, filename: f.name })) }));
      msg.files.forEach((f, i) => form.append(`files[${i}]`, new Blob([new Uint8Array(f.data)], { type: f.contentType }), f.name));
      return call<{ id: string }>("POST", `/channels/${channelId}/messages`, undefined, form);
    },
    async react(channelId, messageId, emoji) {
      await call<void>("PUT", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`);
    },
    async reactionUserIds(channelId, messageId, emoji) {
      const users = await call<{ id: string }[]>("GET", `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}?limit=100`);
      return users.map((u) => u.id);
    },
    async recentMessages(channelId, limit = 50) {
      const ms = await call<RawMessage[]>("GET", `/channels/${channelId}/messages?limit=${limit}`);
      return ms.map(seen);
    },
    async message(channelId, messageId) {
      try {
        return seen(await call<RawMessage>("GET", `/channels/${channelId}/messages/${messageId}`));
      } catch (e) {
        if (e instanceof DiscordHttpError && e.status === 404) return null;
        throw e;
      }
    },
    async createForumThread(forumId, name, msg) {
      const t = await call<{ id: string }>("POST", `/channels/${forumId}/threads`, { name, message: payload(msg) });
      return { threadId: t.id };
    },
    async findForumThreads(guildId, forumId, name) {
      type Threads = { threads: { id: string; parent_id: string; name: string }[] };
      const pick = (t: Threads) => t.threads.filter((x) => x.parent_id === forumId && x.name === name).map((x) => x.id);
      const active = pick(await call<Threads>("GET", `/guilds/${guildId}/threads/active`));
      // One page of archived threads is ample: the show posts one thread a week.
      return [...active, ...pick(await call<Threads>("GET", `/channels/${forumId}/threads/archived/public?limit=100`))];
    },
  };
}
