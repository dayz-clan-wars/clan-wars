import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { claimContext } from "@factions/roster";
import { ACTIVATION_WINDOW_MS, CLAN_NAME_LENGTH, CLAN_SIZE_CAP, CLAN_TAG_LENGTH, MIN_BASE_SPACING_M } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { when, days } from "@/lib/format";
import { flagImagePath } from "@/src/flag-images";
import { guideLinkFor } from "@/lib/guide-links";
import { Page, PageHead, Body, Panel, PanelBody, Notice, BackLine, SessionLost, btnCta, field, fieldLabel, checkbox, kickerSm } from "@/app/components/ui";

export const metadata: Metadata = { title: "Clan Wars — found your clan", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

export default async function ClaimPage({ params, searchParams }: { params: Promise<{ ceremony: string }>; searchParams: Promise<{ result?: string }> }) {
  const { ceremony: raw } = await params;
  const { result } = await searchParams;
  const session = await currentSession();
  if (!session) return <SessionLost next={`/claim/${raw}`} />;
  // ⚠️ The package returns the VIEWER's open ceremony; the id in the URL must be that one, or it is not theirs to see.
  const ctx = await claimContext(session.sub);
  if (!ctx || String(ctx.ceremony.id) !== raw) notFound();
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  const me = ctx.ceremony.participants.find((p) => p.discordId === session.sub);

  return (
    <Page>
      <PageHead guide={guideLinkFor("/claim/[ceremony]")} kicker="Found your clan" title={`${ctx.ceremony.participants.length} of you raised the flag`}
        sub={<>Witnessed {when(ctx.ceremony.detectedAt)}. Claim it before {when(ctx.ceremony.expiresAt)}. Whoever claims becomes leader.</>} />
      <Body className="flex max-w-[44rem] flex-col gap-4 lg:gap-6">
        {notice && <Notice>{notice}</Notice>}

        <form className="flex flex-col gap-4 lg:gap-6" action="/api/claim" method="post">
          <input type="hidden" name="ceremonyId" value={ctx.ceremony.id} />

          <Panel num="01" title="Name and tag">
            <PanelBody className="flex flex-col gap-3">
              <label className="block"><span className={fieldLabel}>Name</span>
                <input className={field} name="name" required minLength={CLAN_NAME_LENGTH.min} maxLength={CLAN_NAME_LENGTH.max} autoComplete="off" />
              </label>
              <label className="block"><span className={fieldLabel}>Tag — {CLAN_TAG_LENGTH.min} to {CLAN_TAG_LENGTH.max} letters or digits</span>
                <input className={`${field} uppercase`} name="tag" required minLength={CLAN_TAG_LENGTH.min} maxLength={CLAN_TAG_LENGTH.max} pattern="[A-Za-z0-9]+" autoComplete="off" />
              </label>
            </PanelBody>
          </Panel>

          <Panel num="02" title="Flag" aside={`${ctx.freeFlags.length} free`}>
            <PanelBody>
              <fieldset>
                <legend className="sr-only">Flag</legend>
                <ul className="grid grid-cols-4 gap-2 sm:grid-cols-6">
                  {ctx.freeFlags.map((f) => (
                    <li key={f}>
                      <label className="flex cursor-pointer flex-col items-center gap-1 border-2 border-rule-3 p-2 has-[:checked]:border-gold has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-gold">
                        <input type="radio" name="texture" value={f} required className="sr-only" />
                        <img src={`/${flagImagePath(f)}`} alt={f} width={48} height={48} className="h-12 w-12 object-contain" />
                        <span className="font-mono text-[10px] text-muted">{f.replace(/^Flag_/u, "")}</span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
            </PanelBody>
          </Panel>

          <Panel num="03" title="Roster" aside={`at most ${CLAN_SIZE_CAP}`}>
            <PanelBody>
              <fieldset>
                <legend className="text-sm leading-relaxed text-ink-2">Untick anyone who should not be in. Only people at the ceremony can be founding members.</legend>
                <ul className="mt-2 flex flex-col">
                  {ctx.ceremony.participants.map((p) => (
                    <li key={p.dayzId}>
                      <label className="flex min-h-[44px] items-center gap-3 text-ink">
                        <input type="checkbox" name="member" value={p.dayzId} defaultChecked disabled={p.dayzId === me?.dayzId} className={checkbox} />
                        <span className="font-mono">{p.gamertag}</span>
                        {p.dayzId === me?.dayzId && <span className={`${kickerSm} !text-gold`}>you — leader</span>}
                      </label>
                    </li>
                  ))}
                </ul>
                {/* A disabled checkbox does not post; the claimant must be on the roster, so carry them explicitly. */}
                {me && <input type="hidden" name="member" value={me.dayzId} />}
              </fieldset>
            </PanelBody>
          </Panel>

          <p className="text-sm leading-relaxed text-ink-2">Claiming reserves the name, tag, flag and pole. Raise your flag at the pole within {days(ACTIVATION_WINDOW_MS)} to activate. No two bases sit within {MIN_BASE_SPACING_M} m of each other — if the pole is too close to one you cannot see, the claim is refused.</p>
          <button className={btnCta} type="submit">Found the clan <span className="font-mono normal-case">→</span></button>
        </form>
        <BackLine href="/me">Your page</BackLine>
      </Body>
    </Page>
  );
}
