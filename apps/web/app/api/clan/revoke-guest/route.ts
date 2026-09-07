import type { NextRequest, NextResponse } from "next/server";
import { revokeGuestPass } from "@factions/roster";
import { formAction, id } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /clan/settings. Officer+; revokes an open guest pass early. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session, form) => {
    const passId = id(form, "passId");
    if (passId === null) return code("input", "bad-input");
    return code("revoke-guest", await revokeGuestPass(session.sub, passId));
  });
}
