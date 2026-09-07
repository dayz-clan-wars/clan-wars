import type { NextRequest, NextResponse } from "next/server";
import { claimSuccession } from "@factions/roster";
import { formAction, confirmed } from "@/lib/form";
import { leadershipCode } from "@/lib/leadership-copy";

/** POST from /clan. Full members only; requires the confirm checkbox. Every eligibility rule lives in @factions/roster. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan", async (session, form) => {
    if (!confirmed(form)) return leadershipCode("claim-succession", "unconfirmed");
    return leadershipCode("claim-succession", await claimSuccession(session.sub));
  });
}
