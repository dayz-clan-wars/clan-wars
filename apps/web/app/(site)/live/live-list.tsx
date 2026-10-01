"use client";
import { useEffect, useRef, useState } from "react";
import { LIVE_PAGE_SIZE, type LiveFeed } from "@factions/domain";
// ⚠️ Only the pure half: "@/lib/live" imports @factions/roster at runtime.
import { mergePoll, pollMayHaveGap, type LiveItem } from "@/lib/live-items";
import { visiblePoll } from "@/lib/visible-poll";
import { btnSecondary } from "@/app/components/ui";
import { LiveCardView } from "./live-card";

export const LIVE_POLL_MS = 15_000;

/**
 * The tab's entries, newest first. While the newest page is on screen (`live`)
 * it polls for `after=<newest id>` and puts new entries on top. "Older" fetches
 * `before=<oldest id>` and appends. Both go through /api/live/<feed>.
 */
export function LiveList({ feed, initial, live }: { feed: Exclude<LiveFeed, "online">; initial: LiveItem[]; live: boolean }) {
  const [items, setItems] = useState(initial);
  const [more, setMore] = useState(initial.length >= LIVE_PAGE_SIZE);
  const [busy, setBusy] = useState(false);
  const newest = useRef(initial[0]?.id ?? 0);

  useEffect(() => {
    if (!live) return;
    return visiblePoll(document, async () => {
      try {
        const qs = newest.current > 0 ? `?after=${newest.current}` : "";
        const r = await fetch(`/api/live/${feed}${qs}`, { cache: "no-store" });
        if (!r.ok) return;
        const { items: fresh } = (await r.json()) as { items: LiveItem[] };
        if (fresh.length === 0) return;
        // A full page replaces the list (see mergePoll), so newest is its top, never a jump past a gap.
        newest.current = Math.max(newest.current, fresh[0]!.id);
        setItems((cur) => mergePoll(cur, fresh, LIVE_PAGE_SIZE).items);
        if (pollMayHaveGap(fresh, LIVE_PAGE_SIZE)) setMore(true);
      } catch { /* a missed poll is retried in 15 s */ }
    }, LIVE_POLL_MS);
  }, [feed, live]);

  async function older() {
    const last = items[items.length - 1];
    if (!last || busy) return;
    setBusy(true);
    try {
      const r = await fetch(`/api/live/${feed}?before=${last.id}`, { cache: "no-store" });
      if (!r.ok) return;
      const { items: page } = (await r.json()) as { items: LiveItem[] };
      setItems((cur) => {
        const seen = new Set(cur.map((i) => i.id));
        return [...cur, ...page.filter((i) => !seen.has(i.id))];
      });
      if (page.length < LIVE_PAGE_SIZE) setMore(false);
    } catch { /* the button stays; pressing it again retries */ } finally {
      setBusy(false);
    }
  }

  if (items.length === 0) return <p className="text-ink-2">Nothing here yet. It fills in as it happens on the server.</p>;
  return (
    <>
      <ol className="divide-y divide-rule">{items.map((i) => <LiveCardView key={i.id} item={i} />)}</ol>
      {more && <div className="mt-4"><button type="button" className={btnSecondary} onClick={older} disabled={busy}>Older</button></div>}
    </>
  );
}
