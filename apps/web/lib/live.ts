import { liveFeed } from "@factions/roster";
import type { LiveFeed } from "@factions/domain";
import { toLiveItem, type LiveItem } from "./live-items";

export * from "./live-items";

export async function loadLive(feed: Exclude<LiveFeed, "online">, q: { before?: number; after?: number }): Promise<LiveItem[]> {
  return (await liveFeed(feed, q)).map(toLiveItem);
}
