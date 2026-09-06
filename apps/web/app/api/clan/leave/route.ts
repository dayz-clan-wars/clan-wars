import type { NextRequest, NextResponse } from "next/server";
import { leave } from "@factions/roster";
import { formAction, confirmed } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /clan. Requires the confirm checkbox; a leader cannot leave (the package refuses). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan", async (session, form) => {
    if (!confirmed(form)) return code("leave", "unconfirmed");
    const out = await leave(session.sub);
    return out === "ok" ? { back: "/me", code: code("leave", "ok") } : code("leave", out);
  });
}
