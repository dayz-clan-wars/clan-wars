import type { Metadata } from "next";
import { clanFor } from "@factions/roster";
import { CLAN_NAME_LENGTH, CLAN_TAG_LENGTH, REBIND_CONFIRM_MS, REBIND_COOLDOWN_MS, RELEASED_POLE_GRACE_MS, RENAME_COOLDOWN_MS } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { RECRUITING_LIMITS } from "@/lib/clan-limits";
import { when, days } from "@/lib/format";

export const metadata: Metadata = { title: "Clan Wars — clan settings", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";
const field = "mt-1 w-full rounded-md border border-rule bg-ground px-3 py-2 font-mono text-ink";
const hours = (ms: number) => `${Math.round(ms / 3_600_000)} h`;

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const { result } = await searchParams;
  const session = await currentSession();
  if (!session) {
    return <main className="mx-auto max-w-[34rem] px-4 py-10"><p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/clan/settings">Sign in again</a>.</p></main>;
  }
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  const view = await clanFor(session.sub);
  const officer = typeof view !== "string" && view.me.status === "full" && (view.me.role === "officer" || view.me.role === "leader");
  if (typeof view === "string" || !officer) {
    return (
      <main className="mx-auto max-w-[34rem] px-4 py-10">
        <p className={label}>Clan settings</p>
        {notice && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{notice}</p>}
        <p className="mt-6 text-ink-2">Settings are for a clan&rsquo;s officers and leader. <a className="text-gold underline-offset-4 hover:underline" href="/clan">Your clan</a>.</p>
      </main>
    );
  }
  const { clan, me, roster, rebindCandidates } = view;
  const leader = me.role === "leader";
  const others = roster.filter((r) => r.status === "full" && r.discordId !== session.sub);

  return (
    <main className="mx-auto max-w-[34rem] px-4 py-10">
      <p className={label}>Clan settings</p>
      <h1 className="mt-1 font-display text-3xl text-ink">{clan.name} <span className="font-mono text-xl text-ink-2">[{clan.tag}]</span></h1>
      {notice && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{notice}</p>}

      <section className="mt-8 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Recruiting post</h2>
        <form className="mt-2 flex flex-col gap-3" action="/api/clan/recruiting" method="post">
          <label className="flex items-center gap-2 text-ink"><input type="checkbox" name="recruiting" value="yes" defaultChecked={clan.recruiting} className="h-5 w-5" /> Recruiting — listed first on the clans page; players can ask to join</label>
          <label className="block"><span className={label}>When you play</span><input className={field} name="playWindow" defaultValue={clan.playWindow ?? ""} maxLength={RECRUITING_LIMITS.playWindow} placeholder="EU evenings, weekends" /></label>
          <label className="block"><span className={label}>Language</span><input className={field} name="language" defaultValue={clan.language ?? ""} maxLength={RECRUITING_LIMITS.language} placeholder="English" /></label>
          <label className="block"><span className={label}>Pitch</span><textarea className={field} name="pitch" defaultValue={clan.pitch ?? ""} maxLength={RECRUITING_LIMITS.pitch} rows={3} /></label>
          <button className="min-h-[44px] self-start rounded-md bg-gold px-4 font-display text-ground" type="submit">Save</button>
        </form>
      </section>

      {leader && (
        <>
          <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Rename — once every {days(RENAME_COOLDOWN_MS)}</h2>
            <form className="mt-2 flex flex-col gap-3" action="/api/clan/rename" method="post">
              <label className="block"><span className={label}>Name</span><input className={field} name="name" defaultValue={clan.name} required minLength={CLAN_NAME_LENGTH.min} maxLength={CLAN_NAME_LENGTH.max} /></label>
              <label className="block"><span className={label}>Tag</span><input className={`${field} uppercase`} name="tag" defaultValue={clan.tag} minLength={CLAN_TAG_LENGTH.min} maxLength={CLAN_TAG_LENGTH.max} pattern="[A-Za-z0-9]+" /></label>
              <p className="text-xs text-ink-2">The old name and tag stay held — nobody else can take them.</p>
              <button className="min-h-[44px] self-start rounded-md border border-rule px-4 font-display text-ink" type="submit">Rename</button>
            </form>
          </section>

          <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Transfer leadership</h2>
            {others.length === 0 ? <p className="mt-2 text-sm text-ink-2">No other full member to hand over to.</p> : (
              <form className="mt-2 flex flex-col gap-3" action="/api/clan/transfer" method="post">
                <label className="block"><span className={label}>To</span>
                  <select className={field} name="target" required>
                    {others.map((r) => <option key={r.discordId} value={r.discordId}>{r.gamertag ?? "unknown"} — {r.role}</option>)}
                  </select>
                </label>
                <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" className="h-5 w-5" /> I understand I become an officer and they lead.</label>
                <button className="min-h-[44px] self-start rounded-md border border-rust px-4 font-display text-ink" type="submit">Transfer</button>
              </form>
            )}
          </section>

          <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Move the base</h2>
            <p className="mt-2 text-sm text-ink-2">When a member raises your flag at another pole, it appears here for {hours(REBIND_CONFIRM_MS)}. Confirming moves the base; the old pole goes public after {days(RELEASED_POLE_GRACE_MS)}. One move per {days(REBIND_COOLDOWN_MS)}.</p>
            {rebindCandidates.length === 0 ? <p className="mt-2 text-sm text-ink-2">No recent raise elsewhere.</p> : (
              <ul className="mt-2 flex flex-col gap-2">
                {rebindCandidates.map((c) => (
                  <li key={c.poleKey} className="flex items-center justify-between gap-3 rounded-md border border-rule-2 px-4 py-2 text-sm text-ink">
                    <span>raised by <span className="font-mono">{c.by}</span> {when(c.raisedAt)}</span>
                    <form action="/api/clan/rebind" method="post"><input type="hidden" name="poleKey" value={c.poleKey} /><button className="min-h-[44px] rounded-md bg-gold px-3 font-display text-sm text-ground" type="submit">Move here</button></form>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-4 rounded-lg border border-rust bg-frame p-5">
            <h2 className={label}>Disband</h2>
            <p className="mt-2 text-sm text-ink-2">Irreversible. The flag and the pole return to the pool for anyone to claim; the name and tag are held so nobody can impersonate you. Every member is out, with no cooldown.</p>
            <form className="mt-3" action="/api/clan/disband" method="post">
              <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" className="h-5 w-5" /> Disband {clan.name}.</label>
              <button className="mt-3 min-h-[44px] rounded-md border border-rust px-4 font-display text-ink" type="submit">Disband the clan</button>
            </form>
          </section>
        </>
      )}
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/clan">Your clan</a></p>
    </main>
  );
}
