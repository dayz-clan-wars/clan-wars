import type { NextRequest, NextResponse } from "next/server";
import { openVote } from "@factions/roster";
import { formAction, text, confirmed } from "@/lib/form";
import { leadershipCode } from "@/lib/leadership-copy";
import { code } from "@/lib/clan-copy";

/** POST from /clan. Full members (not the leader) only; requires the confirm checkbox. Every eligibility rule lives in @factions/roster. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan", async (session, form) => {
    if (!confirmed(form)) return leadershipCode("open-vote", "unconfirmed");
    const target = text(form, "target", 32);
    if (!target || !/^\d+$/u.test(target)) return code("input", "bad-input");
    const { outcome } = await openVote(session.sub, target);
    return leadershipCode("open-vote", outcome);
  });
}
