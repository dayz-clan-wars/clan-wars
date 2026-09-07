import type { NextRequest, NextResponse } from "next/server";
import { deleteLock } from "@factions/roster";
import { formAction, id, confirmed } from "@/lib/form";
import { vaultCode } from "@/lib/vault-copy";

/** POST from /clan/vault. Officer+; requires the confirm checkbox. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/vault", async (session, form) => {
    if (!confirmed(form)) return vaultCode("delete", "unconfirmed");
    const lockId = id(form, "lockId");
    if (lockId === null) return vaultCode("input", "bad-input");
    return vaultCode("delete", await deleteLock(session.sub, lockId));
  });
}
