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
 * ⚠️ The catalogue check lives in `@factions/roster`, not here, and it throws
 * on a class name that is not an option for that slot. This function turns
 * that throw into a result code; it must never fall back to writing something
 * else, because the value goes straight into the server's spawner file.
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

  try {
    await saveBoosterKitSlot(discordId, slot, className);
  } catch {
    back("bad-pick");
  }
  back(className.trim() === "" ? "cleared" : "saved");
}

/** Draw the emote sequence that marks where the kit spawns. The page reads the open sequence back out of the database. */
export async function startPlacement(): Promise<void> {
  const discordId = await requireBooster();
  if (!discordId) back("not-boosting");

  const issued = await startKitPlacement(discordId);
  back(issued ? "drawn" : "not-linked");
}
