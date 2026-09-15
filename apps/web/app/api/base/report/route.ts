import type { NextRequest, NextResponse } from "next/server";
import { reportIncident } from "@factions/roster";
import { sessionOr401, json } from "@/lib/api";
import { REPORT_COPY } from "@/lib/report-copy";

/**
 * POST { incidentId } from the report button on /base — the only place this
 * evidence is ever shown (CLAUDE.md: no coordinates in Discord). JSON, never
 * a redirect, same reasoning as /api/vault/reveal: this names offenders and
 * their sentences, so it must never ride a cacheable URL.
 *
 * ⚠️ `reportIncidentDb` is a PROSECUTION TOGGLE — a bare click here can ban
 * every named participant with no staff adjudicator in the loop. The
 * incidentId is validated as a positive integer BEFORE it ever reaches the
 * store; `Number(undefined)` is `NaN` and must not reach a query.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const gate = await sessionOr401();
  if ("response" in gate) return gate.response;

  const body = await req.json().catch(() => null) as { incidentId?: unknown } | null;
  const incidentId = typeof body?.incidentId === "number" ? body.incidentId : Number(body?.incidentId);
  if (!Number.isInteger(incidentId) || incidentId <= 0) {
    return json({ ok: false, reason: "no-incident", message: REPORT_COPY["no-incident"] }, 400);
  }

  const outcome = await reportIncident(gate.session.sub, incidentId);
  if (!outcome.ok) return json({ ok: false, reason: outcome.reason, message: REPORT_COPY[outcome.reason] }, 409);
  return json({ ok: true, banned: outcome.banned });
}
