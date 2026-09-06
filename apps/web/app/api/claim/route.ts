import type { NextRequest, NextResponse } from "next/server";
import { claimCeremony } from "@factions/roster";
import { CLAN_NAME_LENGTH, CLAN_TAG_LENGTH } from "@factions/domain";
import { formAction, id, text } from "@/lib/form";
import { code } from "@/lib/clan-copy";

const DAYZ_ID_RE = /^[A-Za-z0-9_-]{1,64}$/u;

/**
 * POST from /claim/{ceremony}. Name, tag, flag and the pruned roster go to
 * the package, which checks the ceremony is the caller's, the identity is
 * free and unheld, and the pole is 200 m from every other declaration.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/me", async (session, form) => {
    const ceremonyId = id(form, "ceremonyId");
    if (ceremonyId === null) return code("input", "bad-input");
    const back = `/claim/${ceremonyId}`;
    const name = text(form, "name", CLAN_NAME_LENGTH.max);
    const tag = text(form, "tag", CLAN_TAG_LENGTH.max)?.toUpperCase() ?? null;
    const texture = text(form, "texture", 64);
    const members = form.getAll("member").filter((m): m is string => typeof m === "string" && DAYZ_ID_RE.test(m));
    if (!name || !tag || !texture) return { back, code: code("input", "bad-input") };
    const outcome = await claimCeremony(session.sub, ceremonyId, { name, tag, texture, memberDayzIds: members });
    return outcome === "ok" ? { back: "/clan", code: code("claim", "ok") } : { back, code: code("claim", outcome) };
  });
}
