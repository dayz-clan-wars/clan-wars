import { saveAwardPick } from "@factions/roster";
import { json } from "@/lib/api";
import { awardGate, freshAward } from "../../guard";

/**
 * Save one piece. `slot` and `className` go straight to `saveAwardPick`,
 * which checks both against the award catalogue. Nothing is caught: a refusal
 * is an answer, a dead database is an outage.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const gate = await awardGate(ctx.params);
  if ("response" in gate) return gate.response;
  const body: unknown = await req.json().catch(() => null);
  const slot = (body as { slot?: unknown } | null)?.slot;
  const className = (body as { className?: unknown } | null)?.className;
  if (typeof slot !== "string" || typeof className !== "string") return json({ ok: false, reason: "bad-slot" }, 400);
  const out = await saveAwardPick(gate.discordId, gate.grantId, slot, className);
  if (!out.ok) return json({ ok: false, reason: out.reason }, out.reason === "not-found" ? 404 : 400);
  return json({ ok: true, view: await freshAward(gate.discordId, gate.grantId) });
}
