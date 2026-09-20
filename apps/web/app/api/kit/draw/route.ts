import { startKitPlacement } from "@factions/roster";
import { json } from "@/lib/api";
import { boosterOnly, freshView } from "../guard";

/**
 * Draw the emote sequence that marks where the kit spawns.
 *
 * ⚠️ Drawing a new one leaves the current spot alone until the new sequence
 * is completed in game. That rule lives in `startKitPlacementDb`, which
 * touches the challenge table and creates the kit row, and never a position.
 */
export async function POST() {
  const gate = await boosterOnly();
  if ("response" in gate) return gate.response;

  const issued = await startKitPlacement(gate.discordId);
  if (!issued) return json({ ok: false, reason: "not-linked" }, 400);
  return json({ ok: true, view: await freshView(gate.discordId) });
}
