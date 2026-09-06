import type { NextRequest, NextResponse } from "next/server";
import { setRecruitingPost } from "@factions/roster";
import { formAction, optionalText } from "@/lib/form";
import { RECRUITING_LIMITS } from "@/lib/clan-limits";
import { code } from "@/lib/clan-copy";

/**
 * POST from /clan/settings. Officer+. Empty fields clear the post; the
 * checkbox is the switch.
 *
 * ⚠️ A too-long field is `"too-long"`, not `null` — collapsing it to `null`
 * would silently clear the field while the page reports success.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session, form) => {
    const playWindow = optionalText(form, "playWindow", RECRUITING_LIMITS.playWindow);
    const language = optionalText(form, "language", RECRUITING_LIMITS.language);
    const pitch = optionalText(form, "pitch", RECRUITING_LIMITS.pitch);
    if (playWindow === "too-long" || language === "too-long" || pitch === "too-long") {
      return code("input", "bad-input");
    }
    const post = {
      recruiting: form.get("recruiting") === "yes",
      playWindow,
      language,
      pitch,
    };
    return code("recruiting", await setRecruitingPost(session.sub, post));
  });
}
