import type { NextResponse } from "next/server";
import { award } from "@factions/roster";
import { awardPageView, type AwardPageView } from "@/lib/award-view";
import { json, sessionOr401 } from "@/lib/api";

/**
 * The award writes' gate: a session, and a grant id that parses.
 *
 * ⚠️ Ownership is NOT checked here. Every roster call takes the viewer's id
 * and puts it in its WHERE, so another player's grant answers `not-found`
 * exactly like a missing one. A check here as well would be a second
 * statement of that rule, and the one that drifts.
 */
export async function awardGate(params: Promise<{ id: string }>): Promise<{ discordId: string; grantId: number } | { response: NextResponse }> {
  const s = await sessionOr401();
  if ("response" in s) return { response: s.response };
  const grantId = Number((await params).id);
  if (!Number.isInteger(grantId) || grantId <= 0) return { response: json({ ok: false, reason: "not-found" }, 404) };
  return { discordId: s.session.sub, grantId };
}

/** The whole page state, re-read after a write, never patched from the request. */
export async function freshAward(discordId: string, grantId: number): Promise<AwardPageView | null> {
  const v = await award(discordId, grantId);
  return v ? awardPageView(v, new Date()) : null;
}
