import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { clanByTag, type ClanPage } from "@factions/roster";
import { currentSession } from "@/lib/viewer";
import { RESULT_COPY } from "@/lib/clan-copy";
import { lookupCopy } from "@/lib/copy-lookup";
import { when, days } from "@/lib/format";
import { flagImagePath } from "@/src/flag-images";
import { ALPHA_BADGE, duration } from "@/lib/scoring-copy";
import { Page, PageHead, Panel, PanelBody, Notice, Facts, Stat, btnCta, link, kickerSm } from "@/app/components/ui";

export const metadata: Metadata = { title: "Clan Wars — clan" };
/** ⚠️ Public but viewer-aware (canRequest), so per request. See lib/viewer.ts. */
export const dynamic = "force-dynamic";

const REQUEST_HINT: Record<Exclude<ClanPage["canRequest"], "yes">, string> = {
  "not-linked": "Sign in and link your character to ask to join.",
  "in-clan": "You are already in a clan.",
  "not-recruiting": "This clan is not recruiting.",
  cooldown: "You left or were removed from a clan recently — you can ask again once your cooldown ends.",
  cap: "This clan is full.",
  "already-requested": "You have a request open with this clan. Withdraw it from your page.",
};

export default async function ClanDetailPage({ params, searchParams }: { params: Promise<{ tag: string }>; searchParams: Promise<{ result?: string }> }) {
  const { tag } = await params;
  const { result } = await searchParams;
  // ⚠️ Anonymous is fine here: /clans/ is public. The session only decides canRequest.
  const session = await currentSession();
  const clan = await clanByTag(tag, session?.sub ?? null);
  if (!clan) notFound();
  const notice = result ? lookupCopy(RESULT_COPY, result) : undefined;
  const back = `/clans/${encodeURIComponent(clan.tag)}`;

  const request = clan.canRequest === "yes" ? (
    <form action={`/api/clans/${encodeURIComponent(clan.tag)}/request`} method="post">
      <button className={`${btnCta} w-full lg:w-auto lg:justify-start`} type="submit">Request to join <span className="font-mono normal-case">→</span></button>
    </form>
  ) : (
    <p className="max-w-[28rem] text-sm leading-relaxed text-ink-2">{REQUEST_HINT[clan.canRequest]}{clan.canRequest === "not-linked" && <> <a className={link} href={`/login?next=${encodeURIComponent(back)}`}>Sign in</a>.</>}</p>
  );

  return (
    <Page wide>
      <PageHead
        icon={<img src={`/${flagImagePath(clan.texture)}`} alt="" width={96} height={96} className="h-16 w-16 flex-none object-contain lg:h-24 lg:w-24" />}
        kicker={<>[{clan.tag}] · {clan.status}{clan.alpha && <> · <span className="text-gold">{ALPHA_BADGE}</span></>}</>}
        title={clan.name}
        sub={<>Founded {when(clan.createdAt)} · {clan.memberCount} members</>}
        aside={request}
      />
      {notice && <div className="px-5 pt-5 lg:px-8 lg:pt-6"><Notice>{notice}</Notice></div>}

      <div className="grid gap-4 px-5 py-5 lg:grid-cols-3 lg:gap-6 lg:px-8 lg:pb-10 lg:pt-6">
        {clan.recruiting && (
          <Panel num="01" title="Recruiting" tone="gold">
            <PanelBody>
              <Facts items={[
                ...(clan.playWindow ? [["Plays", clan.playWindow] as [React.ReactNode, React.ReactNode]] : []),
                ...(clan.language ? [["Speaks", clan.language] as [React.ReactNode, React.ReactNode]] : []),
                ...(clan.pitch ? [["Pitch", <span key="p" className="text-ink">{clan.pitch}</span>] as [React.ReactNode, React.ReactNode]] : []),
              ]} />
            </PanelBody>
          </Panel>
        )}

        <Panel num={clan.recruiting ? "02" : "01"} title="This season">
          <div className="grid grid-cols-2">
            <div className="border-b border-r border-rule-2"><Stat value={clan.stats.raids} label="Raids" /></div>
            <div className="border-b border-rule-2"><Stat value={clan.stats.defenses} label="Defenses" /></div>
            <div className="border-r border-rule-2"><Stat value={clan.stats.longestSiegeSeconds !== null ? duration(clan.stats.longestSiegeSeconds) : "—"} label="Longest siege" /></div>
            <div><Stat value={clan.stats.daysHeld !== null ? days(clan.stats.daysHeld * 86_400_000) : "—"} label="Days held" /></div>
          </div>
        </Panel>

        <Panel num={clan.recruiting ? "03" : "02"} title="Placements" aside={`Alpha weeks: ${clan.alphaWeeks}`}>
          {clan.placements.length === 0 ? (
            <PanelBody className="!py-3"><p className="text-sm text-ink-2">No season finished yet.</p></PanelBody>
          ) : (
            <ul>
              {clan.placements.map((p) => (
                <li key={p.season} className="flex min-h-[48px] items-center justify-between border-t border-rule-2 px-4 font-mono text-sm first:border-t-0 lg:px-5">
                  <span className="text-ink">Season {p.season}</span>
                  <span className="text-ink-2"><span className={p.rank === 1 ? "text-gold" : ""}>#{p.rank}</span> · {p.points} pts</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel num={clan.recruiting ? "04" : "03"} title="Roster" className="lg:col-span-3">
          <ul className="grid lg:grid-cols-3">
            {clan.roster.map((r, i) => (
              <li key={`${r.gamertag ?? "?"}-${i}`} className="flex min-h-[48px] items-center justify-between border-t border-rule-2 px-4 lg:min-h-[52px] lg:border-r lg:px-5 lg:[&:nth-child(-n+3)]:border-t-0 lg:[&:nth-child(3n)]:border-r-0 first:border-t-0">
                {r.gamertag ? (
                  <a className="font-mono text-sm text-ink underline-offset-4 hover:underline" href={`/players/${encodeURIComponent(r.gamertag)}`}>{r.gamertag}</a>
                ) : (
                  <span className="font-mono text-sm text-ink">unknown</span>
                )}
                <span className={`${kickerSm} ${r.role === "leader" ? "!text-gold" : ""}`}>{r.role}</span>
              </li>
            ))}
          </ul>
        </Panel>
      </div>
    </Page>
  );
}
