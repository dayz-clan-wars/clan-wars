import type { NextRequest, NextResponse } from "next/server";
import { revealLock } from "@factions/roster";
import { sessionOr401, json } from "@/lib/api";
import { lookupCopy } from "@/lib/copy-lookup";
import { VAULT_RESULT_COPY, vaultCode } from "@/lib/vault-copy";

/**
 * POST { lockId } from the reveal button on /clan/vault. JSON, never a
 * redirect — a code must never appear in a URL. `ok` returns the code
 * itself; anything else returns the refusal's copy so the button can show
 * it without a page reload.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await sessionOr401();
  if ("response" in gate) return gate.response;
  const body = await req.json().catch(() => null) as { lockId?: unknown } | null;
  const lockId = typeof body?.lockId === "number" ? body.lockId : Number(body?.lockId);
  if (!Number.isInteger(lockId)) return json({ error: lookupCopy(VAULT_RESULT_COPY, vaultCode("input", "bad-input")) }, 400);
  const { outcome, code } = await revealLock(gate.session.sub, lockId);
  if (outcome === "ok") return json({ code });
  return json({ error: lookupCopy(VAULT_RESULT_COPY, vaultCode("reveal", outcome)) }, 403);
}
