import type { NextRequest, NextResponse } from "next/server";
import { rotateLocks } from "@factions/roster";
import { formAction, id, confirmed } from "@/lib/form";
import { vaultCode } from "@/lib/vault-copy";

/** POST from /clan/vault. Officer+; one lock (`lockId`) or every lock (`all=yes`). Requires the confirm checkbox. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/vault", async (session, form) => {
    if (!confirmed(form)) return vaultCode("rotate", "unconfirmed");
    const all = form.get("all") === "yes";
    const lockId = id(form, "lockId");
    if (!all && lockId === null) return vaultCode("input", "bad-input");
    const { outcome } = await rotateLocks(session.sub, all ? "all" : lockId!);
    return vaultCode("rotate", outcome);
  });
}
