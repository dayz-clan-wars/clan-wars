"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { boosterKit, saveBoosterKit, startKitPlacement } from "@factions/roster";
import { KIT_SLOTS, type KitSlot } from "@factions/domain";
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
 * Save all nine slots in one write, behind the page's single Save button.
 *
 * ⚠️ Read by KIT_SLOTS, never by iterating the posted keys: each slot's
 * radios are named `className-<slot>` (item-carousel.tsx) precisely so the
 * nine radio groups stay independent inside one <form>, and reading them
 * back by the same fixed names is what keeps that pairing exact.
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

  const picks = {} as Record<KitSlot, string>;
  for (const slot of KIT_SLOTS) {
    const value = formData.get(`className-${slot}`);
    if (typeof value !== "string") back("bad-pick");
    picks[slot] = value;
  }

  const out = await saveBoosterKit(discordId, picks);
  if (!out.ok) back(out.reason);
  back("saved");
}

/** Draw the emote sequence that marks where the kit spawns. The page reads the open sequence back out of the database. */
export async function startPlacement(): Promise<void> {
  const discordId = await requireBooster();
  if (!discordId) back("not-boosting");

  const issued = await startKitPlacement(discordId);
  back(issued ? "drawn" : "not-linked");
}
