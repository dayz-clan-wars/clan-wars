import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { claimContext } from "@factions/roster";
import { ACTIVATION_WINDOW_MS, CLAN_NAME_LENGTH, CLAN_SIZE_CAP, CLAN_TAG_LENGTH, MIN_BASE_SPACING_M } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { when, days } from "@/lib/format";
import { flagImagePath } from "@/src/flag-images";

export const metadata: Metadata = { title: "Clan Wars — found your clan", robots: { index: false, follow: false } };
/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-[11px] uppercase tracking-[0.18em] text-muted";
const field = "mt-1 block min-h-[48px] w-full border-2 border-rule-2 bg-ground px-3 font-mono text-sm text-ink focus:border-gold focus:outline-none";

export default async function ClaimPage({ params, searchParams }: { params: Promise<{ ceremony: string }>; searchParams: Promise<{ result?: string }> }) {
  const { ceremony: raw } = await params;
  const { result } = await searchParams;
  const session = await currentSession();
  if (!session) {
    return <main className="mx-auto max-w-[64rem] px-5 py-7 lg:px-8 lg:py-10"><p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href={`/login?next=/claim/${encodeURIComponent(raw)}`}>Sign in again</a>.</p></main>;
  }
  // ⚠️ The package returns the VIEWER's open ceremony; the id in the URL must be that one, or it is not theirs to see.
  const ctx = await claimContext(session.sub);
  if (!ctx || String(ctx.ceremony.id) !== raw) notFound();
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  const me = ctx.ceremony.participants.find((p) => p.discordId === session.sub);

  return (
    <main className="mx-auto max-w-[64rem] px-5 py-7 lg:px-8 lg:py-10">
      <p className={label}>Found your clan</p>
      <h1 className="mt-2 font-display text-[40px] uppercase leading-[.9] tracking-[-0.02em] text-ink lg:text-[56px]">{ctx.ceremony.participants.length} of you raised the flag</h1>
      <p className="mt-2 text-sm text-ink-2">Witnessed {when(ctx.ceremony.detectedAt)}. Claim it before {when(ctx.ceremony.expiresAt)}. Whoever claims becomes leader.</p>
      {notice && <p role="status" className="mt-6 border border-rule-2 bg-surface px-4 py-3 text-sm text-ink">{notice}</p>}

      <form className="mt-8 flex flex-col gap-6" action="/api/claim" method="post">
        <input type="hidden" name="ceremonyId" value={ctx.ceremony.id} />
        <label className="block"><span className={label}>Name</span>
          <input className={field} name="name" required minLength={CLAN_NAME_LENGTH.min} maxLength={CLAN_NAME_LENGTH.max} autoComplete="off" />
        </label>
        <label className="block"><span className={label}>Tag — {CLAN_TAG_LENGTH.min} to {CLAN_TAG_LENGTH.max} letters or digits</span>
          <input className={`${field} uppercase`} name="tag" required minLength={CLAN_TAG_LENGTH.min} maxLength={CLAN_TAG_LENGTH.max} pattern="[A-Za-z0-9]+" autoComplete="off" />
        </label>

        <fieldset>
          <legend className={label}>Flag — {ctx.freeFlags.length} free</legend>
          <ul className="mt-2 grid grid-cols-4 gap-2 sm:grid-cols-6">
            {ctx.freeFlags.map((f) => (
              <li key={f}>
                <label className="flex cursor-pointer flex-col items-center gap-1 border-2 border-rule-2 p-2 has-[:checked]:border-gold">
                  <input type="radio" name="texture" value={f} required className="sr-only" />
                  <img src={`/${flagImagePath(f)}`} alt={f} width={48} height={48} className="h-12 w-12 object-contain" />
                  <span className="font-mono text-[10px] text-muted">{f.replace(/^Flag_/u, "")}</span>
                </label>
              </li>
            ))}
          </ul>
        </fieldset>

        <fieldset>
          <legend className={label}>Roster — untick anyone who should not be in</legend>
          <p className="mt-1 text-xs text-ink-2">Only people at the ceremony can be founding members. A clan holds at most {CLAN_SIZE_CAP}.</p>
          <ul className="mt-2 flex flex-col gap-1">
            {ctx.ceremony.participants.map((p) => (
              <li key={p.dayzId}>
                <label className="flex min-h-[44px] items-center gap-3 text-ink">
                  <input type="checkbox" name="member" value={p.dayzId} defaultChecked disabled={p.dayzId === me?.dayzId} className="h-5 w-5 accent-gold" />
                  <span className="font-mono">{p.gamertag}</span>
                  {p.dayzId === me?.dayzId && <span className="font-mono text-xs uppercase text-muted">you — leader</span>}
                </label>
              </li>
            ))}
          </ul>
          {/* A disabled checkbox does not post; the claimant must be on the roster, so carry them explicitly. */}
          {me && <input type="hidden" name="member" value={me.dayzId} />}
        </fieldset>

        <p className="text-sm text-ink-2">Claiming reserves the name, tag, flag and pole. Raise your flag at the pole within {days(ACTIVATION_WINDOW_MS)} to activate. No two bases sit within {MIN_BASE_SPACING_M} m of each other — if the pole is too close to one you cannot see, the claim is refused.</p>
        <button className="inline-flex min-h-[56px] items-center bg-gold px-5 font-display text-[15px] uppercase tracking-[0.04em] text-ground hover:bg-gold-hover" type="submit">Found the clan</button>
      </form>
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/me">Your page</a></p>
    </main>
  );
}
