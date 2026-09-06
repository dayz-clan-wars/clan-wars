import type { NextRequest, NextResponse } from "next/server";
import { requestJoin } from "@factions/roster";
import { formAction } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from the Request to join button. Recruiting, cap, cooldown and one-open-request are the package's. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ tag: string }> }): Promise<NextResponse> {
  const { tag } = await ctx.params;
  const back = `/clans/${encodeURIComponent(tag)}`;
  return formAction(req, back, async (session) => {
    const { outcome } = await requestJoin(session.sub, tag);
    return code("request", outcome);
  });
}
