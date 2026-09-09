import type { NextRequest, NextResponse } from "next/server";
import { addLock, VAULT_NAME_MAX, VAULT_NOTE_MAX } from "@factions/roster";
import { VAULT_CODE_DIGITS } from "@factions/domain";
import { formAction, text, optionalText } from "@/lib/form";
import { minRoleFrom } from "@/lib/vault-form";
import { vaultCode } from "@/lib/vault-copy";

const CODE_RE = new RegExp(`^\\d{${VAULT_CODE_DIGITS}}$`, "u");

/** POST from /clan/vault. Officer+; the code is caller-supplied or generated ("leave blank to generate"). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/vault", async (session, form) => {
    const name = text(form, "name", VAULT_NAME_MAX);
    if (!name) return vaultCode("add", "bad-name");
    const note = optionalText(form, "note", VAULT_NOTE_MAX);
    if (note === "too-long") return vaultCode("add", "bad-note");
    const minRole = minRoleFrom(form);
    if (!minRole) return vaultCode("input", "bad-input");
    const rawCode = form.get("code");
    let code: string | undefined;
    if (typeof rawCode === "string" && rawCode.trim() !== "") {
      if (!CODE_RE.test(rawCode.trim())) return vaultCode("add", "bad-code");
      code = rawCode.trim();
    }
    const { outcome } = await addLock(session.sub, { name, note, minRole, code });
    return vaultCode("add", outcome);
  });
}
