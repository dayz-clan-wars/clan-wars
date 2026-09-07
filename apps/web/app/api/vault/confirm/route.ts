import type { NextRequest, NextResponse } from "next/server";
import { confirmLock } from "@factions/roster";
import { formAction, id } from "@/lib/form";
import { vaultCode } from "@/lib/vault-copy";

/** POST from /clan/vault. Any rank meeting the lock's `min_role`; confirms the code was changed in-game. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/vault", async (session, form) => {
    const lockId = id(form, "lockId");
    if (lockId === null) return vaultCode("input", "bad-input");
    return vaultCode("confirm", await confirmLock(session.sub, lockId));
  });
}
