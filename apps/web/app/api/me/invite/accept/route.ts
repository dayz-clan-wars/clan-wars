import type { NextRequest, NextResponse } from "next/server";
import { acceptInvite } from "@factions/roster";
import { formAction, id } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /me. Accepting makes a PENDING member; the cap and cooldown are the package's. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/me", async (session, form) => {
    const inviteId = id(form, "inviteId");
    if (inviteId === null) return code("input", "bad-input");
    return code("accept", await acceptInvite(session.sub, inviteId));
  });
}
