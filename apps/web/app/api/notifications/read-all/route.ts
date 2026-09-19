import type { NextRequest, NextResponse } from "next/server";
import { markAllNoticesRead } from "@factions/roster";
import { formAction } from "@/lib/form";

/** POST from /notifications and the bell panel. One watermark row, whatever the backlog. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/notifications", async (session) => {
    await markAllNoticesRead(session.sub);
    return "read-all";
  });
}
