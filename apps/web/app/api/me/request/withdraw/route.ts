import type { NextRequest, NextResponse } from "next/server";
import { withdrawRequest } from "@factions/roster";
import { formAction, id } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /me. Withdrawing pulls back your own outstanding join request; it decides nothing for the clan. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/me", async (session, form) => {
    const requestId = id(form, "requestId");
    if (requestId === null) return code("input", "bad-input");
    const ok = await withdrawRequest(session.sub, requestId);
    return code("withdraw", ok ? "withdrawn" : "gone");
  });
}
