import { boosterKit } from "@factions/roster";
import { kitView } from "@/lib/kit-view";
import { json, sessionOr401 } from "@/lib/api";

/**
 * Polled every few seconds by /kit while a placement sequence is open.
 *
 * ⚠️ No booster gate, deliberately, and it matches the read behind it:
 * `boosterKit` answers for a non-booster in full so the page can explain the
 * perk to someone deciding whether to boost. A gate here would make the page
 * stop refreshing the moment a boost lapsed, freezing a stale "kit live"
 * strip on screen.
 */
export async function GET() {
  const s = await sessionOr401();
  if ("response" in s) return s.response;
  return json(kitView(await boosterKit(s.session.sub)));
}
