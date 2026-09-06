import type { NextRequest, NextResponse } from "next/server";
import { declineInvite } from "@factions/roster";
import { formAction, id } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /me. Declining answers an invite sent to you; it does not touch the clan's roster. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/me", async (session, form) => {
    const inviteId = id(form, "inviteId");
    if (inviteId === null) return code("input", "bad-input");
    const ok = await declineInvite(session.sub, inviteId);
    return code("decline", ok ? "declined" : "gone");
  });
}
