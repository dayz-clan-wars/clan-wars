import { linkStatus } from "@factions/roster";
import { json, sessionOr401 } from "@/lib/api";

/** Polled every 5 s by /link while a challenge is open. */
export async function GET() {
  const s = await sessionOr401();
  if ("response" in s) return s.response;
  return json(await linkStatus(s.session.sub));
}
