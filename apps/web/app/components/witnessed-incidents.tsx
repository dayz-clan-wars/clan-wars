import type { ReportableIncident } from "@factions/roster";
import { VIOLATION_REPORT_WINDOW_MS, sentenceMsFor, type IncidentDamage, type ViolationKind } from "@factions/domain";
import { gridRef } from "@/lib/map-projection";
import { ago, days, when } from "@/lib/format";
import { Panel, PanelBody } from "@/app/components/ui";
import { ReportButton } from "@/app/(site)/base/report-button";

/** One line per witnessed act, in the copy the guide uses. */
const ACT_LABEL: Record<ViolationKind, string> = {
  dismantle: "Dismantled",
  build: "Built without permission",
  gate: "Gate forced",
  stack: "Boosted on a stack",
};

/**
 * One reportable incident: every act and participant the log recorded, in
 * full — coordinates included. These pages are already gated to the
 * viewer's own base (`/base`, and `/clan`, whose hero shows the same pole to
 * the same members), which is why the evidence may live here and never in a
 * Discord notice. The minimum term shown is computed at a first offence
 * (`priorOffences = 0`) — the officer pressing charges does not know the
 * offenders' history without querying it, and a repeat offender always
 * serves at least as long, never less, so "at least" is honest either way.
 */
function Incident({ incident, canCharge }: { incident: ReportableIncident; canCharge: boolean }) {
  const damage: IncidentDamage = {
    partsDismantled: incident.partsDismantled, partsBuilt: incident.partsBuilt,
    stackItems: incident.stackItems, hasBreach: incident.hasBreach, hasGate: incident.hasGate,
  };
  const minTermMs = sentenceMsFor(damage, 0);
  const gamertags = incident.participants.map((p) => p.gamertag);
  const closes = new Date(incident.closedAt.getTime() + VIOLATION_REPORT_WINDOW_MS);
  return (
    <li className="border-t border-rule-2 px-4 py-4 first:border-t-0 lg:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-ink-2">
          Closed {ago(incident.closedAt)} &middot; {gamertags.join(", ")}
        </p>
        <p className="text-xs text-muted">Can be charged until {when(closes)}</p>
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {incident.acts.map((a, i) => (
          <li key={i} className="font-mono text-xs text-muted">
            {ACT_LABEL[a.kind]} {a.what} at {gridRef(a.x, a.z)} &middot; {ago(a.at)}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        {/* ⚠️ The real gate is reportIncidentDb's (officer+ for a clan base); hiding the
            button here only spares a member a press that would be refused. */}
        {canCharge
          ? <ReportButton incidentId={incident.id} participants={incident.participants} minTermLabel={minTermMs === null ? "permanent" : days(minTermMs)} />
          : <p className="text-sm text-ink-2">Only an officer or the leader can press charges. Let them know.</p>}
      </div>
    </li>
  );
}

/**
 * The incidents the log witnessed at the viewer's base, ready to charge.
 * Rendered by both `/base` (solo declarants, and clan members who look
 * there) and `/clan`; `id="incidents"` is the anchor the incident-ready
 * notice links to, so keep it.
 */
export function WitnessedIncidents({ incidents, canCharge, num }: { incidents: ReportableIncident[]; canCharge: boolean; num?: string }) {
  return (
    <Panel id="incidents" num={num} title="Witnessed incidents" aside={`${incidents.length}`}>
      <PanelBody className="!p-0">
        <p className="px-4 pt-4 text-sm leading-relaxed text-ink-2 lg:px-5">
          The log witnessed these at your base. Pressing charges bans the named players automatically — there is no staff review after you confirm.
        </p>
        <ul>
          {incidents.map((i) => <Incident key={i.id} incident={i} canCharge={canCharge} />)}
        </ul>
      </PanelBody>
    </Panel>
  );
}
