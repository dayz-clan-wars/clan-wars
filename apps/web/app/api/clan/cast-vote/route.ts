import type { NextRequest, NextResponse } from "next/server";
import { castVote } from "@factions/roster";
import { formAction, confirmed } from "@/lib/form";
import { leadershipCode } from "@/lib/leadership-copy";

/** POST from /clan. Full members in the vote's electorate only; requires the confirm checkbox. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan", async (session, form) => {
    if (!confirmed(form)) return leadershipCode("cast-vote", "unconfirmed");
    return leadershipCode("cast-vote", await castVote(session.sub));
  });
}
