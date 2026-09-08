import type { Metadata } from "next";
import { viewerFor, myInvites, myRequests, claimContext } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { LINK_TTL_MS, LINK_EMOTES, JOIN_PRESENCE_RADIUS_M, PENDING_EXPIRY_MS } from "@factions/domain";
import { UNLINK_COPY } from "@/lib/link-copy";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { when, days } from "@/lib/format";
import { flagImagePath } from "@/src/flag-images";
import { Page, Panel, PanelBody, Notice, Footer, GuideLine, SessionLost, btnCta, btnPrimary, btnSecondary, btnQuiet, link, kicker, kickerSm } from "@/app/components/ui";
import { guideLinkFor } from "@/lib/guide-links";

export const metadata: Metadata = {
  title: "Clan Wars — you",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

/** A full-width cell link in a panel's foot: "Your clan page →". */
const cell = "flex min-h-[52px] items-center justify-between px-4 font-display text-[13px] uppercase tracking-[0.06em] text-ink hover:bg-surface lg:px-5";

export default async function MePage({ searchParams }: { searchParams: Promise<{ unlink?: string; result?: string }> }) {
  const { unlink: unlinkCode, result } = await searchParams;
  // ⚠️ Looked up, never echoed: ?unlink= and ?result= are attacker-supplied,
  // including prototype keys like `__proto__`, so the lookup must miss on
  // those rather than returning a value off Object.prototype.
  const unlinkNotice = unlinkCode ? lookupCopy(UNLINK_COPY, unlinkCode) : undefined;
  const resultNotice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  const session = await currentSession();
  if (!session) {
    // The middleware admitted this request, so the cookie was valid a moment
    // ago. Say what happened rather than rendering an empty page.
    return <SessionLost next="/me" />;
  }
  const viewer = await viewerFor(session.sub);
  const [invites, requests, claim] = await Promise.all([myInvites(session.sub), myRequests(session.sub), claimContext(session.sub)]);
  const showInvites = invites.length > 0 && viewer.clan === null && viewer.pending === null;

  return (
    <Page wide>
      <div className="flex flex-col gap-4 px-5 pt-7 lg:flex-row lg:items-end lg:justify-between lg:gap-8 lg:px-8 lg:pt-10">
        <div>
          <div className={kicker}>Signed in as</div>
          <h1 className="mt-2 font-display text-[40px] uppercase leading-[.9] tracking-[-0.02em] text-ink [overflow-wrap:anywhere] lg:text-[56px]">{session.name}</h1>
        </div>
        <div className="flex flex-col gap-3 pb-1.5 lg:items-end">
          <GuideLine guide={guideLinkFor("/me")} />
          <div className={`flex items-center gap-3 ${kicker}`}>
            <span className={`inline-block h-2 w-2 ${viewer.link ? "bg-olive" : "bg-rust"}`} />
            {viewer.link ? "Linked" : "Not linked"}
          </div>
        </div>
      </div>

      {(unlinkNotice || resultNotice) && (
        <div className="mt-6 flex flex-col gap-2 px-5 lg:px-8">
          {unlinkNotice && <Notice>{unlinkNotice}</Notice>}
          {resultNotice && <Notice>{resultNotice}</Notice>}
        </div>
      )}

      <div className="grid gap-4 px-5 pb-8 pt-5 lg:grid-cols-2 lg:gap-6 lg:px-8 lg:pb-10 lg:pt-6">
        <div className="flex flex-col gap-4 lg:gap-6">
          <Panel num="01" title="Your character">
            <PanelBody>
              {viewer.link ? (
                <>
                  <div className="flex items-baseline gap-3">
                    <span className="font-mono text-lg text-ink lg:text-[22px]">{viewer.link.gamertag}</span>
                    <span className={`${kickerSm} !text-olive`}>Linked</span>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed text-ink-2">
                    {viewer.clan
                      ? "Unlinking is refused while you are in a clan — leave it first."
                      : "Unlinking releases your solo base, if you have declared one."}
                  </p>
                  <form className="mt-3" action="/api/link/unlink" method="post">
                    <button className={`${btnQuiet} ${viewer.clan ? "!text-dim" : ""}`} type="submit" disabled={viewer.clan !== null}>Unlink</button>
                  </form>
                </>
              ) : (
                <p className="text-sm leading-relaxed text-ink-2">
                  Not linked yet. <a className={link} href="/link">Link your character</a> — {LINK_EMOTES} emotes in game, {LINK_TTL_MS / 60_000} minutes.
                </p>
              )}
            </PanelBody>
          </Panel>

          <Panel num="02" title="Your clan">
            {viewer.clan ? (
              <>
                <PanelBody className="flex items-center gap-4">
                  <img src={`/${flagImagePath(viewer.clan.texture)}`} alt="" width={56} height={56} className="h-11 w-11 object-contain lg:h-14 lg:w-14" />
                  <div>
                    <div className="font-display text-lg text-ink lg:text-[22px]">{viewer.clan.name} <span className="font-mono text-[13px] text-ink-2">[{viewer.clan.tag}]</span></div>
                    <div className={`mt-1 ${kickerSm}`}>{viewer.clan.role} · {viewer.clan.status}</div>
                  </div>
                </PanelBody>
                <div className="grid grid-cols-2 border-t border-rule-2">
                  <a className={`${cell} border-r border-rule-2`} href="/clan">Your clan page <span className="text-gold">→</span></a>
                  <a className={cell} href="/map">The map <span className="text-gold">→</span></a>
                </div>
              </>
            ) : viewer.pending ? (
              <>
                <PanelBody>
                  <p className="text-ink">Pending in <span className="font-display">{viewer.pending.name}</span> <span className="font-mono text-ink-2">[{viewer.pending.tag}]</span></p>
                  <p className="mt-2 text-sm leading-relaxed text-ink-2">Stand within {JOIN_PRESENCE_RADIUS_M} m of the clan&rsquo;s base in game and the server log will make you a full member. Unseen for {days(PENDING_EXPIRY_MS)}, the spot expires. Until then your solo base, if you have one, is still yours.</p>
                </PanelBody>
                <div className="grid grid-cols-2 border-t border-rule-2">
                  <a className={`${cell} border-r border-rule-2`} href="/clan">The roster <span className="text-gold">→</span></a>
                  <a className={cell} href="/map">The map <span className="text-gold">→</span></a>
                </div>
              </>
            ) : (
              <>
                <PanelBody><p className="text-sm text-ink-2">You are not in a clan.</p></PanelBody>
                <div className={`grid border-t border-rule-2 ${viewer.link ? "grid-cols-3" : "grid-cols-1"}`}>
                  {viewer.link && <a className={`${cell} border-r border-rule-2`} href="/base">Solo base <span className="text-gold">→</span></a>}
                  {viewer.link && <a className={`${cell} border-r border-rule-2`} href="/map">The map <span className="text-gold">→</span></a>}
                  <a className={cell} href="/clans">Browse the clans <span className="text-gold">→</span></a>
                </div>
              </>
            )}
          </Panel>
        </div>

        <div className="flex flex-col gap-4 lg:gap-6">
          {claim && (
            <Panel num="03" title="A ceremony is waiting" tone="gold">
              <PanelBody>
                <p className="text-base leading-relaxed text-ink">{claim.ceremony.participants.length} linked players raised the neutral flag together. Any one of you can found the clan until <span className="font-mono">{when(claim.ceremony.expiresAt)}</span>.</p>
                <a className={`mt-4 ${btnCta} min-h-[52px]`} href={`/claim/${claim.ceremony.id}`}>Found the clan <span className="font-mono normal-case">→</span></a>
              </PanelBody>
            </Panel>
          )}

          {showInvites && (
            <Panel num={claim ? "04" : "03"} title="Invites" aside={`${invites.length} open`}>
              <ul>
                {invites.map((inv) => (
                  <li key={inv.id} className="flex min-h-[64px] flex-wrap items-center gap-3.5 border-t border-rule-2 px-4 py-2 first:border-t-0 lg:px-5">
                    <div className="min-w-0 flex-1">
                      <div className="font-display text-[15px] text-ink">{inv.clanName} <span className="font-mono text-xs text-ink-2">[{inv.tag}]</span></div>
                      <div className="font-mono text-xs text-muted">expires {when(inv.expiresAt)}</div>
                    </div>
                    <form action="/api/me/invite/accept" method="post"><input type="hidden" name="inviteId" value={inv.id} /><button className={btnPrimary} type="submit">Accept</button></form>
                    <form action="/api/me/invite/decline" method="post"><input type="hidden" name="inviteId" value={inv.id} /><button className={btnSecondary} type="submit">Decline</button></form>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {requests.length > 0 && (
            <Panel num={claim && showInvites ? "05" : claim || showInvites ? "04" : "03"} title="Your requests" aside={`${requests.length} open`}>
              <ul>
                {requests.map((r) => (
                  <li key={r.id} className="flex min-h-[64px] flex-wrap items-center gap-3.5 border-t border-rule-2 px-4 py-2 first:border-t-0 lg:px-5">
                    <div className="min-w-0 flex-1">
                      <div className="font-display text-[15px] text-ink">{r.clanName} <span className="font-mono text-xs text-ink-2">[{r.tag}]</span></div>
                      <div className="font-mono text-xs text-muted">asked {when(r.createdAt)} · expires {when(r.expiresAt)}</div>
                    </div>
                    <form action="/api/me/request/withdraw" method="post"><input type="hidden" name="requestId" value={r.id} /><button className={btnSecondary} type="submit">Withdraw</button></form>
                  </li>
                ))}
              </ul>
            </Panel>
          )}
        </div>
      </div>

      <Footer>
        {/* The logout route is POST-only (app/api/auth/logout/route.ts), so a form, not a link. */}
        <form action="/api/auth/logout" method="post"><button className="flex min-h-[44px] items-center uppercase tracking-[0.18em] text-muted hover:text-ink" type="submit">Sign out</button></form>
      </Footer>
    </Page>
  );
}
