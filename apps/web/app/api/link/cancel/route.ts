import { cancelLink } from "@factions/roster";
import { json, sessionOr401 } from "@/lib/api";

export async function POST() {
  const s = await sessionOr401();
  if ("response" in s) return s.response;
  return json(await cancelLink(s.session.sub));
}
