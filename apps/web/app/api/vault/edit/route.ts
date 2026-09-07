import type { NextRequest, NextResponse } from "next/server";
import { editLock, VAULT_NAME_MAX, VAULT_NOTE_MAX } from "@factions/roster";
import { formAction, text, optionalText, id } from "@/lib/form";
import { minRoleFrom } from "@/lib/vault-form";
import { vaultCode } from "@/lib/vault-copy";

/** POST from /clan/vault. Officer+; renames/re-describes/re-gates a lock. The code is untouched. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/vault", async (session, form) => {
    const lockId = id(form, "lockId");
    if (lockId === null) return vaultCode("input", "bad-input");
    const name = text(form, "name", VAULT_NAME_MAX);
    if (!name) return vaultCode("input", "bad-input");
    const note = optionalText(form, "note", VAULT_NOTE_MAX);
    if (note === "too-long") return vaultCode("input", "bad-input");
    const minRole = minRoleFrom(form);
    if (!minRole) return vaultCode("input", "bad-input");
    return vaultCode("edit", await editLock(session.sub, { lockId, name, note, minRole }));
  });
}
