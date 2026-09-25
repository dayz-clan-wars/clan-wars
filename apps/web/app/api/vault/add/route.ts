import type { NextRequest, NextResponse } from "next/server";
import { addLock, VAULT_NAME_MAX, VAULT_NOTE_MAX } from "@factions/roster";
import { VAULT_CODE_DIGITS } from "@factions/domain";
import { formAction, keepFrom, text, optionalText, type Redirect } from "@/lib/form";
import { MIN_ROLE_MAX, minRoleFrom } from "@/lib/vault-form";
import { vaultCode } from "@/lib/vault-copy";

const CODE_RE = new RegExp(`^\\d{${VAULT_CODE_DIGITS}}$`, "u");

/** POST from /clan/vault. Officer+; the code is caller-supplied or generated ("leave blank to generate"). */
export async function POST(req: NextRequest): Promise<NextResponse> {
  return formAction(req, "/clan/vault", async (session, form) => {
    // H2: a refused add comes back with name and rank.
    // ⚠️ NEVER the code — it is not in this list and must never be added to it:
    // a kept value lands in the URL, and a code never may (lib/form.ts NEVER_KEEP
    // refuses it too, but this list is the first line).
    // ⚠️ NEVER note either (F3): it is rank-gated free text living right next to
    // the code field, and the same reason a code stays out of the address bar,
    // browser history and nginx logs applies to it — one step removed, not
    // exempt. A refused add's note falls back to empty, not to the typed value.
    const keep = keepFrom(form, { name: VAULT_NAME_MAX, minRole: MIN_ROLE_MAX });
    const refuse = (c: string): Redirect => ({ back: "/clan/vault", code: c, keep });
    const name = text(form, "name", VAULT_NAME_MAX);
    if (!name) return refuse(vaultCode("add", "bad-name"));
    const note = optionalText(form, "note", VAULT_NOTE_MAX);
    if (note === "too-long") return refuse(vaultCode("add", "bad-note"));
    const minRole = minRoleFrom(form);
    if (!minRole) return refuse(vaultCode("input", "bad-input"));
    const rawCode = form.get("code");
    let code: string | undefined;
    if (typeof rawCode === "string" && rawCode.trim() !== "") {
      if (!CODE_RE.test(rawCode.trim())) return refuse(vaultCode("add", "bad-code"));
      code = rawCode.trim();
    }
    const { outcome } = await addLock(session.sub, { name, note, minRole, code });
    return outcome === "ok" ? vaultCode("add", outcome) : refuse(vaultCode("add", outcome));
  });
}
