import type { NextRequest, NextResponse } from "next/server";
import { transfer } from "@factions/roster";
import { formAction, text, confirmed } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /clan/settings. Leader only; requires the confirm checkbox. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session, form) => {
    if (!confirmed(form)) return code("transfer", "unconfirmed");
    const target = text(form, "target", 32);
    if (!target || !/^\d+$/u.test(target)) return code("input", "bad-input");
    return code("transfer", await transfer(session.sub, target));
  });
}
