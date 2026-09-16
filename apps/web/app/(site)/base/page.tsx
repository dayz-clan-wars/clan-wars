import type { Metadata } from "next";
import { baseFor, type ReportableIncident } from "@factions/roster";
import { WATCH_ZONE_RADIUS_M, sentenceMsFor, type IncidentDamage, type ViolationKind } from "@factions/domain";
import { gridRef, gridRefKey } from "@/lib/map-projection";
import { nearestPlace } from "@/lib/map-places";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY, lapsedCopy } from "@/lib/base-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { ago, days } from "@/lib/format";
import { guideLinkFor, guideLink, GUIDE_INLINE } from "@/lib/guide-links";
import { Page, PageHead, Body, Panel, PanelBody, Notice, BackLine, SessionLost, ConfirmButton, btnPrimary, btnDanger, link } from "@/app/components/ui";
import { ReportButton } from "./report-button";

export const metadata: Metadata = {
  title: "Clan Wars — your base",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

/** Livonia, metres; the map's own constant (App Review R2: the site speaks in grid squares, not metres). */
const WORLD = { map: "enoch", size: 12800 };
/** "Grid 043 087 · near Topolin", and the map opened on that square. These are the viewer's own raises; nobody else's pole reaches this page. */
function Pole({ x, z }: { x: number; z: number }) {
  const near = nearestPlace(WORLD.map, x, z, WORLD.size);
  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <span className="font-mono text-ink">Grid {gridRef(x, z)}</span>
      {near && <span className="text-xs text-muted">near {near.name}</span>}
      <a className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold hover:underline underline-offset-4" href={`/map?at=${gridRefKey(x, z)}`}>Map →</a>
    </div>
  );
}

/** One line per witnessed act, in the copy the guide uses. */
const ACT_LABEL: Record<ViolationKind, string> = {
  dismantle: "Dismantled",
  build: "Built without permission",
  gate: "Gate forced",
  stack: "Boosted on a stack",
};

/**
 * One reportable incident: every act and participant the log recorded, in
 * full — coordinates included. This is the ONLY place that evidence may be
 * shown (CLAUDE.md: no coordinates in any Discord notice); `/base` is
 * already gated to the viewer's own base, which is exactly why it lives
 * here. The minimum term shown is computed at a first offence
 * (`priorOffences = 0`) — the officer pressing charges does not know the
 * offenders' history without querying it, and a repeat offender always
 * serves at least as long, never less, so "at least" is honest either way.
 */
function Incident({ incident }: { incident: ReportableIncident }) {
  const damage: IncidentDamage = {
    partsDismantled: incident.partsDismantled, partsBuilt: incident.partsBuilt,
    stackItems: incident.stackItems, hasBreach: incident.hasBreach, hasGate: incident.hasGate,
  };
  const minTermMs = sentenceMsFor(damage, 0);
  const gamertags = incident.participants.map((p) => p.gamertag);
  return (
    <li className="border-t border-rule-2 px-4 py-4 first:border-t-0 lg:px-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm text-ink-2">
          Closed {ago(incident.closedAt)} &middot; {gamertags.join(", ")}
        </p>
      </div>
      <ul className="mt-2 flex flex-col gap-1">
        {incident.acts.map((a, i) => (
          <li key={i} className="font-mono text-xs text-muted">
            {ACT_LABEL[a.kind]} {a.what} at {gridRef(a.x, a.z)} &middot; {ago(a.at)}
          </li>
        ))}
      </ul>
      <div className="mt-3">
        <ReportButton incidentId={incident.id} participants={incident.participants} minTermLabel={minTermMs === null ? "permanent" : days(minTermMs)} />
      </div>
    </li>
  );
}

export default async function BasePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) return <SessionLost next="/base" />;
  const params = await searchParams;
  // ⚠️ Looked up, never echoed: ?result= is attacker-supplied, including
  // prototype keys like `__proto__`, so the lookup must miss on those rather
  // than returning a value off Object.prototype.
  const result = typeof params.result === "string" ? lookupCopy(RESULT_COPY, params.result) : undefined;
  const view = await baseFor(session.sub);

  return (
    <Page>
      <PageHead guide={guideLinkFor("/base")} kicker="Your base" title="Solo declaration" />
      <Body className="flex max-w-[44rem] flex-col gap-4 lg:gap-6">
        {result && <Notice>{result}{params.result === "too-close" && <> <a className={link} href={guideLink(GUIDE_INLINE.spacing).href}>Why the rule exists</a>.</>}</Notice>}

        {!view.linked && (
          <p className="text-ink-2"><a className={link} href="/link">Link your character</a> first — a base is declared by the character that raised the flag. <a className={link} href={guideLink(GUIDE_INLINE.gettingIn).href}>How linking works</a>.</p>
        )}

        {view.linked && view.inClan && (
          <p className="text-ink-2">You are in a clan, so your base is the clan&rsquo;s. Solo declarations are for players outside one.</p>
        )}

        {view.linked && !view.inClan && (
          <>
            {view.lapsed && <Notice tone="gold" focus={false}>{lapsedCopy(view.lapsed.at)}</Notice>}

            <Panel num="01" title="Declared" aside={view.declaration ? `${WATCH_ZONE_RADIUS_M} m watch zone` : undefined}>
              <PanelBody>
                {view.declaration ? (
                  <>
                    <Pole x={view.declaration.x} z={view.declaration.z} />
                    <p className="mt-1 text-sm text-ink-2">Declared {ago(view.declaration.declaredAt)}. Your {WATCH_ZONE_RADIUS_M} m watch zone is live.</p>
                    <form className="mt-4 border-t border-rule-2 pt-4" action="/api/base/release" method="post">
                      <input type="hidden" name="confirm" value="yes" />
                      <p className="text-sm leading-relaxed text-ink-2">Releasing makes the pole public if nobody declares it within the grace period.</p>
                      <ConfirmButton confirm="Release it?" className={`mt-3 ${btnDanger}`}>Release this base</ConfirmButton>
                    </form>
                  </>
                ) : (
                  <p className="text-sm leading-relaxed text-ink-2">Nothing declared. Pick one of the poles below — only poles the server log has seen you raise a flag at can be declared.</p>
                )}
              </PanelBody>
            </Panel>

            <Panel num="02" title="Poles you have raised at" aside={view.candidates.length > 0 ? `${view.candidates.length}` : undefined}>
              {view.candidates.length === 0 ? (
                <PanelBody><p className="text-sm leading-relaxed text-ink-2">None yet. Raise your flag at your pole in game; the log reaches us within a few minutes.</p></PanelBody>
              ) : (
                <ul>
                  {view.candidates.map((c) => (
                    <li key={c.poleKey} className="flex min-h-[60px] items-center justify-between gap-3 border-t border-rule-2 px-4 py-2 first:border-t-0 lg:px-5">
                      <div>
                        <Pole x={c.x} z={c.z} />
                        <div className="text-xs text-muted">raised {ago(c.raisedAt)}</div>
                      </div>
                      <form action="/api/base/declare" method="post">
                        <input type="hidden" name="poleKey" value={c.poleKey} />
                        <button className={btnPrimary} type="submit" disabled={view.declaration !== null}>Declare</button>
                      </form>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

          </>
        )}

        {/* Surfaces for both a solo declarant and a clan's full members (only an
            officer or the leader can actually press charges — reportIncidentDb's
            own gate; a member who cannot still sees why an officer might). */}
        {view.linked && view.incidents.length > 0 && (
          <Panel num="03" title="Witnessed incidents" aside={`${view.incidents.length}`}>
            <PanelBody className="!p-0">
              <p className="px-4 pt-4 text-sm leading-relaxed text-ink-2 lg:px-5">
                The log witnessed these at your base. Pressing charges bans the named players automatically — there is no staff review after you confirm.
              </p>
              <ul>
                {view.incidents.map((i) => <Incident key={i.id} incident={i} />)}
              </ul>
            </PanelBody>
          </Panel>
        )}
        <BackLine href="/me">Your page</BackLine>
      </Body>
    </Page>
  );
}
