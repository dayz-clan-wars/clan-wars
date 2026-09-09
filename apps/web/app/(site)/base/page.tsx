import type { Metadata } from "next";
import { baseFor } from "@factions/roster";
import { WATCH_ZONE_RADIUS_M } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY, lapsedCopy } from "@/lib/base-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { when } from "@/lib/format";
import { guideLinkFor, guideLink, GUIDE_INLINE } from "@/lib/guide-links";
import { Page, PageHead, Body, Panel, PanelBody, Notice, BackLine, SessionLost, ConfirmButton, btnPrimary, btnDanger, link } from "@/app/components/ui";

export const metadata: Metadata = {
  title: "Clan Wars — your base",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

/** Metres, whole. These are the viewer's own raises; nobody else's pole reaches this page. */
const at = (x: number, z: number) => `${Math.round(x)}, ${Math.round(z)}`;

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
                    <p className="font-mono text-lg text-ink">{at(view.declaration.x, view.declaration.z)}</p>
                    <p className="mt-1 text-sm text-ink-2">Declared {when(view.declaration.declaredAt)}. Your {WATCH_ZONE_RADIUS_M} m watch zone is live.</p>
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
                        <div className="font-mono text-ink">{at(c.x, c.z)}</div>
                        <div className="text-xs text-muted">raised {when(c.raisedAt)}</div>
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
        <BackLine href="/me">Your page</BackLine>
      </Body>
    </Page>
  );
}
