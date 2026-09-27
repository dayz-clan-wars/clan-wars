import type { NextRequest } from "next/server";
import { startLink } from "@factions/roster";
import { json, sessionOr401 } from "@/lib/api";
import { GAMERTAG_MAX } from "@/lib/clan-limits";

/**
 * ⚠️ Re-validated by the package, not trusted from the client: `dayzId` is
 * whatever the browser sent. `issueChallenge` refuses an unknown or taken
 * character server-side, and the two partial unique indexes are the
 * enforcement behind a lost race.
 *
 * `referrer`, when sent, is only ever a typed gamertag — the package
 * resolves and checks it (self, loop, unlinked, unknown) before a challenge
 * is ever issued; `startLink` reports that as `{ kind: "referrer-refused" }`
 * rather than a plain 400.
 */
export async function POST(req: NextRequest) {
  const s = await sessionOr401();
  if ("response" in s) return s.response;
  let body: { dayzId?: unknown; newSequence?: unknown; referrer?: unknown };
  try { body = await req.json(); } catch { return json({ error: "bad-json" }, 400); }
  if (typeof body.dayzId !== "string" || body.dayzId.length === 0 || body.dayzId.length > 64) return json({ error: "bad-dayz-id" }, 400);
  let referrerGamertag: string | undefined;
  if (body.referrer !== undefined) {
    if (typeof body.referrer !== "string" || body.referrer.length === 0 || body.referrer.length > GAMERTAG_MAX) return json({ error: "bad-referrer" }, 400);
    referrerGamertag = body.referrer;
  }
  const outcome = await startLink(s.session.sub, body.dayzId, { newSequence: body.newSequence === true, referrerGamertag, surface: "site" });
  return json({ outcome });
}
