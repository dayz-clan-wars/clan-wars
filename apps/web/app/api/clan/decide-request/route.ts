import type { NextRequest, NextResponse } from "next/server";
import { decideRequest } from "@factions/roster";
import { formAction, id } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /clan. Officer+; accepts or declines an open request to join. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan", async (session, form) => {
    const requestId = id(form, "requestId");
    const decision = form.get("decision");
    if (requestId === null || (decision !== "accepted" && decision !== "declined")) return code("input", "bad-input");
    return code("decide", await decideRequest(session.sub, requestId, decision));
  });
}
