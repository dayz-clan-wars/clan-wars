import type { NextRequest, NextResponse } from "next/server";
import { addReferrer, viewerFor } from "@factions/roster";
import { formAction, text } from "@/lib/form";
import { GAMERTAG_MAX } from "@/lib/clan-limits";
import { code } from "@/lib/clan-copy";

/**
 * Name a referrer from the player's own profile (`AccountPanel`), never a
 * later change: `addReferrer` refuses a second attempt as "already-referred"
 * — the record is permanent (global constraint), and this route makes no
 * exception to it.
 *
 * ⚠️ The redirect target is the caller's OWN profile, read fresh from
 * `viewerFor` rather than trusted from the form — a referral only ever shows
 * up on the page that already renders it.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/me", async (session, form) => {
    const viewer = await viewerFor(session.sub);
    const back = viewer.link ? `/players/${encodeURIComponent(viewer.link.gamertag)}` : "/me";
    const referrer = text(form, "referrer", GAMERTAG_MAX);
    if (!referrer) return { back, code: code("referral", "input") };
    const outcome = await addReferrer(session.sub, referrer, "later_site");
    if (outcome.kind === "recorded") return { back, code: code("referral", "recorded") };
    // H2: a refused attempt keeps what was typed.
    return { back, code: code("referral", outcome.reason), keep: { referrer } };
  });
}
