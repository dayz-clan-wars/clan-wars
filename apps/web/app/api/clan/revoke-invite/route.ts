import type { NextRequest, NextResponse } from "next/server";
import { revokeInvite } from "@factions/roster";
import { formAction, id } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /clan. Officer+; withdraws an outstanding invite. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan", async (session, form) => {
    const inviteId = id(form, "inviteId");
    if (inviteId === null) return code("input", "bad-input");
    return code("revoke", await revokeInvite(session.sub, inviteId));
  });
}
