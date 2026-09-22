import { cancelAwardPlacement } from "@factions/roster";
import { json } from "@/lib/api";
import { awardGate, freshAward } from "../../guard";

/** Close this award's open sequence. The spot already marked is kept. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await awardGate(ctx.params);
  if ("response" in gate) return gate.response;
  await cancelAwardPlacement(gate.discordId, gate.grantId);
  const view = await freshAward(gate.discordId, gate.grantId);
  return view ? json({ ok: true, view }) : json({ ok: false, reason: "not-found" }, 404);
}
