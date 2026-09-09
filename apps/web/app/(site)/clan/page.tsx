import type { Metadata } from "next";
import { clanFor } from "@factions/roster";
import { ACTIVATION_WINDOW_MS, JOIN_PRESENCE_RADIUS_M, LEADER_SILENT_MS, PENDING_EXPIRY_MS, SUCCESSION_WINDOW_MS } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { LEADERSHIP_RESULT_COPY } from "@/lib/leadership-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { GAMERTAG_MAX } from "@/lib/clan-limits";
import { GamertagField } from "@/app/components/gamertag-field";
import { when, days, hours, ago } from "@/lib/format";
import { Page, PageHead, Body, Panel, PanelBody, Notice, Facts, ConfirmButton, SessionLost, FieldError, invalid, btnPrimary, btnSecondary, btnDanger, link, kickerSm, field, checkbox } from "@/app/components/ui";
import { guideLinkFor, guideLink, GUIDE_INLINE } from "@/lib/guide-links";
import { fieldError } from "@/lib/field-errors";
import { OwnClanHero } from "@/app/components/own-clan-hero";

export const metadata: Metadata = { title: "Clan Wars — your clan", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

/** Hidden target + one button: the shape of every per-row action. */
function RowAction({ action, target, children, style = btnSecondary, confirm }: { action: string; target: string; children: React.ReactNode; style?: string; confirm?: string }) {
  return (
    <form action={`/api/clan/${action}`} method="post">
      <input type="hidden" name="target" value={target} />
      {confirm
        ? <ConfirmButton confirm={confirm} className={`${style} !px-3.5`}>{children}</ConfirmButton>
        : <button className={`${style} !px-3.5`} type="submit">{children}</button>}
    </form>
  );
}

const row = "flex min-h-[56px] flex-wrap items-center gap-3 border-t border-rule-2 px-4 py-2 first:border-t-0 lg:min-h-[60px] lg:gap-4 lg:px-5";

export default async function ClanPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const { result } = await searchParams;
  const session = await currentSession();
  if (!session) {
    return <SessionLost next="/clan" />;
  }
  const notice = result ? (lookupCopy(RESULT_COPY, result) ?? lookupCopy(LEADERSHIP_RESULT_COPY, result)) : undefined;
  // A result about the invite's gamertag is shown under that field too, and it takes focus instead of the notice.
  const err = fieldError(result, RESULT_COPY);
  const view = await clanFor(session.sub);

  if (view === "not-linked" || view === "not-in-clan") {
    return (
      <Page>
        <PageHead guide={guideLinkFor("/clan")} kicker="Your clan" title={view === "not-linked" ? "Not linked" : "No clan yet"} />
        <Body className="flex max-w-[40rem] flex-col gap-4">
          {notice && <Notice>{notice}</Notice>}
          {view === "not-linked"
            ? <p className="text-ink-2"><a className={link} href="/link">Link your character</a> first — a clan is joined by the character, not the Discord account. <a className={link} href={guideLink(GUIDE_INLINE.gettingIn).href}>How linking works</a>.</p>
            : <p className="text-ink-2">You are not in a clan. <a className={link} href="/clans">Browse the clans</a>, accept an invite on <a className={link} href="/me">your page</a>, or found one at a flagpole with two friends.</p>}
        </Body>
      </Page>
    );
  }

  const { clan, me, roster, invitesOut, requestsIn, leadership } = view;
  const officer = me.status === "full" && (me.role === "officer" || me.role === "leader");
  const leader = me.status === "full" && me.role === "leader";
  const full = roster.filter((r) => r.status === "full");
  const pending = roster.filter((r) => r.status === "pending");
  const voteBlocked = leadership.nextVoteAllowedAt !== null && leadership.nextVoteAllowedAt.getTime() > Date.now();

  return (
    <Page wide>
      <OwnClanHero view={view} current="clan" guide={guideLinkFor("/clan")} />

      {(notice || clan.status === "reserved" || me.status === "pending") && (
        <div className="flex flex-col gap-2 px-5 pt-5 lg:px-8 lg:pt-6">
          {notice && <Notice focus={err === null}>{notice}</Notice>}
          {clan.status === "reserved" && <Notice tone="gold" focus={false}>Reserved. Raise your flag at the pole within {days(ACTIVATION_WINDOW_MS)} of the claim to activate the clan. Until then nobody else can take the name, tag, flag or pole.</Notice>}
          {me.status === "pending" && <Notice tone="gold" focus={false}>You are pending. Stand within {JOIN_PRESENCE_RADIUS_M} m of the clan&rsquo;s base in game and the server log will make you a full member. Unseen for {days(PENDING_EXPIRY_MS)}, the spot expires.</Notice>}
        </div>
      )}

      <div className="grid gap-4 px-5 py-5 lg:grid-cols-[7fr_5fr] lg:gap-6 lg:px-8 lg:pb-10 lg:pt-6">
        <div className="flex flex-col gap-4 lg:gap-6">
          <Panel title="Roster" aside={<>{full.length} full{pending.length > 0 && `, ${pending.length} pending`}</>}>
            <ul>
              {[...full, ...pending].map((r) => {
                const self = r.discordId === session.sub;
                const isPending = r.status === "pending";
                return (
                  <li key={r.dayzId} className={`${row} ${isPending ? "bg-surface" : ""}`}>
                    <div className="min-w-0 flex-1">
                      <span className={`font-mono text-sm lg:text-[15px] ${isPending ? "text-ink-2" : "text-ink"}`}>{r.gamertag ?? "unknown"}</span>
                      <span className={`ml-2.5 ${kickerSm} ${isPending || r.role === "leader" ? "!text-gold" : ""}`}>{isPending ? "pending" : r.role}{self && " · you"}</span>
                      <div className="mt-0.5 text-xs text-muted">
                        {isPending ? <>asked {ago(r.joinedAt)} · must stand at the base within {days(PENDING_EXPIRY_MS)}</> : <>joined {ago(r.joinedAt)}{r.lastSeenAt && ` · seen ${ago(r.lastSeenAt)}`}</>}
                      </div>
                    </div>
                    {!self && officer && r.status === "full" && r.role === "member" && <RowAction action="kick" target={r.discordId} style={btnDanger} confirm="Remove them?">Remove</RowAction>}
                    {!self && officer && isPending && <RowAction action="kick" target={r.discordId} style={btnDanger} confirm="Remove them?">Remove</RowAction>}
                    {!self && leader && r.status === "full" && r.role === "member" && <RowAction action="promote" target={r.discordId}>Make officer</RowAction>}
                    {!self && leader && r.status === "full" && r.role === "officer" && <RowAction action="demote" target={r.discordId} confirm="Demote them?">Demote</RowAction>}
                  </li>
                );
              })}
            </ul>
          </Panel>

          {officer && (
            <Panel title="Invite">
              <PanelBody>
                <form className="flex gap-2.5" action="/api/clan/invite" method="post">
                  <GamertagField scope="linked" {...invalid(err, "gamertag")} className={`!mt-0 ${invalid(err, "gamertag").className ?? ""}`} name="gamertag" placeholder="gamertag" aria-label="Gamertag" required maxLength={GAMERTAG_MAX} aria-describedby={err?.field === "gamertag" ? "err-gamertag invite-note" : "invite-note"} />
                  <button className={`${btnPrimary} min-h-[52px] flex-none`} type="submit">Invite</button>
                </form>
                <FieldError err={err} name="gamertag" />
                <p id="invite-note" className="mt-2.5 text-xs text-muted">They must have linked their character on the site.</p>
                {invitesOut.length > 0 && (
                  <ul className="mt-4 border-t border-rule-2">
                    {invitesOut.map((inv) => (
                      <li key={inv.id} className="flex min-h-[52px] items-center justify-between gap-3 text-sm text-ink">
                        <span><span className="font-mono">{inv.inviteeGamertag ?? "unknown"}</span> <span className="text-xs text-muted">expires {when(inv.expiresAt)}</span></span>
                        <form action="/api/clan/revoke-invite" method="post"><input type="hidden" name="inviteId" value={inv.id} /><ConfirmButton confirm="Withdraw it?" className={`${btnSecondary} !px-3.5`}>Withdraw</ConfirmButton></form>
                      </li>
                    ))}
                  </ul>
                )}
              </PanelBody>
            </Panel>
          )}
        </div>

        <div className="flex flex-col gap-4 lg:gap-6">
          {officer && (
            <Panel title="Requests to join" aside={<span className="font-display text-lg text-gold">{requestsIn.length}</span>}>
              {requestsIn.length === 0
                ? <PanelBody className="!py-3"><p className="text-sm text-ink-2">{clan.recruiting ? "None open." : "Turn recruiting on in settings to receive requests."}</p></PanelBody>
                : (
                  <ul>
                    {requestsIn.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-rule-2 px-4 py-3 first:border-t-0 lg:px-5">
                        <span><span className="font-mono text-sm text-ink">{r.gamertag ?? "unknown"}</span><div className="text-xs text-muted">asked {ago(r.createdAt)}</div></span>
                        <span className="flex gap-2">
                          <form action="/api/clan/decide-request" method="post"><input type="hidden" name="requestId" value={r.id} /><input type="hidden" name="decision" value="accepted" /><button className={`${btnPrimary} !px-3.5`} type="submit">Accept</button></form>
                          <form action="/api/clan/decide-request" method="post"><input type="hidden" name="requestId" value={r.id} /><input type="hidden" name="decision" value="declined" /><button className={`${btnSecondary} !px-3.5`} type="submit">Decline</button></form>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
            </Panel>
          )}

          {me.status === "full" && (
            <Panel title="Leadership">
              <PanelBody>
                {/* Succession is said only when it can happen (App Review §02): an open claim, or a leader silent long enough. */}
                <Facts items={[
                  ["Leader", <span key="l" className="font-mono text-ink">{full.find((r) => r.role === "leader")?.gamertag ?? "unknown"}</span>],
                  ["Last seen", <span key="s" className="text-ink">{leadership.leaderLastSeenAt ? ago(leadership.leaderLastSeenAt) : "never"}{leadership.canClaim === "leader-active" && <span className={`${kickerSm} ml-2 !text-olive`}>active</span>}</span>],
                  ...(leadership.openClaim
                    ? [["Succession", <span key="c" className="text-ink">{leadership.openClaim.claimantGamertag} has claimed the seat from {leadership.openClaim.leaderGamertag}. Resolves {when(leadership.openClaim.resolvesAt)}.</span>] as [React.ReactNode, React.ReactNode]]
                    : []),
                ]} />
                {!leadership.openClaim && leadership.canClaim === "eligible" && (
                  <form className="mt-4 border-t border-rule-2 pt-4" action="/api/clan/claim-succession" method="post">
                    <input type="hidden" name="confirm" value="yes" />
                    <p className="text-sm leading-relaxed text-ink-2">The leader has been silent for {days(LEADER_SILENT_MS)}. Claiming opens a {hours(SUCCESSION_WINDOW_MS)} window that is voided if they are seen in game.</p>
                    <ConfirmButton confirm="Claim it?" className={`mt-3 ${btnPrimary}`}>Claim leadership</ConfirmButton>
                  </form>
                )}
              </PanelBody>

              {/* The vote: the live tally when one is open, otherwise folded — it is rare, and the form was under every roster every visit. */}
              {leadership.openVote || leader ? (
                <PanelBody className="border-t border-rule-2">
                  <div className={kickerSm}>No-confidence vote</div>
                  {leadership.openVote ? (
                    <>
                      <p className="mt-1.5 text-sm text-ink">Replace {leadership.openVote.leaderGamertag} with {leadership.openVote.nomineeGamertag}</p>
                      <p className="mt-1 text-sm text-ink-2">{leadership.openVote.ballots} of {leadership.openVote.threshold} needed (electorate {leadership.openVote.electorateSize}) · closes {when(leadership.openVote.closesAt)}</p>
                      {leadership.openVote.inElectorate && !leadership.openVote.myBallot && (
                        <form className="mt-3" action="/api/clan/cast-vote" method="post">
                          <input type="hidden" name="confirm" value="yes" />
                          <ConfirmButton confirm="Cast it?" className={btnPrimary}>Vote yes</ConfirmButton>
                        </form>
                      )}
                      {leadership.openVote.myBallot && <p className="mt-2 text-sm text-ink-2">You voted.</p>}
                      {!leadership.openVote.inElectorate && !leader && <p className="mt-2 text-sm text-ink-2">Members who joined after the vote opened do not vote in it.</p>}
                      {leader && <p className="mt-2 text-sm text-ink-2">You can make your case in the clan channel.</p>}
                    </>
                  ) : (
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-2">None open.</p>
                  )}
                </PanelBody>
              ) : (
                <details className="group border-t border-rule-2">
                  <summary className="flex min-h-[48px] cursor-pointer list-none items-center justify-between px-4 font-mono text-[11px] uppercase tracking-[0.18em] text-muted hover:text-ink lg:px-5 [&::-webkit-details-marker]:hidden">
                    Open a no-confidence vote <span aria-hidden="true" className="group-open:hidden">▾</span><span aria-hidden="true" className="hidden group-open:inline">▴</span>
                  </summary>
                  <form className="border-t border-rule-2 p-4 lg:p-5" action="/api/clan/open-vote" method="post">
                    <input type="hidden" name="confirm" value="yes" />
                    <p className="text-sm leading-relaxed text-ink-2">Any member can nominate a replacement. The roster freezes for the length of the vote.</p>
                    <label className="mt-3 block"><span className={kickerSm}>Nominee</span>
                      <select className={field} name="target" required disabled={voteBlocked}>
                        {full.filter((r) => r.role !== "leader").map((r) => (
                          <option key={r.discordId} value={r.discordId}>{r.gamertag ?? "unknown"}</option>
                        ))}
                      </select>
                    </label>
                    <ConfirmButton confirm="Open the vote?" className={`mt-3 ${btnSecondary}`} disabled={voteBlocked}>Nominate</ConfirmButton>
                    {voteBlocked && <p className="mt-2 text-xs text-muted">A vote failed recently; the next is possible after {when(leadership.nextVoteAllowedAt!)}.</p>}
                  </form>
                </details>
              )}
            </Panel>
          )}

          <Panel title="Leave">
            <PanelBody>
              {leader
                ? <p className="text-sm leading-relaxed text-ink-2">A leader cannot leave. <a className={link} href="/clan/settings">Transfer leadership</a> first, or disband.</p>
                : (
                  <form action="/api/clan/leave" method="post">
                    <label className="flex items-start gap-3 text-sm leading-relaxed text-ink-2"><input type="checkbox" name="confirm" value="yes" required className={`${checkbox} mt-0.5`} /> I understand I cannot join a clan again for a while after leaving.</label>
                    <button className={`mt-3.5 ${btnDanger}`} type="submit">Leave the clan</button>
                  </form>
                )}
            </PanelBody>
          </Panel>
        </div>
      </div>
    </Page>
  );
}
