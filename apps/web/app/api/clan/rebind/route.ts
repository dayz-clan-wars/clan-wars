import type { NextRequest, NextResponse } from "next/server";
import { confirmRebind } from "@factions/roster";
import { formAction, text } from "@/lib/form";
import { POLE_KEY_MAX } from "@/lib/clan-limits";
import { code } from "@/lib/clan-copy";

/** POST from /clan/settings. Leader only; the pole key travels in a hidden field. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session, form) => {
    const poleKey = text(form, "poleKey", POLE_KEY_MAX);
    if (!poleKey) return code("input", "bad-input");
    return code("rebind", await confirmRebind(session.sub, poleKey));
  });
}
