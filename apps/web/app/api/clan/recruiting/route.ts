import type { NextRequest, NextResponse } from "next/server";
import { setRecruitingPost } from "@factions/roster";
import { formAction, text } from "@/lib/form";
import { RECRUITING_LIMITS } from "@/lib/clan-limits";
import { code } from "@/lib/clan-copy";

/** POST from /clan/settings. Officer+. Empty fields clear the post; the checkbox is the switch. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session, form) => {
    const post = {
      recruiting: form.get("recruiting") === "yes",
      playWindow: text(form, "playWindow", RECRUITING_LIMITS.playWindow),
      language: text(form, "language", RECRUITING_LIMITS.language),
      pitch: text(form, "pitch", RECRUITING_LIMITS.pitch),
    };
    return code("recruiting", await setRecruitingPost(session.sub, post));
  });
}
