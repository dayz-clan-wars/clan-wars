import type { NextRequest, NextResponse } from "next/server";
import { rename } from "@factions/roster";
import { CLAN_NAME_LENGTH, CLAN_TAG_LENGTH } from "@factions/domain";
import { formAction, text } from "@/lib/form";
import { code } from "@/lib/clan-copy";

/** POST from /clan/settings. Leader only; the package enforces the cooldown and uniqueness. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session, form) => {
    const name = text(form, "name", CLAN_NAME_LENGTH.max);
    const tag = text(form, "tag", CLAN_TAG_LENGTH.max)?.toUpperCase();
    if (!name) return code("input", "bad-input");
    return code("rename", await rename(session.sub, tag ? { name, tag } : { name }));
  });
}
