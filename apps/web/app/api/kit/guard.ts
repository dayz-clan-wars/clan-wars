import type { NextResponse } from "next/server";
import { boosterKit } from "@factions/roster";
import { kitView, type KitView } from "@/lib/kit-view";
import { json, sessionOr401 } from "@/lib/api";

/**
 * The kit writes' gate.
 *
 * ⚠️ Re-reads the session AND the booster state on every write, exactly as
 * the server actions this replaced did. A route handler is a POST endpoint
 * anyone who can send the request can reach; rendering the pickers only for a
 * booster is not a check.
 *
 * ⚠️ A refusal here is 403 with a `reason` the page looks up, never a thrown
 * error. The page saves as you pick, so "you are not boosting any more" has
 * to arrive as a sentence beside the tile rather than as a dead fetch.
 */
export async function boosterOnly(): Promise<{ discordId: string } | { response: NextResponse }> {
  const s = await sessionOr401();
  if ("response" in s) return { response: s.response };
  const view = await boosterKit(s.session.sub);
  if (!view.boosting) return { response: json({ ok: false, reason: "not-boosting" }, 403) };
  return { discordId: s.session.sub };
}

/**
 * What every kit write answers with: the whole page state, re-read after the
 * write landed.
 *
 * ⚠️ Re-read, never patched from what the caller sent. Drawing a sequence
 * changes the challenge; a witnessed emote changes the spot; a save changes
 * one slot. Handing back the server's own view of all three is what stops the
 * page and the database disagreeing until the next poll.
 */
export async function freshView(discordId: string): Promise<KitView> {
  return kitView(await boosterKit(discordId));
}
