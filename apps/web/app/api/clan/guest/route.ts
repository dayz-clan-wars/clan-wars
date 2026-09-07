import type { NextRequest, NextResponse } from "next/server";
import { grantGuestPass } from "@factions/roster";
import { formAction, text } from "@/lib/form";
import { GAMERTAG_MAX } from "@/lib/clan-limits";
import { code } from "@/lib/clan-copy";

const DISCORD_ID_RE = /^\d+$/u;

/** POST from /clan/settings. Officer+; `target` is a Discord user id (digits) or a linked gamertag. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session, form) => {
    const target = text(form, "target", GAMERTAG_MAX);
    if (!target) return code("input", "bad-input");
    const ref = DISCORD_ID_RE.test(target) ? { discordId: target } : { gamertag: target };
    const { outcome } = await grantGuestPass(session.sub, ref);
    return code("guest", outcome);
  });
}
