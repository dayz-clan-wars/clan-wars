import type { NextRequest, NextResponse } from "next/server";
import { cancelRebrand } from "@factions/roster";
import { formAction } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /clan/settings. Leader only; the package enforces it. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session) => code("rebrand-cancel", await cancelRebrand(session.sub)));
}
