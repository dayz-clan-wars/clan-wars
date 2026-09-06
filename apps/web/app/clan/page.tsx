import type { Metadata } from "next";
import { clanFor } from "@factions/roster";
import { ACTIVATION_WINDOW_MS, JOIN_PRESENCE_RADIUS_M, PENDING_EXPIRY_MS } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { GAMERTAG_MAX } from "@/lib/clan-limits";
import { when, days } from "@/lib/format";
import { flagImagePath } from "@/src/flag-images";

export const metadata: Metadata = { title: "Clan Wars — your clan", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";
const small = "min-h-[44px] rounded-md border border-rule px-3 font-display text-sm text-ink";
const danger = "min-h-[44px] rounded-md border border-rust px-3 font-display text-sm text-ink";

/** Hidden target + one button: the shape of every per-row action. */
function RowAction({ action, target, children, style = small }: { action: string; target: string; children: React.ReactNode; style?: string }) {
  return (
    <form action={`/api/clan/${action}`} method="post">
      <input type="hidden" name="target" value={target} />
      <button className={style} type="submit">{children}</button>
    </form>
  );
}

export default async function ClanPage({ searchParams }: { searchParams: Promise<{ result?: string }> }) {
  const { result } = await searchParams;
  const session = await currentSession();
  if (!session) {
    return <main className="mx-auto max-w-[40rem] px-4 py-10"><p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/clan">Sign in again</a>.</p></main>;
  }
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  const view = await clanFor(session.sub);

  if (view === "not-linked" || view === "not-in-clan") {
    return (
      <main className="mx-auto max-w-[40rem] px-4 py-10">
        <p className={label}>Your clan</p>
        {notice && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{notice}</p>}
        {view === "not-linked"
          ? <p className="mt-6 text-ink-2"><a className="text-gold underline-offset-4 hover:underline" href="/link">Link your character</a> first — a clan is joined by the character, not the Discord account.</p>
          : <p className="mt-6 text-ink-2">You are not in a clan. <a className="text-gold underline-offset-4 hover:underline" href="/clans">Browse the clans</a>, accept an invite on <a className="text-gold underline-offset-4 hover:underline" href="/me">your page</a>, or found one at a flagpole with two friends.</p>}
      </main>
    );
  }

  const { clan, me, roster, invitesOut, requestsIn } = view;
  const officer = me.status === "full" && (me.role === "officer" || me.role === "leader");
  const leader = me.status === "full" && me.role === "leader";
  const full = roster.filter((r) => r.status === "full");
  const pending = roster.filter((r) => r.status === "pending");

  return (
    <main className="mx-auto max-w-[40rem] px-4 py-10">
      <div className="flex items-center gap-4">
        <img src={`/${flagImagePath(clan.texture)}`} alt="" width={56} height={56} className="h-14 w-14 object-contain" />
        <div>
          <p className={label}>[{clan.tag}] · {clan.status} · you are {me.status === "pending" ? "pending" : me.role}</p>
          <h1 className="mt-1 font-display text-3xl text-ink">{clan.name}</h1>
        </div>
        {officer && <a className={`${label} ml-auto underline-offset-4 hover:underline`} href="/clan/settings">Settings</a>}
      </div>
      {notice && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{notice}</p>}

      {clan.status === "reserved" && (
        <p className="mt-6 rounded-md border border-gold bg-frame p-4 text-ink">Reserved. Raise your flag at the pole within {days(ACTIVATION_WINDOW_MS)} of the claim to activate the clan. Until then nobody else can take the name, tag, flag or pole.</p>
      )}
      {me.status === "pending" && (
        <p className="mt-6 rounded-md border border-gold bg-frame p-4 text-ink">You are pending. Stand within {JOIN_PRESENCE_RADIUS_M} m of the clan&rsquo;s base in game and the server log will make you a full member. Unseen for {days(PENDING_EXPIRY_MS)}, the spot expires.</p>
      )}

      <section className="mt-8 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Roster — {full.length} full{pending.length > 0 && `, ${pending.length} pending`}</h2>
        <ul className="mt-2 flex flex-col gap-2">
          {[...full, ...pending].map((r) => {
            const self = r.discordId === session.sub;
            return (
              <li key={r.dayzId} className="flex flex-wrap items-center gap-3 rounded-md border border-rule-2 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-ink">{r.gamertag ?? "unknown"}</span>
                  <span className="ml-2 font-mono text-xs uppercase text-muted">{r.status === "pending" ? "pending" : r.role}</span>
                  <div className="text-xs text-ink-2">joined {when(r.joinedAt)}{r.lastSeenAt && ` · seen ${when(r.lastSeenAt)}`}</div>
                </div>
                {!self && officer && r.status === "full" && r.role === "member" && <RowAction action="kick" target={r.discordId} style={danger}>Remove</RowAction>}
                {!self && officer && r.status === "pending" && <RowAction action="kick" target={r.discordId} style={danger}>Remove</RowAction>}
                {!self && leader && r.status === "full" && r.role === "member" && <RowAction action="promote" target={r.discordId}>Make officer</RowAction>}
                {!self && leader && r.status === "full" && r.role === "officer" && <RowAction action="demote" target={r.discordId}>Demote</RowAction>}
              </li>
            );
          })}
        </ul>
      </section>

      {officer && (
        <>
          <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Invite</h2>
            <form className="mt-2 flex gap-2" action="/api/clan/invite" method="post">
              <input className="min-w-0 flex-1 rounded-md border border-rule bg-ground px-3 py-2 font-mono text-ink" name="gamertag" placeholder="gamertag" required maxLength={GAMERTAG_MAX} autoComplete="off" />
              <button className="min-h-[44px] rounded-md bg-gold px-4 font-display text-ground" type="submit">Invite</button>
            </form>
            <p className="mt-2 text-xs text-ink-2">They must have linked their character on the site.</p>
            {invitesOut.length > 0 && (
              <ul className="mt-3 flex flex-col gap-1">
                {invitesOut.map((inv) => (
                  <li key={inv.id} className="flex items-center justify-between gap-3 text-sm text-ink">
                    <span><span className="font-mono">{inv.inviteeGamertag ?? "unknown"}</span> <span className="text-xs text-ink-2">expires {when(inv.expiresAt)}</span></span>
                    <form action="/api/clan/revoke-invite" method="post"><input type="hidden" name="inviteId" value={inv.id} /><button className={small} type="submit">Withdraw</button></form>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Requests to join — {requestsIn.length}</h2>
            {requestsIn.length === 0
              ? <p className="mt-2 text-sm text-ink-2">{clan.recruiting ? "None open." : "Turn recruiting on in settings to receive requests."}</p>
              : (
                <ul className="mt-2 flex flex-col gap-2">
                  {requestsIn.map((r) => (
                    <li key={r.id} className="flex flex-wrap items-center justify-between gap-3 text-sm text-ink">
                      <span><span className="font-mono">{r.gamertag ?? "unknown"}</span> <span className="text-xs text-ink-2">asked {when(r.createdAt)}</span></span>
                      <div className="flex gap-2">
                        <form action="/api/clan/decide-request" method="post"><input type="hidden" name="requestId" value={r.id} /><input type="hidden" name="decision" value="accepted" /><button className="min-h-[44px] rounded-md bg-gold px-3 font-display text-sm text-ground" type="submit">Accept</button></form>
                        <form action="/api/clan/decide-request" method="post"><input type="hidden" name="requestId" value={r.id} /><input type="hidden" name="decision" value="declined" /><button className={small} type="submit">Decline</button></form>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
          </section>
        </>
      )}

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Leave</h2>
        {leader
          ? <p className="mt-2 text-sm text-ink-2">A leader cannot leave. <a className="text-gold underline-offset-4 hover:underline" href="/clan/settings">Transfer leadership</a> first, or disband.</p>
          : (
            <form className="mt-2" action="/api/clan/leave" method="post">
              <label className="flex items-center gap-2 text-sm text-ink-2"><input type="checkbox" name="confirm" value="yes" className="h-5 w-5" /> I understand I cannot join a clan again for a while after leaving.</label>
              <button className={`${danger} mt-3`} type="submit">Leave the clan</button>
            </form>
          )}
      </section>
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/me">Your page</a></p>
    </main>
  );
}
