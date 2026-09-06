import type { NextRequest, NextResponse } from "next/server";
import { kick } from "@factions/roster";
import { formAction, text } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /clan. Officer+; removes a member or a pending member. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan", async (session, form) => {
    const target = text(form, "target", 32);
    if (!target || !/^\d+$/u.test(target)) return code("input", "bad-input");
    return code("kick", await kick(session.sub, target));
  });
}
