import type { NextRequest, NextResponse } from "next/server";
import { reportIncident } from "@factions/roster";
import { sessionOr401, json } from "@/lib/api";
import { REPORT_COPY } from "@/lib/report-copy";

/**
 * POST { incidentId, chargedDayzIds } from the report button on /base — the
 * only place this evidence is ever shown (CLAUDE.md: no coordinates in
 * Discord). JSON, never a redirect, same reasoning as /api/vault/reveal:
 * this names offenders and their sentences, so it must never ride a
 * cacheable URL.
 *
 * ⚠️ `reportIncidentDb` is a PROSECUTION TOGGLE — a bare click here can ban
 * every CHARGED participant with no staff adjudicator in the loop. The
 * incidentId is validated as a positive integer BEFORE it ever reaches the
 * store; `Number(undefined)` is `NaN` and must not reach a query.
 *
 * ⚠️ `chargedDayzIds` is validated here as an array of strings ONLY —
 * whether each id actually took part in THIS incident is the store's own
 * job (`reportIncidentDb` refuses an id that is not a participant). This
 * route's validation exists only to stop a malformed body (not an array, or
 * an array of non-strings) from reaching a query at all.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await sessionOr401();
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => null) as { incidentId?: unknown; chargedDayzIds?: unknown } | null;
  const incidentId = typeof body?.incidentId === "number" ? body.incidentId : Number(body?.incidentId);
  if (!Number.isInteger(incidentId) || incidentId <= 0) {
    return json({ ok: false, reason: "no-incident", message: REPORT_COPY["no-incident"] }, 400);
  }

  const chargedDayzIds = body?.chargedDayzIds;
  if (!Array.isArray(chargedDayzIds) || !chargedDayzIds.every((id) => typeof id === "string")) {
    return json({ ok: false, reason: "no-selection", message: REPORT_COPY["no-selection"] }, 400);
  }

  const outcome = await reportIncident(gate.session.sub, incidentId, chargedDayzIds);
  if (!outcome.ok) return json({ ok: false, reason: outcome.reason, message: REPORT_COPY[outcome.reason] }, 409);
  return json({ ok: true, banned: outcome.banned });
}
