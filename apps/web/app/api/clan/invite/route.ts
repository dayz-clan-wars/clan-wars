import type { NextRequest, NextResponse } from "next/server";
import { invite } from "@factions/roster";
import { formAction, text } from "@/lib/form";
import { GAMERTAG_MAX } from "@/lib/clan-limits";
import { code } from "@/lib/clan-copy";

/** POST from /clan. Officer+; the invitee is named by gamertag and must be linked. Cap and cooldown are the package's. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan", async (session, form) => {
    const gamertag = text(form, "gamertag", GAMERTAG_MAX);
    if (!gamertag) return code("input", "bad-input");
    const { outcome } = await invite(session.sub, { gamertag });
    return code("invite", outcome);
  });
}
