import { viewerFor, myInvites, myRequests, claimContext, linkStatus, type Viewer, type MyInvite, type MyRequest, type ClaimContext } from "@factions/roster";
import type { Session } from "@/lib/auth/session";
import { nextStepFor, type NextStep } from "@/lib/next-step";
import { when, ago } from "@/lib/format";
import { Panel, PanelBody, Notice, btnCta, btnPrimary, btnSecondary, btnQuiet, kickerSm } from "./ui";
import { NextStepStrip } from "./next-step";

/**
 * What a signed-in member sees about themselves, wherever their page is:
 * on /me before a character is linked, and on their own public player page
 * once one is (lib/own-page.ts). One loader, so both pages read the same
 * state; the pieces are split so each page can place them in its own grid.
 *
 * ⚠️ Every page that renders these reads the viewer, so it must be
 * `force-dynamic` (test/request-time-rendering.test.ts pins that).
 */
export type Owner = {
  session: Session;
  viewer: Viewer;
  invites: MyInvite[];
  requests: MyRequest[];
  claim: ClaimContext | null;
  /** What to do next (App Review §01), or nothing for a full member. */
  next: NextStep | null;
  /** Invites are only actionable with no clan and no pending spot. */
  showInvites: boolean;
};

export async function loadOwner(session: Session, viewer?: Viewer): Promise<Owner> {
  viewer ??= await viewerFor(session.sub);
  const [invites, requests, claim, linkState] = await Promise.all([myInvites(session.sub), myRequests(session.sub), claimContext(session.sub), viewer.link ? null : linkStatus(session.sub)]);
  const showInvites = invites.length > 0 && viewer.clan === null && viewer.pending === null;
  const next = nextStepFor({
    linked: viewer.link !== null, challengeOpen: linkState?.challenge != null, inClan: viewer.clan !== null,
    pending: viewer.pending ? { name: viewer.pending.name } : null, ceremonyId: claim?.ceremony.id ?? null,
    invites: showInvites ? invites.map((i) => ({ id: i.id, clanName: i.clanName })) : [], requests: requests.map((r) => ({ clanName: r.clanName })),
  });
  return { session, viewer, invites, requests, claim, next, showInvites };
}

/** The notices an action route left in the query, then the next-step strip. Renders nothing when there is nothing to say. */
export function OwnerStrip({ owner, notices }: { owner: Owner; notices: (string | undefined)[] }) {
  const shown = notices.filter((n): n is string => n !== undefined);
  if (shown.length === 0 && !owner.next) return null;
  return (
    <div className="flex flex-col gap-3">
      {shown.map((n, i) => <Notice key={i}>{n}</Notice>)}
      {owner.next && <NextStepStrip step={owner.next} />}
    </div>
  );
}

/** The panels that only the owner sees: a ceremony waiting, open invites, open requests. */
export function OwnerPanels({ owner }: { owner: Owner }) {
  const { claim, invites, requests, showInvites, next } = owner;
  return (
    <>
      {claim && (
        <Panel title="A ceremony is waiting" tone={next ? "plain" : "gold"}>
          <PanelBody>
            <p className="text-base leading-relaxed text-ink">{claim.ceremony.participants.length} linked players raised the neutral flag together. Any one of you can found the clan until <span className="font-mono">{when(claim.ceremony.expiresAt)}</span>.</p>
            <a className={`mt-4 ${btnCta} min-h-[52px]`} href={`/claim/${claim.ceremony.id}`}>Found the clan <span className="font-mono normal-case">→</span></a>
          </PanelBody>
        </Panel>
      )}

      {showInvites && (
        <Panel title="Invites" aside={`${invites.length} open`}>
          <ul id="invites">
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
        <Panel title="Your requests" aside={`${requests.length} open`}>
          <ul>
            {requests.map((r) => (
              <li key={r.id} className="flex min-h-[64px] flex-wrap items-center gap-3.5 border-t border-rule-2 px-4 py-2 first:border-t-0 lg:px-5">
                <div className="min-w-0 flex-1">
                  <div className="font-display text-[15px] text-ink">{r.clanName} <span className="font-mono text-xs text-ink-2">[{r.tag}]</span></div>
                  <div className="font-mono text-xs text-muted">asked {ago(r.createdAt)} · expires {when(r.expiresAt)}</div>
                </div>
                <form action="/api/me/request/withdraw" method="post"><input type="hidden" name="requestId" value={r.id} /><button className={btnSecondary} type="submit">Withdraw</button></form>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}

/** A full-width cell link in a panel's foot: "Your clan page →". */
const cell = "flex min-h-[52px] items-center justify-between px-4 font-display text-[13px] uppercase tracking-[0.06em] text-ink hover:bg-surface lg:px-5";

/**
 * The owner's account, on their player page: who they are signed in as, and
 * the unlink control. Their clan is already in the hero; this is what the
 * public page cannot show. The foot links are the places a member goes.
 */
export function AccountPanel({ owner }: { owner: Owner }) {
  const { session, viewer } = owner;
  return (
    <Panel title="Your account" aside={<span className="text-olive">Linked</span>}>
      <PanelBody>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className={kickerSm}>Signed in as</span>
          <span className="font-display text-lg text-ink [overflow-wrap:anywhere] lg:text-[22px]">{session.name}</span>
        </div>
        {viewer.clan && <div className={`mt-2 ${kickerSm}`}>{viewer.clan.role} · {viewer.clan.status}</div>}
        <p className="mt-3 text-sm leading-relaxed text-ink-2">
          {viewer.clan
            ? "Unlinking is refused while you are in a clan — leave it first."
            : "Unlinking releases your solo base, if you have declared one."}
        </p>
        <form className="mt-3" action="/api/link/unlink" method="post">
          <button className={`${btnQuiet} ${viewer.clan ? "!text-dim" : ""}`} type="submit" disabled={viewer.clan !== null}>Unlink</button>
        </form>
      </PanelBody>
      {viewer.clan ? (
        <div className="grid grid-cols-2 border-t border-rule-2">
          <a className={`${cell} border-r border-rule-2`} href="/clan">Your clan page <span className="text-gold">→</span></a>
          <a className={cell} href="/map">The map <span className="text-gold">→</span></a>
        </div>
      ) : viewer.pending ? (
        <div className="grid grid-cols-2 border-t border-rule-2">
          <a className={`${cell} border-r border-rule-2`} href="/clan">The roster <span className="text-gold">→</span></a>
          <a className={cell} href="/map">The map <span className="text-gold">→</span></a>
        </div>
      ) : (
        <div className="grid grid-cols-3 border-t border-rule-2">
          <a className={`${cell} border-r border-rule-2`} href="/base">Solo base <span className="text-gold">→</span></a>
          <a className={`${cell} border-r border-rule-2`} href="/map">The map <span className="text-gold">→</span></a>
          <a className={cell} href="/clans">Browse the clans <span className="text-gold">→</span></a>
        </div>
      )}
    </Panel>
  );
}

/** The footer's sign-out. The logout route is POST-only (app/api/auth/logout/route.ts), so a form, not a link. */
export function SignOut() {
  return <form action="/api/auth/logout" method="post"><button className="flex min-h-[44px] items-center uppercase tracking-[0.18em] text-muted hover:text-ink" type="submit">Sign out</button></form>;
}
