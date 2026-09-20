import { saveBoosterKitSlot } from "@factions/roster";
import { json } from "@/lib/api";
import { boosterOnly, freshView } from "../guard";

/**
 * Save one of the nine slots. The page saves as you pick, so this is the
 * write every tap goes through.
 *
 * ⚠️ `slot` and `className` are read as strings and handed STRAIGHT to
 * `saveBoosterKitSlot`, which checks both against the committed catalogue and
 * refuses with `bad-slot` / `bad-pick`. Nothing is validated twice and
 * nothing is validated here instead: that check is the only thing standing
 * between a POST and an arbitrary class name reaching the server's spawner
 * file, and a second copy of it here would be the one that drifts.
 *
 * ⚠️ Nothing is caught. A refused pick is an answer for the player; a dead
 * database is an outage. A try/catch would tell a booster their valid jacket
 * "is not on the list" while Postgres was down.
 */
export async function POST(req: Request) {
  const gate = await boosterOnly();
  if ("response" in gate) return gate.response;

  const body: unknown = await req.json().catch(() => null);
  const slot = (body as { slot?: unknown } | null)?.slot;
  const className = (body as { className?: unknown } | null)?.className;
  if (typeof slot !== "string" || typeof className !== "string") return json({ ok: false, reason: "bad-slot" }, 400);

  const out = await saveBoosterKitSlot(gate.discordId, slot, className);
  if (!out.ok) return json({ ok: false, reason: out.reason }, 400);
  return json({ ok: true, view: await freshView(gate.discordId) });
}
