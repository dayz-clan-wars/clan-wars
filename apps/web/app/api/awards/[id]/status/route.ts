import { json } from "@/lib/api";
import { awardGate, freshAward } from "../../guard";

/** Polled by /awards/<id> while a sequence is open. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await awardGate(ctx.params);
  if ("response" in gate) return gate.response;
  const view = await freshAward(gate.discordId, gate.grantId);
  return view ? json(view) : json({ ok: false, reason: "not-found" }, 404);
}
