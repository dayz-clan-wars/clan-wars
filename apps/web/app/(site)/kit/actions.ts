"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { boosterKit, saveBoosterKitSlot, startKitPlacement } from "@factions/roster";
import { currentSession } from "@/lib/viewer";

const PAGE = "/kit";

/**
 * ⚠️ A server action is a POST endpoint, reachable by anyone who can send the
 * request. Rendering the form only for a booster is not a check. Both actions
 * below therefore re-read the session and re-read the viewer's booster state
 * from the database before they write anything.
 */
async function requireBooster(): Promise<string | null> {
  const session = await currentSession();
  if (!session) redirect(`/login?next=${encodeURIComponent(PAGE)}`);
  const view = await boosterKit(session.sub);
  return view.boosting ? session.sub : null;
}

/** Finish an action the way every other write on this site finishes: back to the page with a code it looks up. */
function back(code: string): never {
  revalidatePath(PAGE);
  redirect(`${PAGE}?result=${encodeURIComponent(code)}`);
}

/**
 * Save one of the nine slots.
 *
 * ⚠️ The catalogue check lives in `@factions/roster`, not here, and a refused
 * pick comes back as an OUTCOME. Nothing here may catch: a try/catch around
 * the write would turn a dead database or an exhausted pool into "that item
 * is not on the list", and the player would re-pick from the same list
 * forever while the site blamed their choice for an outage. An unexpected
 * failure has to surface as a real error.
 *
 * ⚠️ It writes gear only. The kit's position belongs to the placement
 * sequence, so editing a slot can never move a spot the player already marked.
 */
export async function saveKit(formData: FormData): Promise<void> {
  const discordId = await requireBooster();
  if (!discordId) back("not-boosting");

  const slot = formData.get("slot");
  const className = formData.get("className");
  if (typeof slot !== "string" || typeof className !== "string") back("bad-pick");

  const out = await saveBoosterKitSlot(discordId, slot, className);
  if (!out.ok) back(out.reason);
  back(className.trim() === "" ? "cleared" : "saved");
}

/** Draw the emote sequence that marks where the kit spawns. The page reads the open sequence back out of the database. */
export async function startPlacement(): Promise<void> {
  const discordId = await requireBooster();
  if (!discordId) back("not-boosting");

  const issued = await startKitPlacement(discordId);
  back(issued ? "drawn" : "not-linked");
}
