import type { Metadata } from "next";
import { viewerFor } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { LINK_TTL_MS } from "@factions/domain";
import { UNLINK_COPY } from "@/lib/link-copy";

export const metadata: Metadata = {
  title: "Clan Wars — you",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

export default async function MePage({ searchParams }: { searchParams: Promise<{ unlink?: string }> }) {
  const { unlink: unlinkCode } = await searchParams;
  const unlinkNotice = unlinkCode ? UNLINK_COPY[unlinkCode] : undefined;
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

  return (
    <main className="mx-auto max-w-[34rem] px-4 py-10">
      <p className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Signed in as</p>
      <h1 className="mt-1 font-display text-3xl text-ink">{session.name}</h1>

      {unlinkNotice && (
        <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{unlinkNotice}</p>
      )}

      <section className="mt-8 rounded-lg border border-rule bg-frame p-5">
        <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Your character</h2>
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
            Not linked yet. <a className="text-gold underline-offset-4 hover:underline" href="/link">Link your character</a> — three emotes in game, {LINK_TTL_MS / 60_000} minutes.
          </p>
        )}
      </section>

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className="font-mono text-xs uppercase tracking-[0.18em] text-muted">Your clan</h2>
        {viewer.clan ? (
          <p className="mt-2 text-ink">
            <span className="font-display">{viewer.clan.name}</span>{" "}
            <span className="font-mono text-ink-2">[{viewer.clan.tag}]</span> — {viewer.clan.role}
            {viewer.clan.status === "dormant" && <span className="ml-2 font-mono text-xs uppercase text-muted">dormant</span>}
            {viewer.clan.status === "reserved" && <span className="ml-2 font-mono text-xs uppercase text-muted">reserved</span>}
          </p>
        ) : (
          <p className="mt-2 text-ink-2">You are not in a clan.</p>
        )}
        {!viewer.clan && viewer.link && <a className="text-gold underline-offset-4 hover:underline" href="/base">Your solo base</a>}
      </section>

      <p className="mt-8 font-mono text-xs text-muted">
        Player tools land here over the coming increments. Nothing on this page is invented: it is what the server log has recorded.
      </p>
      {/* The logout route is POST-only (app/api/auth/logout/route.ts), so a form, not a link. */}
      <form className="mt-4" action="/api/auth/logout" method="post">
        <button className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" type="submit">Sign out</button>
      </form>
    </main>
  );
}
