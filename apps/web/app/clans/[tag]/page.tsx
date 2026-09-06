import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { clanByTag, type ClanPage } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { when } from "@/lib/format";
import { flagImagePath } from "@/src/flag-images";

export const metadata: Metadata = { title: "Clan Wars — clan" };
/** ⚠️ Public but viewer-aware (canRequest), so per request. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";
const REQUEST_HINT: Record<Exclude<ClanPage["canRequest"], "yes">, string> = {
  "not-linked": "Sign in and link your character to ask to join.",
  "in-clan": "You are already in a clan.",
  "not-recruiting": "This clan is not recruiting.",
  cooldown: "You left or were removed from a clan recently — you can ask again once your cooldown ends.",
  cap: "This clan is full.",
  "already-requested": "You have a request open with this clan. Withdraw it from your page.",
};

export default async function ClanPage({ params, searchParams }: { params: Promise<{ tag: string }>; searchParams: Promise<{ result?: string }> }) {
  const { tag } = await params;
  const { result } = await searchParams;
  // ⚠️ Anonymous is fine here: /clans/ is public. The session only decides canRequest.
  const session = await currentSession();
  const clan = await clanByTag(tag, session?.sub ?? null);
  if (!clan) notFound();
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  const back = `/clans/${encodeURIComponent(clan.tag)}`;

  return (
    <main className="mx-auto max-w-[34rem] px-4 py-10">
      <div className="flex items-center gap-4">
        <img src={`/${flagImagePath(clan.texture)}`} alt="" width={64} height={64} className="h-16 w-16 object-contain" />
        <div>
          <p className={label}>[{clan.tag}] · {clan.status}</p>
          <h1 className="mt-1 font-display text-3xl text-ink">{clan.name}</h1>
          <p className="mt-1 text-sm text-ink-2">Founded {when(clan.createdAt)} · {clan.memberCount} members</p>
        </div>
      </div>
      {notice && <p role="status" className="mt-6 rounded-md border border-rule-2 bg-surface p-3 text-sm text-ink">{notice}</p>}

      {clan.recruiting && (
        <section className="mt-8 rounded-lg border border-gold bg-frame p-5">
          <h2 className={label}>Recruiting</h2>
          <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm text-ink-2">
            {clan.playWindow && <><dt className={label}>Plays</dt><dd>{clan.playWindow}</dd></>}
            {clan.language && <><dt className={label}>Speaks</dt><dd>{clan.language}</dd></>}
            {clan.pitch && <><dt className={label}>Pitch</dt><dd className="text-ink">{clan.pitch}</dd></>}
          </dl>
        </section>
      )}

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Roster</h2>
        <ul className="mt-2 flex flex-col gap-1">
          {clan.roster.map((r, i) => (
            <li key={`${r.gamertag ?? "?"}-${i}`} className="flex justify-between text-ink">
              <span className="font-mono">{r.gamertag ?? "unknown"}</span>
              <span className="font-mono text-xs uppercase text-muted">{r.role}</span>
            </li>
          ))}
        </ul>
      </section>

      <section className="mt-4">
        {clan.canRequest === "yes" ? (
          <form action={`/api/clans/${encodeURIComponent(clan.tag)}/request`} method="post">
            <button className="min-h-[52px] w-full rounded-md bg-gold px-4 font-display text-ground" type="submit">Request to join</button>
          </form>
        ) : (
          <p className="text-sm text-ink-2">{REQUEST_HINT[clan.canRequest]}{clan.canRequest === "not-linked" && <> <a className="text-gold underline-offset-4 hover:underline" href={`/login?next=${encodeURIComponent(back)}`}>Sign in</a>.</>}</p>
        )}
      </section>
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/clans">All clans</a></p>
    </main>
  );
}
