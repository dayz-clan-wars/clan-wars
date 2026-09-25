import type { Metadata } from "next";
import { clanFor } from "@factions/roster";
import { GUEST_PASS_MS, REBIND_CONFIRM_MS, REBIND_COOLDOWN_MS, RELEASED_POLE_GRACE_MS, RENAME_COOLDOWN_MS } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY, DISBAND_WARNING } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { RECRUITING_LIMITS, GAMERTAG_MAX } from "@/lib/clan-limits";
import { GamertagField } from "@/app/components/gamertag-field";
import { days, hours, ago } from "@/lib/format";
import { guideLinkFor } from "@/lib/guide-links";
import { Page, PageHead, Body, Panel, PanelBody, Notice, BackLine, SessionLost, FieldError, invalid, btnPrimary, btnDanger, link, field, fieldLabel, checkbox, SubmitButton } from "@/app/components/ui";
import { fieldError } from "@/lib/field-errors";
import { readKept } from "@/lib/form";
import { RenameForm } from "./rename-form";
import { GuestPassList } from "./guest-passes";
import { OwnClanHero } from "@/app/components/own-clan-hero";
import { RowAction } from "@/app/components/row-action";

export const metadata: Metadata = { title: "Clan Wars — clan settings", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

export default async function SettingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const q = await searchParams;
  const result = typeof q.result === "string" ? q.result : undefined;
  const kept = readKept(q);
  const session = await currentSession();
  if (!session) return <SessionLost next="/clan/settings" />;
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  // A result about one field is shown under that field too, and the field takes focus instead of the notice.
  const err = fieldError(result, RESULT_COPY);
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
    <Page wide>
      <OwnClanHero view={view} current="settings" guide={guideLinkFor("/clan/settings")} />
      <Body className="flex max-w-[44rem] flex-col gap-4 lg:gap-6">
        {notice && <Notice focus={err === null}>{notice}</Notice>}

        <Panel num="01" title="Recruiting post">
          <PanelBody>
            <form className="flex flex-col gap-3" action="/api/clan/recruiting" method="post">
              <label className="flex items-start gap-3 text-sm leading-relaxed text-ink"><input type="checkbox" name="recruiting" value="yes" defaultChecked={clan.recruiting} className={`${checkbox} mt-0.5`} /> Recruiting — listed first on the clans page; players can ask to join</label>
              <label className="block"><span className={fieldLabel}>When you play</span><input className={field} name="playWindow" defaultValue={clan.playWindow ?? ""} maxLength={RECRUITING_LIMITS.playWindow} placeholder="EU evenings, weekends" /></label>
              <label className="block"><span className={fieldLabel}>Language</span><input className={field} name="language" defaultValue={clan.language ?? ""} maxLength={RECRUITING_LIMITS.language} placeholder="English" /></label>
              <label className="block"><span className={fieldLabel}>Pitch</span><textarea className={`${field} py-3`} name="pitch" defaultValue={clan.pitch ?? ""} maxLength={RECRUITING_LIMITS.pitch} rows={3} /></label>
              <SubmitButton className={`${btnPrimary} self-start`}>Save</SubmitButton>
            </form>
          </PanelBody>
        </Panel>

        <Panel num="02" title="Guest passes" aside={guestPasses.length > 0 ? `${guestPasses.length} open` : undefined}>
          <PanelBody>
            <p id="guest-note" className="text-sm leading-relaxed text-ink-2">A pass shows the voice channel only, for {hours(GUEST_PASS_MS)}; joining the clan makes it the real role.</p>
            <form className="mt-3 flex flex-col gap-3" action="/api/clan/guest" method="post">
              <label className="block"><span className={fieldLabel}>Discord user id or gamertag</span><GamertagField scope="linked" {...invalid(err, "target")} className={invalid(err, "target").className ?? ""} name="target" defaultValue={kept.get("target")} placeholder="" required maxLength={GAMERTAG_MAX} aria-describedby={err?.field === "target" ? "err-target guest-note" : "guest-note"} /><FieldError err={err} name="target" /></label>
              <SubmitButton className={`${btnPrimary} self-start`}>Grant pass</SubmitButton>
            </form>
          </PanelBody>
          <GuestPassList passes={guestPasses} />
        </Panel>

        {leader && (
          <>
            <Panel num="03" title="Rename" aside={`once every ${days(RENAME_COOLDOWN_MS)}`}>
              <PanelBody>
                <RenameForm name={clan.name} tag={clan.tag} err={err} kept={{ name: kept.get("name"), tag: kept.get("tag") }} />
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
                    <SubmitButton className={`${btnDanger} self-start`} pending="Transferring…">Transfer</SubmitButton>
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
                      <span>raised by <span className="font-mono">{c.by}</span> {ago(c.raisedAt)}</span>
                      {/* M6: moving starts a cooldown and releases the old pole — two-press, the same weight as Release on /base. The pole key stays in a hidden field, never rendered. */}
                      <RowAction action="/api/clan/rebind" fields={{ poleKey: c.poleKey }} who={`(raised by ${c.by})`} style={btnPrimary} confirm="Press again to move">Move here</RowAction>
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
                  <SubmitButton className={`mt-3 ${btnDanger}`} pending="Disbanding…">Disband the clan</SubmitButton>
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
