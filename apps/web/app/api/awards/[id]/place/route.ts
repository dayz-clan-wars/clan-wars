import { startAwardPlacement } from "@factions/roster";
import { json } from "@/lib/api";
import { awardGate, freshAward } from "../../guard";

/** Draw the emote sequence. Closes any other open sequence on the account, the kit's included. */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await awardGate(ctx.params);
  if ("response" in gate) return gate.response;
  const out = await startAwardPlacement(gate.discordId, gate.grantId);
  if (!out.ok) return json({ ok: false, reason: out.reason }, out.reason === "not-found" ? 404 : 400);
  return json({ ok: true, view: await freshAward(gate.discordId, gate.grantId) });
}
