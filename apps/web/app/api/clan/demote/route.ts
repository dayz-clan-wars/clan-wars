import type { NextRequest, NextResponse } from "next/server";
import { demote } from "@factions/roster";
import { formAction, text } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /clan. Leader only; demotes an officer back to member. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan", async (session, form) => {
    const target = text(form, "target", 32);
    if (!target || !/^\d+$/u.test(target)) return code("input", "bad-input");
    return code("role", await demote(session.sub, target));
  });
}
