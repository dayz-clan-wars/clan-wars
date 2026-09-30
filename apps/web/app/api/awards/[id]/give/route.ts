import { giveAward } from "@factions/roster";
import { json } from "@/lib/api";
import { awardGate } from "../../guard";

/**
 * Give this award to another linked player (transfers spec §2).
 *
 * Answers `{ ok: true }` with no view: the award is no longer the caller's, so
 * there is nothing of theirs to re-read. The page sends them to /awards.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await awardGate(ctx.params);
  if ("response" in gate) return gate.response;
  const body = (await req.json().catch(() => null)) as { gamertag?: unknown } | null;
  if (typeof body?.gamertag !== "string") return json({ ok: false, reason: "recipient-not-linked" }, 400);
  const out = await giveAward(gate.discordId, gate.grantId, body.gamertag);
  if (!out.ok) return json({ ok: false, reason: out.reason }, out.reason === "not-found" ? 404 : 400);
  return json({ ok: true });
}
