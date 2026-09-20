import { cancelKitPlacement } from "@factions/roster";
import { json } from "@/lib/api";
import { boosterOnly, freshView } from "../guard";

/**
 * Close the open placement sequence without marking anything.
 *
 * ⚠️ Answers `ok` whether or not there was a sequence to close. The only way
 * to reach this is the Cancel button on an open sequence, so a "there was
 * nothing open" refusal would only ever fire when the sequence ended between
 * the render and the tap, and telling the player off for that is worse than
 * showing them the state they already wanted.
 *
 * ⚠️ Cancelling does not clear a spot already marked. The challenge row and
 * the kit row are separate writes for exactly this reason.
 */
export async function POST() {
  const gate = await boosterOnly();
  if ("response" in gate) return gate.response;

  await cancelKitPlacement(gate.discordId);
  return json({ ok: true, view: await freshView(gate.discordId) });
}
