import type { NextRequest, NextResponse } from "next/server";
import { editLock, VAULT_NAME_MAX, VAULT_NOTE_MAX } from "@factions/roster";
import { formAction, keepFrom, text, optionalText, id, type Redirect } from "@/lib/form";
import { MIN_ROLE_MAX, minRoleFrom } from "@/lib/vault-form";
import { vaultCode } from "@/lib/vault-copy";

/** POST from /clan/vault. Officer+; renames/re-describes/re-gates a lock. The code is untouched. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/vault", async (session, form) => {
    const lockId = id(form, "lockId");
    if (lockId === null) return vaultCode("input", "bad-input");
    // M11: every refusal names its lock, so the page reopens THAT lock's editor with the
    // sentence inside it; H2: with what was typed. The edit form has no code field.
    const refuse = (c: string): Redirect => ({
      back: "/clan/vault", code: c,
      keep: { lock: String(lockId), ...keepFrom(form, { name: VAULT_NAME_MAX, note: VAULT_NOTE_MAX, minRole: MIN_ROLE_MAX }) },
    });
    const name = text(form, "name", VAULT_NAME_MAX);
    if (!name) return refuse(vaultCode("edit", "bad-name"));
    const note = optionalText(form, "note", VAULT_NOTE_MAX);
    if (note === "too-long") return refuse(vaultCode("edit", "bad-note"));
    const minRole = minRoleFrom(form);
    if (!minRole) return refuse(vaultCode("input", "bad-input"));
    const outcome = await editLock(session.sub, { lockId, name, note, minRole });
    return outcome === "ok" ? vaultCode("edit", outcome) : refuse(vaultCode("edit", outcome));
  });
}
