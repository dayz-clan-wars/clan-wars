import type { NextRequest, NextResponse } from "next/server";
import { addLock, VAULT_NAME_MAX, VAULT_NOTE_MAX, type Role } from "@factions/roster";
import { formAction, text, optionalText } from "@/lib/form";
import { vaultCode } from "@/lib/vault-copy";

const ROLES: readonly Role[] = ["leader", "officer", "member"];
const CODE_RE = /^\d{4}$/u;

/** POST from /clan/vault. Officer+; the code is caller-supplied or generated ("leave blank to generate"). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/vault", async (session, form) => {
    const name = text(form, "name", VAULT_NAME_MAX);
    if (!name) return vaultCode("input", "bad-input");
    const note = optionalText(form, "note", VAULT_NOTE_MAX);
    if (note === "too-long") return vaultCode("input", "bad-input");
    const minRoleRaw = form.get("minRole");
    if (typeof minRoleRaw !== "string" || !ROLES.includes(minRoleRaw as Role)) return vaultCode("input", "bad-input");
    const minRole = minRoleRaw as Role;
    const rawCode = form.get("code");
    let code: string | undefined;
    if (typeof rawCode === "string" && rawCode.trim() !== "") {
      if (!CODE_RE.test(rawCode.trim())) return vaultCode("input", "bad-input");
      code = rawCode.trim();
    }
    const { outcome } = await addLock(session.sub, { name, note, minRole, code });
    return vaultCode("add", outcome);
  });
}
