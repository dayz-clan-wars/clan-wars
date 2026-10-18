import type { NextRequest, NextResponse } from "next/server";
import { setSupplies } from "@factions/roster";
import { formAction } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/**
 * POST from /clan/settings. Officer+. `supplies` is the state to set, "on" or
 * "off"; the form sends the opposite of what the page showed.
 *
 * ⚠️ Anything else is bad input, never "off": a missing field read as false
 * would strip a clan's crate on a malformed post while the page said it saved.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session, form) => {
    const want = form.get("supplies");
    if (want !== "on" && want !== "off") return code("input", "bad-input");
    return code("supplies", await setSupplies(session.sub, want === "on"));
  });
}
