import type { NextRequest } from "next/server";
import { startLink } from "@factions/roster";
import { json, sessionOr401 } from "@/lib/api";

/**
 * ⚠️ Re-validated by the package, not trusted from the client: `dayzId` is
 * whatever the browser sent. `issueChallenge` refuses an unknown or taken
 * character server-side, and the two partial unique indexes are the
 * enforcement behind a lost race.
 */
export async function POST(req: NextRequest) {
  const s = await sessionOr401();
  if ("response" in s) return s.response;
  let body: { dayzId?: unknown; newSequence?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad-json" }, 400); }
  if (typeof body.dayzId !== "string" || body.dayzId.length === 0 || body.dayzId.length > 64) return json({ error: "bad-dayz-id" }, 400);
  const outcome = await startLink(s.session.sub, body.dayzId, { newSequence: body.newSequence === true });
  return json({ outcome });
}
