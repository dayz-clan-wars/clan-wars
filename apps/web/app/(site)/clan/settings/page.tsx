import type { Metadata } from "next";
import { clanFor } from "@factions/roster";
import { CLAN_NAME_LENGTH, CLAN_TAG_LENGTH, GUEST_PASS_MS, REBIND_CONFIRM_MS, REBIND_COOLDOWN_MS, RELEASED_POLE_GRACE_MS, RENAME_COOLDOWN_MS } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY, DISBAND_WARNING } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { RECRUITING_LIMITS, GAMERTAG_MAX } from "@/lib/clan-limits";
import { when, days, hours } from "@/lib/format";
import { guideLinkFor } from "@/lib/guide-links";
import { Page, PageHead, Body, Panel, PanelBody, Notice, BackLine, SessionLost, ConfirmButton, btnPrimary, btnSecondary, btnDanger, link, field, fieldLabel, checkbox } from "@/app/components/ui";

export const metadata: Metadata = { title: "Clan Wars — clan settings", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const { result } = await searchParams;
  const session = await currentSession();
  if (!session) return <SessionLost next="/clan/settings" />;
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  const view = await clanFor(session.sub);
  const officer = typeof view !== "string" && view.me.status === "full" && (view.me.role === "officer" || view.me.role === "leader");
  if (typeof view === "string" || !officer) {
    return (
      <Page>
        <PageHead guide={guideLinkFor("/clan/settings")} kicker="Clan settings" title="Officers only" />
        <Body className="flex max-w-[40rem] flex-col gap-4">
          {notice && <Notice>{notice}</Notice>}
          <p className="text-ink-2">Settings are for a clan&rsquo;s officers and leader. <a className={link} href="/clan">Your clan</a>.</p>
        </Body>
      </Page>
    );
  }
  const { clan, me, roster, rebindCandidates, guestPasses } = view;
  const leader = me.role === "leader";
  const others = roster.filter((r) => r.status === "full" && r.discordId !== session.sub);

  return (
    <Page>
      <PageHead guide={guideLinkFor("/clan/settings")} kicker={<>[{clan.tag}] · settings</>} title={clan.name} />
      <Body className="flex max-w-[44rem] flex-col gap-4 lg:gap-6">
        {notice && <Notice>{notice}</Notice>}

        <Panel num="01" title="Recruiting post">
          <PanelBody>
            <form className="flex flex-col gap-3" action="/api/clan/recruiting" method="post">
              <label className="flex items-start gap-3 text-sm leading-relaxed text-ink"><input type="checkbox" name="recruiting" value="yes" defaultChecked={clan.recruiting} className={`${checkbox} mt-0.5`} /> Recruiting — listed first on the clans page; players can ask to join</label>
              <label className="block"><span className={fieldLabel}>When you play</span><input className={field} name="playWindow" defaultValue={clan.playWindow ?? ""} maxLength={RECRUITING_LIMITS.playWindow} placeholder="EU evenings, weekends" /></label>
              <label className="block"><span className={fieldLabel}>Language</span><input className={field} name="language" defaultValue={clan.language ?? ""} maxLength={RECRUITING_LIMITS.language} placeholder="English" /></label>
              <label className="block"><span className={fieldLabel}>Pitch</span><textarea className={`${field} py-3`} name="pitch" defaultValue={clan.pitch ?? ""} maxLength={RECRUITING_LIMITS.pitch} rows={3} /></label>
              <button className={`${btnPrimary} self-start`} type="submit">Save</button>
            </form>
          </PanelBody>
        </Panel>

        <Panel num="02" title="Guest passes" aside={guestPasses.length > 0 ? `${guestPasses.length} open` : undefined}>
          <PanelBody>
            <p id="guest-note" className="text-sm leading-relaxed text-ink-2">A pass shows the voice channel only, for {hours(GUEST_PASS_MS)}; joining the clan makes it the real role.</p>
            <form className="mt-3 flex flex-col gap-3" action="/api/clan/guest" method="post">
              <label className="block"><span className={fieldLabel}>Discord user id or gamertag</span><input className={field} name="target" required maxLength={GAMERTAG_MAX} autoComplete="off" aria-describedby="guest-note" /></label>
              <button className={`${btnPrimary} self-start`} type="submit">Grant pass</button>
            </form>
          </PanelBody>
          {guestPasses.length === 0 ? <PanelBody className="border-t border-rule-2 !py-3"><p className="text-sm text-ink-2">No open passes.</p></PanelBody> : (
            <ul className="border-t border-rule-2">
              {guestPasses.map((p) => (
                <li key={p.id} className="flex min-h-[60px] flex-wrap items-center justify-between gap-3 border-t border-rule-2 px-4 py-2 text-sm text-ink first:border-t-0 lg:px-5">
                  <span><span className="font-mono">{p.userDiscordId}</span> <span className="text-xs text-muted">granted by {p.grantedBy} · expires {when(p.expiresAt)}</span></span>
                  <form action="/api/clan/revoke-guest" method="post"><input type="hidden" name="passId" value={p.id} /><ConfirmButton confirm="Revoke it?" className={`${btnSecondary} !px-3.5`}>Revoke</ConfirmButton></form>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        {leader && (
          <>
            <Panel num="03" title="Rename" aside={`once every ${days(RENAME_COOLDOWN_MS)}`}>
              <PanelBody>
                <form className="flex flex-col gap-3" action="/api/clan/rename" method="post">
                  <label className="block"><span className={fieldLabel}>Name</span><input className={field} name="name" defaultValue={clan.name} required minLength={CLAN_NAME_LENGTH.min} maxLength={CLAN_NAME_LENGTH.max} /></label>
                  <label className="block"><span className={fieldLabel}>Tag</span><input className={`${field} uppercase`} name="tag" defaultValue={clan.tag} minLength={CLAN_TAG_LENGTH.min} maxLength={CLAN_TAG_LENGTH.max} pattern="[A-Za-z0-9]+" title={`${CLAN_TAG_LENGTH.min} to ${CLAN_TAG_LENGTH.max} letters or digits`} aria-describedby="rename-note" /></label>
                  <p id="rename-note" className="text-xs text-muted">The old name and tag stay held — nobody else can take them.</p>
                  <button className={`${btnSecondary} self-start`} type="submit">Rename</button>
                </form>
              </PanelBody>
            </Panel>

            <Panel num="04" title="Transfer leadership">
              <PanelBody>
                {others.length === 0 ? <p className="text-sm text-ink-2">No other full member to hand over to.</p> : (
                  <form className="flex flex-col gap-3" action="/api/clan/transfer" method="post">
                    <label className="block"><span className={fieldLabel}>To</span>
                      <select className={field} name="target" required>
                        {others.map((r) => <option key={r.discordId} value={r.discordId}>{r.gamertag ?? "unknown"} — {r.role}</option>)}
                      </select>
                    </label>
                    <label className="flex items-start gap-3 text-sm leading-relaxed text-ink-2"><input type="checkbox" name="confirm" value="yes" required className={`${checkbox} mt-0.5`} /> I understand I become an officer and they lead.</label>
                    <button className={`${btnDanger} self-start`} type="submit">Transfer</button>
                  </form>
                )}
              </PanelBody>
            </Panel>

            <Panel num="05" title="Move the base" aside={`one move per ${days(REBIND_COOLDOWN_MS)}`}>
              <PanelBody>
                <p className="text-sm leading-relaxed text-ink-2">When a member raises your flag at another pole, it appears here for {hours(REBIND_CONFIRM_MS)}. Confirming moves the base; the old pole goes public after {days(RELEASED_POLE_GRACE_MS)}.</p>
                {rebindCandidates.length === 0 && <p className="mt-2 text-sm text-ink-2">No recent raise elsewhere.</p>}
              </PanelBody>
              {rebindCandidates.length > 0 && (
                <ul className="border-t border-rule-2">
                  {rebindCandidates.map((c) => (
                    <li key={c.poleKey} className="flex min-h-[60px] items-center justify-between gap-3 border-t border-rule-2 px-4 py-2 text-sm text-ink first:border-t-0 lg:px-5">
                      <span>raised by <span className="font-mono">{c.by}</span> {when(c.raisedAt)}</span>
                      <form action="/api/clan/rebind" method="post"><input type="hidden" name="poleKey" value={c.poleKey} /><button className={`${btnPrimary} !px-3.5`} type="submit">Move here</button></form>
                    </li>
                  ))}
                </ul>
              )}
            </Panel>

            {/* Rust: the one irreversible act on the page. */}
            <Panel num="06" title="Disband" tone="rust">
              <PanelBody>
                <p className="text-sm leading-relaxed text-ink-2">Irreversible. The flag and the pole return to the pool for anyone to claim; the name and tag are held so nobody can impersonate you. Every member is out, with no cooldown.</p>
                <p className="mt-2 text-sm leading-relaxed text-ink-2">{DISBAND_WARNING}</p>
                <form className="mt-4 border-t border-rule-2 pt-4" action="/api/clan/disband" method="post">
                  <label className="flex items-start gap-3 text-sm leading-relaxed text-ink-2"><input type="checkbox" name="confirm" value="yes" required className={`${checkbox} mt-0.5`} /> Disband {clan.name}.</label>
                  <button className={`mt-3 ${btnDanger}`} type="submit">Disband the clan</button>
                </form>
              </PanelBody>
            </Panel>
          </>
        )}
        <BackLine href="/clan">Your clan</BackLine>
      </Body>
    </Page>
  );
}
