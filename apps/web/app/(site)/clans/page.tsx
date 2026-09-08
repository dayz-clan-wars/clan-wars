import type { Metadata } from "next";
import { directory } from "@factions/roster";
import { FLAG_POOL_SIZE } from "@factions/domain";
import { flagImagePath } from "@/src/flag-images";
import { ALPHA_BADGE } from "@/lib/scoring-copy";

export const metadata: Metadata = { title: "Clan Wars — clans" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";

export default async function ClansPage() {
  const { clans, flags } = await directory();
  const recruiting = clans.filter((c) => c.recruiting);
  return (
    <main className="mx-auto max-w-[40rem] px-4 py-10">
      <p className={label}>Clans</p>
      <h1 className="mt-1 font-display text-3xl text-ink">{clans.length} on the server</h1>
      <p className="mt-2 text-sm text-ink-2">{flags.taken.length} of {FLAG_POOL_SIZE} flags flying. Recruiting clans first.</p>

      {recruiting.length > 0 && (
        <section className="mt-8">
          <h2 className={label}>Recruiting</h2>
          <ul className="mt-2 flex flex-col gap-2">
            {recruiting.map((c) => (
              <li key={c.tag} className="rounded-lg border border-rule bg-frame p-4">
                <a className="flex items-center gap-3" href={`/clans/${encodeURIComponent(c.tag)}`}>
                  <img src={`/${flagImagePath(c.texture)}`} alt="" width={40} height={40} className="h-10 w-10 object-contain" />
                  <span className="font-display text-lg text-ink">{c.name}</span>
                  <span className="font-mono text-ink-2">[{c.tag}]</span>
                  <span className="ml-auto font-mono text-xs text-muted">{c.memberCount} members</span>
                </a>
                <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm text-ink-2">
                  {c.playWindow && <><dt className={label}>Plays</dt><dd>{c.playWindow}</dd></>}
                  {c.language && <><dt className={label}>Speaks</dt><dd>{c.language}</dd></>}
                  {c.pitch && <><dt className={label}>Pitch</dt><dd>{c.pitch}</dd></>}
                </dl>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h2 className={label}>Every clan</h2>
        <ul className="mt-2 divide-y divide-rule-2 rounded-lg border border-rule bg-frame">
          {clans.map((c) => (
            <li key={c.tag}>
              <a className="flex min-h-[56px] items-center gap-3 px-4" href={`/clans/${encodeURIComponent(c.tag)}`}>
                <img src={`/${flagImagePath(c.texture)}`} alt="" width={32} height={32} className="h-8 w-8 object-contain" />
                <span className="font-display text-ink">{c.name}</span>
                <span className="font-mono text-sm text-ink-2">[{c.tag}]</span>
                {c.status === "dormant" && <span className="font-mono text-xs uppercase text-muted">dormant</span>}
                {c.alpha && <span className="font-mono text-xs uppercase text-gold">{ALPHA_BADGE}</span>}
                <span className="ml-auto font-mono text-xs text-muted">{c.memberCount}</span>
              </a>
            </li>
          ))}
          {clans.length === 0 && <li className="px-4 py-3 text-ink-2">No clan yet. Found one at a flagpole with two friends.</li>}
        </ul>
      </section>

      <section className="mt-8">
        <h2 className={label}>The flag pool</h2>
        <p className="mt-2 text-sm text-ink-2">{flags.free.length} free.</p>
        <ul className="mt-2 flex flex-wrap gap-2">
          {flags.free.map((f) => <li key={f}><img src={`/${flagImagePath(f)}`} alt={f} title={f} width={32} height={32} className="h-8 w-8 object-contain" /></li>)}
        </ul>
      </section>
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/me">Your page</a></p>
    </main>
  );
}
