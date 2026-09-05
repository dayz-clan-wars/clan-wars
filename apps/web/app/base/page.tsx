import type { Metadata } from "next";
import { baseFor } from "@factions/roster";
import { WATCH_ZONE_RADIUS_M } from "@factions/domain";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/base-copy";
import { lookupCopy } from "@/lib/copy-lookup";

export const metadata: Metadata = {
  title: "Clan Wars — your base",
  robots: { index: false, follow: false },
};

/** ⚠️ Rendered per request, after the middleware. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";
const when = (d: Date) => d.toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
/** Metres, whole. These are the viewer's own raises; nobody else's pole reaches this page. */
const at = (x: number, z: number) => `${Math.round(x)}, ${Math.round(z)}`;

export default async function BasePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const session = await currentSession();
  if (!session) {
    return (
      <main className="mx-auto max-w-[34rem] px-4 py-10">
        <p className="text-ink-2">Your session could not be read. <a className="text-gold underline-offset-4 hover:underline" href="/login?next=/base">Sign in again</a>.</p>
      </main>
    );
  }
  const params = await searchParams;
  // ⚠️ Looked up, never echoed: ?result= is attacker-supplied, including
  // prototype keys like `__proto__`, so the lookup must miss on those rather
  // than returning a value off Object.prototype.
  const result = typeof params.result === "string" ? lookupCopy(RESULT_COPY, params.result) : undefined;
  const view = await baseFor(session.sub);

  return (
    <main className="mx-auto max-w-[34rem] px-4 py-10">
      <p className={label}>Your base</p>
      <h1 className="mt-1 font-display text-3xl text-ink">Solo declaration</h1>
      {result && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{result}</p>}

      {!view.linked && (
        <p className="mt-6 text-ink-2"><a className="text-gold underline-offset-4 hover:underline" href="/link">Link your character</a> first — a base is declared by the character that raised the flag.</p>
      )}

      {view.linked && view.inClan && (
        <p className="mt-6 text-ink-2">You are in a clan, so your base is the clan&rsquo;s. Solo declarations are for players outside one.</p>
      )}

      {view.linked && !view.inClan && (
        <>
          <section className="mt-8 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Declared</h2>
            {view.declaration ? (
              <>
                <p className="mt-2 font-mono text-ink">{at(view.declaration.x, view.declaration.z)}</p>
                <p className="mt-1 text-sm text-ink-2">Declared {when(view.declaration.declaredAt)}. Your {WATCH_ZONE_RADIUS_M} m watch zone is live.</p>
                <form className="mt-4" action="/api/base/release" method="post">
                  <label className="flex items-center gap-2 text-sm text-ink-2">
                    <input type="checkbox" name="confirm" value="yes" className="h-5 w-5" /> I understand the pole goes public if nobody declares it within the grace period.
                  </label>
                  <button className="mt-3 min-h-[44px] rounded-md border border-rust px-4 font-display text-ink" type="submit">Release this base</button>
                </form>
              </>
            ) : (
              <p className="mt-2 text-ink-2">Nothing declared. Pick one of the poles below — only poles the server log has seen you raise a flag at can be declared.</p>
            )}
          </section>

          <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
            <h2 className={label}>Poles you have raised at</h2>
            {view.candidates.length === 0 ? (
              <p className="mt-2 text-ink-2">None yet. Raise your flag at your pole in game; the log reaches us within a few minutes.</p>
            ) : (
              <ul className="mt-2 flex flex-col gap-2">
                {view.candidates.map((c) => (
                  <li key={c.poleKey} className="flex min-h-[56px] items-center justify-between gap-3 rounded-md border border-rule-2 px-4">
                    <div>
                      <div className="font-mono text-ink">{at(c.x, c.z)}</div>
                      <div className="text-xs text-ink-2">raised {when(c.raisedAt)}</div>
                    </div>
                    <form action="/api/base/declare" method="post">
                      <input type="hidden" name="poleKey" value={c.poleKey} />
                      <button className="min-h-[44px] rounded-md bg-gold px-4 font-display text-ground disabled:opacity-40" type="submit" disabled={view.declaration !== null}>Declare</button>
                    </form>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
      <p className="mt-8"><a className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" href="/me">Your page</a></p>
    </main>
  );
}
