import type { Metadata } from "next";
import { clanFor } from "@factions/roster";
import { ACTIVATION_WINDOW_MS, JOIN_PRESENCE_RADIUS_M, LEADER_SILENT_MS, PENDING_EXPIRY_MS, SUCCESSION_WINDOW_MS } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { LEADERSHIP_RESULT_COPY, CLAIM_REFUSAL } from "@/lib/leadership-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { GAMERTAG_MAX } from "@/lib/clan-limits";
import { when, days, hours } from "@/lib/format";
import { flagImagePath } from "@/src/flag-images";
import { Page, PageHead, Body, Panel, PanelBody, Notice, SegNav, Facts, btnPrimary, btnSecondary, btnDanger, link, kicker, kickerSm, field, checkbox } from "@/app/components/ui";

export const metadata: Metadata = { title: "Clan Wars — your clan", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

/** Hidden target + one button: the shape of every per-row action. */
function RowAction({ action, target, children, style = btnSecondary }: { action: string; target: string; children: React.ReactNode; style?: string }) {
  return (
    <form action={`/api/clan/${action}`} method="post">
      <input type="hidden" name="target" value={target} />
      <button className={`${style} !px-3.5`} type="submit">{children}</button>
    </form>
  );
}

const row = "flex min-h-[56px] flex-wrap items-center gap-3 border-t border-rule-2 px-4 py-2 first:border-t-0 lg:min-h-[60px] lg:gap-4 lg:px-5";

export default async function ClanPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const { result } = await searchParams;
  const session = await currentSession();
  if (!session) {
    return <main className="mx-auto max-w-[40rem] px-5 py-10"><p className="text-ink-2">Your session could not be read. <a className={link} href="/login?next=/clan">Sign in again</a>.</p></main>;
  }
  const notice = result ? (lookupCopy(RESULT_COPY, result) ?? lookupCopy(LEADERSHIP_RESULT_COPY, result)) : undefined;
  const view = await clanFor(session.sub);

  if (view === "not-linked" || view === "not-in-clan") {
    return (
      <Page>
        <PageHead kicker="Your clan" title={view === "not-linked" ? "Not linked" : "No clan yet"} />
        <Body className="flex max-w-[40rem] flex-col gap-4">
          {notice && <Notice>{notice}</Notice>}
          {view === "not-linked"
            ? <p className="text-ink-2"><a className={link} href="/link">Link your character</a> first — a clan is joined by the character, not the Discord account.</p>
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

  const tabs = [
    { label: "Map", href: "/map" },
    { label: "Board", href: "/clan/board" },
    ...(me.status === "full" ? [{ label: "Vault", href: "/clan/vault" }] : []),
    ...(officer ? [{ label: "Settings", href: "/clan/settings" }] : []),
  ];

  return (
    <Page wide>
      <PageHead
        icon={<img src={`/${flagImagePath(clan.texture)}`} alt="" width={96} height={96} className="h-16 w-16 flex-none object-contain lg:h-24 lg:w-24" />}
        kicker={<>[{clan.tag}] · {clan.status} · you are {me.status === "pending" ? "pending" : me.role}</>}
        title={clan.name}
        aside={<SegNav label="Clan pages" items={tabs} />}
      />

      {(notice || clan.status === "reserved" || me.status === "pending") && (
        <div className="flex flex-col gap-2 px-5 pt-5 lg:px-8 lg:pt-6">
          {notice && <Notice>{notice}</Notice>}
          {clan.status === "reserved" && <Notice tone="gold">Reserved. Raise your flag at the pole within {days(ACTIVATION_WINDOW_MS)} of the claim to activate the clan. Until then nobody else can take the name, tag, flag or pole.</Notice>}
          {me.status === "pending" && <Notice tone="gold">You are pending. Stand within {JOIN_PRESENCE_RADIUS_M} m of the clan&rsquo;s base in game and the server log will make you a full member. Unseen for {days(PENDING_EXPIRY_MS)}, the spot expires.</Notice>}
        </div>
      )}

      <div className="grid gap-4 px-5 py-5 lg:grid-cols-[7fr_5fr] lg:gap-6 lg:px-8 lg:pb-10 lg:pt-6">
        <div className="flex flex-col gap-4 lg:gap-6">
          <Panel num="01" title="Roster" aside={<>{full.length} full{pending.length > 0 && `, ${pending.length} pending`}</>}>
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
                        {isPending ? <>asked {when(r.joinedAt)} · must stand at the base within {days(PENDING_EXPIRY_MS)}</> : <>joined {when(r.joinedAt)}{r.lastSeenAt && ` · seen ${when(r.lastSeenAt)}`}</>}
                      </div>
                    </div>
                    {!self && officer && r.status === "full" && r.role === "member" && <RowAction action="kick" target={r.discordId} style={btnDanger}>Remove</RowAction>}
                    {!self && officer && isPending && <RowAction action="kick" target={r.discordId} style={btnDanger}>Remove</RowAction>}
                    {!self && leader && r.status === "full" && r.role === "member" && <RowAction action="promote" target={r.discordId}>Make officer</RowAction>}
                    {!self && leader && r.status === "full" && r.role === "officer" && <RowAction action="demote" target={r.discordId}>Demote</RowAction>}
                  </li>
                );
              })}
            </ul>
          </Panel>

          {officer && (
            <Panel num="02" title="Invite">
              <PanelBody>
                <form className="flex gap-2.5" action="/api/clan/invite" method="post">
                  <input className={`${field} !mt-0 min-w-0 flex-1`} name="gamertag" placeholder="gamertag" required maxLength={GAMERTAG_MAX} autoComplete="off" />
                  <button className={`${btnPrimary} min-h-[52px] flex-none`} type="submit">Invite</button>
                </form>
                <p className="mt-2.5 text-xs text-muted">They must have linked their character on the site.</p>
                {invitesOut.length > 0 && (
                  <ul className="mt-4 border-t border-rule-2">
                    {invitesOut.map((inv) => (
                      <li key={inv.id} className="flex min-h-[52px] items-center justify-between gap-3 text-sm text-ink">
                        <span><span className="font-mono">{inv.inviteeGamertag ?? "unknown"}</span> <span className="text-xs text-muted">expires {when(inv.expiresAt)}</span></span>
                        <form action="/api/clan/revoke-invite" method="post"><input type="hidden" name="inviteId" value={inv.id} /><button className={`${btnSecondary} !min-h-[40px] !px-3.5`} type="submit">Withdraw</button></form>
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
            <Panel num="03" title="Requests to join" aside={<span className="font-display text-lg text-gold">{requestsIn.length}</span>}>
              {requestsIn.length === 0
                ? <PanelBody className="!py-3"><p className="text-sm text-ink-2">{clan.recruiting ? "None open." : "Turn recruiting on in settings to receive requests."}</p></PanelBody>
                : (
                  <ul>
                    {requestsIn.map((r) => (
                      <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 border-t border-rule-2 px-4 py-3 first:border-t-0 lg:px-5">
                        <span><span className="font-mono text-sm text-ink">{r.gamertag ?? "unknown"}</span><div className="text-xs text-muted">asked {when(r.createdAt)}</div></span>
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
            <Panel num={officer ? "04" : "02"} title="Leadership">
              <PanelBody>
                <Facts items={[
                  ["Leader", <span key="l" className="font-mono text-ink">{full.find((r) => r.role === "leader")?.gamertag ?? "unknown"}</span>],
                  ["Last seen", <span key="s" className="text-ink">{leadership.leaderLastSeenAt ? when(leadership.leaderLastSeenAt) : "never"}</span>],
                  ...(leadership.openClaim
                    ? [["Succession", <span key="c" className="text-ink">{leadership.openClaim.claimantGamertag} has claimed the seat from {leadership.openClaim.leaderGamertag}. Resolves {when(leadership.openClaim.resolvesAt)}.</span>] as [React.ReactNode, React.ReactNode]]
                    : (leadership.canClaim === "not-eligible" || leadership.canClaim === "leader-active")
                      ? [["Succession", CLAIM_REFUSAL[leadership.canClaim]] as [React.ReactNode, React.ReactNode]]
                      : []),
                ]} />
                {!leadership.openClaim && leadership.canClaim === "eligible" && (
                  <form className="mt-4 border-t border-rule-2 pt-4" action="/api/clan/claim-succession" method="post">
                    <label className="flex items-start gap-3 text-sm leading-relaxed text-ink-2"><input type="checkbox" name="confirm" value="yes" className={`${checkbox} mt-0.5`} /> I understand this opens a {hours(SUCCESSION_WINDOW_MS)} window that is voided if the leader is seen in game.</label>
                    <button className={`mt-3 ${btnPrimary}`} type="submit">Claim leadership — the leader has been silent for {days(LEADER_SILENT_MS)}</button>
                  </form>
                )}

                <div className="mt-4 border-t border-rule-2 pt-4">
                  <div className={kickerSm}>No-confidence vote</div>
                  {leadership.openVote ? (
                    <>
                      <p className="mt-1.5 text-sm text-ink">Replace {leadership.openVote.leaderGamertag} with {leadership.openVote.nomineeGamertag}</p>
                      <p className="mt-1 text-sm text-ink-2">{leadership.openVote.ballots} of {leadership.openVote.threshold} needed (electorate {leadership.openVote.electorateSize}) · closes {when(leadership.openVote.closesAt)}</p>
                      {leadership.openVote.inElectorate && !leadership.openVote.myBallot && (
                        <form className="mt-3" action="/api/clan/cast-vote" method="post">
                          <label className="flex items-center gap-3 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" className={checkbox} /> I confirm my vote.</label>
                          <button className={`mt-3 ${btnPrimary}`} type="submit">Vote yes</button>
                        </form>
                      )}
                      {leadership.openVote.myBallot && <p className="mt-2 text-sm text-ink-2">You voted.</p>}
                      {!leadership.openVote.inElectorate && !leader && <p className="mt-2 text-sm text-ink-2">Members who joined after the vote opened do not vote in it.</p>}
                      {leader && <p className="mt-2 text-sm text-ink-2">You can make your case in the clan channel.</p>}
                    </>
                  ) : leader ? (
                    <p className="mt-1.5 text-sm leading-relaxed text-ink-2">None open.</p>
                  ) : (
                    <form className="mt-1.5" action="/api/clan/open-vote" method="post">
                      <p className="text-sm leading-relaxed text-ink-2">None open. Any member can nominate a replacement.</p>
                      <label className="mt-3 block"><span className={kickerSm}>Nominee</span>
                        <select className={field} name="target" required disabled={voteBlocked}>
                          {full.filter((r) => r.role !== "leader").map((r) => (
                            <option key={r.discordId} value={r.discordId}>{r.gamertag ?? "unknown"}</option>
                          ))}
                        </select>
                      </label>
                      <label className="mt-3 flex items-center gap-3 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" className={checkbox} /> I understand this opens a no-confidence vote.</label>
                      <button className={`mt-3 ${btnSecondary}`} type="submit" disabled={voteBlocked}>Nominate</button>
                      {voteBlocked && <p className="mt-2 text-xs text-muted">A vote failed recently; the next is possible after {when(leadership.nextVoteAllowedAt!)}.</p>}
                    </form>
                  )}
                </div>
              </PanelBody>
            </Panel>
          )}

          <Panel num={officer ? "05" : me.status === "full" ? "03" : "02"} title="Leave">
            <PanelBody>
              {leader
                ? <p className="text-sm leading-relaxed text-ink-2">A leader cannot leave. <a className={link} href="/clan/settings">Transfer leadership</a> first, or disband.</p>
                : (
                  <form action="/api/clan/leave" method="post">
                    <label className="flex items-start gap-3 text-sm leading-relaxed text-ink-2"><input type="checkbox" name="confirm" value="yes" className={`${checkbox} mt-0.5`} /> I understand I cannot join a clan again for a while after leaving.</label>
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
