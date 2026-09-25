import type { NextRequest, NextResponse } from "next/server";
import { rename } from "@factions/roster";
import { CLAN_NAME_LENGTH, CLAN_TAG_LENGTH } from "@factions/domain";
import { formAction, keepFrom, text, type Redirect } from "@/lib/form";
import { code } from "@/lib/clan-copy";

const TAG_RE = new RegExp(`^[A-Z0-9]{${CLAN_TAG_LENGTH.min},${CLAN_TAG_LENGTH.max}}$`, "u");

/** POST from /clan/settings. Leader only; the package enforces the cooldown and uniqueness. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/settings", async (session, form) => {
    // H2: a refusal comes back with what was typed, so the sentence sits under the name it is about.
    const refuse = (c: string): Redirect => ({ back: "/clan/settings", code: c, keep: keepFrom(form, { name: CLAN_NAME_LENGTH.max, tag: CLAN_TAG_LENGTH.max }) });
    const name = text(form, "name", CLAN_NAME_LENGTH.max);
    if (!name || name.length < CLAN_NAME_LENGTH.min) return refuse(code("rename", "bad-name"));
    const rawTag = form.get("tag");
    const tag = typeof rawTag === "string" && rawTag.trim() !== "" ? rawTag.trim().toUpperCase() : undefined;
    if (tag !== undefined && !TAG_RE.test(tag)) return refuse(code("rename", "bad-tag"));
    const outcome = await rename(session.sub, tag ? { name, tag } : { name });
    return outcome === "ok" ? code("rename", outcome) : refuse(code("rename", outcome));
  });
}
