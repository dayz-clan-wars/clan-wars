import type { NextRequest } from "next/server";
import { onlineNow } from "@factions/roster";
import { isLiveFeed } from "@factions/domain";
import { json } from "@/lib/api";
import { loadLive, parseCursor } from "@/lib/live";

/**
 * The Live page's poll (spec 2026-09-30-website-live-feeds). Public, like the
 * page: the same feeds the bot posts to Discord, never a coordinate. A read;
 * mutates nothing (test/api-routes.test.ts allows it a GET).
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ feed: string }> }) {
  const { feed } = await ctx.params;
  if (!isLiveFeed(feed)) return json({ error: "unknown-feed" }, 404);
  if (feed === "online") {
    const players = await onlineNow();
    return json({ players: players.map((p) => ({ ...p, connectedAt: p.connectedAt.toISOString() })) });
  }
  const sp = req.nextUrl.searchParams;
  return json({ items: await loadLive(feed, { before: parseCursor(sp.get("before")), after: parseCursor(sp.get("after")) }) });
}
