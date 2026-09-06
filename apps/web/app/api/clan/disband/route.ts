import type { NextRequest, NextResponse } from "next/server";
import { disband } from "@factions/roster";
import { formAction, confirmed } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /clan/settings. Leader only; requires the confirm checkbox; irreversible. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session, form) => {
    if (!confirmed(form)) return code("disband", "unconfirmed");
    const out = await disband(session.sub);
    return out === "ok" ? { back: "/me", code: code("disband", "ok") } : code("disband", out);
  });
}
