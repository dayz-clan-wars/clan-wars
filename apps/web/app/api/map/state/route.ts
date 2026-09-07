import { NextResponse } from "next/server";
import { mapState } from "@factions/roster";
import { currentSession } from "@/lib/viewer";

/**
 * The map's one read. GET, because the client polls it; allowed in
 * test/api-routes.test.ts by name. ⚠️ `Cache-Control: no-store, private` is
 * load-bearing (spec §10.3, rule four): without it a shared cache can hand
 * one clan's positions to the next visitor with the auth check still
 * "passing". The subject is the session alone — there is no player
 * parameter to add. test/map-route-headers.test.ts pins both halves.
 */
export const dynamic = "force-dynamic";
const HEADERS = { "Cache-Control": "no-store, private" } as const;

export async function GET(): Promise<NextResponse> {
  const session = await currentSession();
  if (!session) return NextResponse.json({ error: "unauthenticated" }, { status: 401, headers: HEADERS });
  const state = await mapState(session.sub);
  if (state === "not-linked") return NextResponse.json({ error: "not-linked" }, { status: 403, headers: HEADERS });
  return NextResponse.json(state, { headers: HEADERS });
}
