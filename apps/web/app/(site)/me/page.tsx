import type { Metadata } from "next";
import { viewerFor, myInvites, myRequests, claimContext } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { LINK_TTL_MS, LINK_EMOTES, JOIN_PRESENCE_RADIUS_M, PENDING_EXPIRY_MS } from "@factions/domain";
import { UNLINK_COPY } from "@/lib/link-copy";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { when, days } from "@/lib/format";

export const metadata: Metadata = {
  title: "Clan Wars — you",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";

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
    return (
      <main className="mx-auto max-w-[34rem] px-4 py-10">
        <p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/me">Sign in again</a>.</p>
      </main>
    );
  }
  const viewer = await viewerFor(session.sub);
  const [invites, requests, claim] = await Promise.all([myInvites(session.sub), myRequests(session.sub), claimContext(session.sub)]);

  return (
    <main className="mx-auto max-w-[34rem] px-4 py-10">
      <p className={label}>Signed in as</p>
      <h1 className="mt-1 font-display text-3xl text-ink">{session.name}</h1>

      {unlinkNotice && (
        <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{unlinkNotice}</p>
      )}
      {resultNotice && (
        <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{resultNotice}</p>
      )}

      <section className="mt-8 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Your character</h2>
        {viewer.link ? (
          <>
            <p className="mt-2 text-ink">Linked to <span className="font-mono">{viewer.link.gamertag}</span></p>
            <p className="mt-3 text-sm text-ink-2">
              {viewer.clan
                ? "Unlinking is refused while you are in a clan — leave it first."
                : "Unlinking releases your solo base, if you have declared one."}
            </p>
            <form className="mt-3" action="/api/link/unlink" method="post">
              <button className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" type="submit" disabled={viewer.clan !== null}>Unlink</button>
            </form>
          </>
        ) : (
          <p className="mt-2 text-ink-2">
            Not linked yet. <a className="text-gold underline-offset-4 hover:underline" href="/link">Link your character</a> — {LINK_EMOTES} emotes in game, {LINK_TTL_MS / 60_000} minutes.
          </p>
        )}
      </section>

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Your clan</h2>
        {viewer.clan ? (
          <>
            <p className="mt-2 text-ink">
              <a href="/clan"><span className="font-display">{viewer.clan.name}</span></a>{" "}
              <span className="font-mono text-ink-2">[{viewer.clan.tag}]</span> — {viewer.clan.role}
              {viewer.clan.status === "dormant" && <span className="ml-2 font-mono text-xs uppercase text-muted">dormant</span>}
              {viewer.clan.status === "reserved" && <span className="ml-2 font-mono text-xs uppercase text-muted">reserved</span>}
            </p>
            <div className="mt-2 flex flex-wrap gap-3">
              <a className="text-gold underline-offset-4 hover:underline" href="/clan">Your clan page</a>
              <a className="text-gold underline-offset-4 hover:underline" href="/map">The map</a>
            </div>
          </>
        ) : viewer.pending ? (
          <>
            <p className="mt-2 text-ink">Pending in <span className="font-display">{viewer.pending.name}</span> <span className="font-mono text-ink-2">[{viewer.pending.tag}]</span></p>
            <p className="mt-2 text-sm text-ink-2">Stand within {JOIN_PRESENCE_RADIUS_M} m of the clan&rsquo;s base in game and the server log will make you a full member. Unseen for {days(PENDING_EXPIRY_MS)}, the spot expires. Until then your solo base, if you have one, is still yours.</p>
            <div className="mt-2 flex flex-wrap gap-3">
              <a className="text-gold underline-offset-4 hover:underline" href="/clan">The roster you are joining</a>
              <a className="text-gold underline-offset-4 hover:underline" href="/map">The map</a>
            </div>
          </>
        ) : (
          <>
            <p className="mt-2 text-ink-2">You are not in a clan.</p>
            <div className="mt-2 flex flex-wrap gap-3">
              {viewer.link && <a className="text-gold underline-offset-4 hover:underline" href="/base">Your solo base</a>}
              {viewer.link && <a className="text-gold underline-offset-4 hover:underline" href="/map">The map</a>}
              <a className="text-gold underline-offset-4 hover:underline" href="/clans">Browse the clans</a>
            </div>
          </>
        )}
      </section>

      {claim && (
        <section className="mt-4 rounded-lg border border-gold bg-frame p-5">
          <h2 className={label}>A ceremony is waiting</h2>
          <p className="mt-2 text-ink">{claim.ceremony.participants.length} linked players raised the neutral flag together. Any one of you can found the clan until {when(claim.ceremony.expiresAt)}.</p>
          <a className="mt-3 inline-flex min-h-[44px] items-center rounded-md bg-gold px-4 font-display text-ground" href={`/claim/${claim.ceremony.id}`}>Found the clan</a>
        </section>
      )}

      {invites.length > 0 && viewer.clan === null && viewer.pending === null && (
        <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
          <h2 className={label}>Invites</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {invites.map((inv) => (
              <li key={inv.id} className="flex min-h-[56px] flex-wrap items-center justify-between gap-3 rounded-md border border-rule-2 px-4 py-2">
                <div>
                  <span className="font-display text-ink">{inv.clanName}</span> <span className="font-mono text-ink-2">[{inv.tag}]</span>
                  <div className="text-xs text-ink-2">expires {when(inv.expiresAt)}</div>
                </div>
                <div className="flex gap-2">
                  <form action="/api/me/invite/accept" method="post"><input type="hidden" name="inviteId" value={inv.id} /><button className="min-h-[44px] rounded-md bg-gold px-4 font-display text-ground" type="submit">Accept</button></form>
                  <form action="/api/me/invite/decline" method="post"><input type="hidden" name="inviteId" value={inv.id} /><button className="min-h-[44px] rounded-md border border-rule px-4 font-display text-ink" type="submit">Decline</button></form>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {requests.length > 0 && (
        <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
          <h2 className={label}>Your requests</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {requests.map((r) => (
              <li key={r.id} className="flex min-h-[56px] flex-wrap items-center justify-between gap-3 rounded-md border border-rule-2 px-4 py-2">
                <div>
                  <span className="font-display text-ink">{r.clanName}</span> <span className="font-mono text-ink-2">[{r.tag}]</span>
                  <div className="text-xs text-ink-2">Asked {when(r.createdAt)} · expires {when(r.expiresAt)}</div>
                </div>
                <form action="/api/me/request/withdraw" method="post"><input type="hidden" name="requestId" value={r.id} /><button className="min-h-[44px] rounded-md border border-rule px-4 font-display text-ink" type="submit">Withdraw</button></form>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="mt-8 font-mono text-xs text-muted">Nothing on this page is invented: it is what the server log has recorded.</p>
      {/* The logout route is POST-only (app/api/auth/logout/route.ts), so a form, not a link. */}
      <form className="mt-4" action="/api/auth/logout" method="post">
        <button className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" type="submit">Sign out</button>
      </form>
    </main>
  );
}
