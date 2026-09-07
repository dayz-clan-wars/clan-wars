import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { playerProfile } from "@factions/roster";
import { parseSeasonParam } from "@/lib/stat-scope";
import { playTime, scopeLabel } from "@/lib/stats-copy";
import { ScopePicker } from "@/app/components/stat-boards";
import { when } from "@/lib/format";

export const metadata: Metadata = { title: "Clan Wars — player" };
/** ⚠️ Public, but LIVE: rendered per request so the build never bakes a roster into a static chunk (spec §10.1). */
export const dynamic = "force-dynamic";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";
/** Killed-by / killed lists are uncapped in the package; render at most this many, "and N more" for the rest. */
const LIST_LIMIT = 10;

function OpponentList({ items }: { items: { gamertag: string; count: number }[] }) {
  if (items.length === 0) return <p className="mt-2 text-sm text-ink-2">Nothing yet.</p>;
  const shown = items.slice(0, LIST_LIMIT);
  const rest = items.length - shown.length;
  return (
    <ul className="mt-2 flex flex-col gap-1">
      {shown.map((o) => (
        <li key={o.gamertag} className="flex justify-between text-sm text-ink">
          <a className="underline-offset-4 hover:underline" href={`/players/${encodeURIComponent(o.gamertag)}`}>{o.gamertag}</a>
          <span className="font-mono text-ink-2">{o.count}</span>
        </li>
      ))}
      {rest > 0 && <li className="text-xs text-ink-2">and {rest} more</li>}
    </ul>
  );
}

export default async function PlayerProfilePage({
  params, searchParams,
}: {
  params: Promise<{ gamertag: string }>;
  searchParams: Promise<{ season?: string | string[] }>;
}) {
  const { gamertag } = await params;
  const { season } = await searchParams;
  const parsed = parseSeasonParam(season);

  // ⚠️ Same two-step default as /players: a "default" parse needs the
  // roster's own `seasons` list before it can pick the open season.
  const profile = parsed === "default"
    ? await (async () => {
        const probe = await playerProfile(gamertag, { kind: "all" });
        if (!probe) return probe;
        return probe.seasons[0] !== undefined ? playerProfile(gamertag, { kind: "season", number: probe.seasons[0] }) : probe;
      })()
    : await playerProfile(gamertag, parsed);

  if (!profile) notFound();

  return (
    <main className="mx-auto max-w-[34rem] px-4 py-10">
      <p className={label}>Player</p>
      <div className="mt-1 flex items-center gap-3">
        <h1 className="font-display text-3xl text-ink">{profile.gamertag}</h1>
        {!profile.linked && <span className="font-mono text-xs uppercase text-muted">not linked</span>}
      </div>
      <ScopePicker seasons={profile.seasons} basePath={`/players/${encodeURIComponent(profile.gamertag)}`} />
      <p className="mt-4 text-sm text-ink-2">{scopeLabel(profile.scope)}</p>

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Activity</h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm text-ink-2">
          <dt className={label}>Play time</dt><dd>{playTime(profile.playTimeSeconds)}</dd>
          <dt className={label}>Sessions</dt><dd>{profile.sessions}</dd>
          <dt className={label}>Last seen</dt><dd>{profile.lastSeenAt ? when(profile.lastSeenAt) : "—"}</dd>
        </dl>
      </section>

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>PvP</h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm text-ink-2">
          <dt className={label}>Kills</dt><dd>{profile.pvpKills}</dd>
          <dt className={label}>Deaths</dt><dd>{profile.pvpDeaths}</dd>
          <dt className={label}>K/D</dt><dd>{profile.kd ?? "—"}</dd>
        </dl>
      </section>

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Killed by</h2>
        <OpponentList items={profile.killedBy} />
      </section>

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Killed</h2>
        <OpponentList items={profile.killed} />
      </section>

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Friendly fire</h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm text-ink-2">
          <dt className={label}>Kills</dt><dd>{profile.friendlyFireKills}</dd>
          <dt className={label}>Deaths</dt><dd>{profile.friendlyFireDeaths}</dd>
        </dl>
      </section>

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Raiding</h2>
        <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 text-sm text-ink-2">
          <dt className={label}>Raid credits</dt><dd>{profile.raidCredits}</dd>
          <dt className={label}>Upkeep raises</dt><dd>{profile.upkeepRaises}</dd>
        </dl>
      </section>

      <section className="mt-4 rounded-lg border border-rule bg-frame p-5">
        <h2 className={label}>Clan history</h2>
        {profile.clanHistory.length === 0 ? (
          <p className="mt-2 text-sm text-ink-2">Nothing yet.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1">
            {profile.clanHistory.map((c, i) => (
              <li key={`${c.tag}-${i}`} className="text-sm text-ink">
                <span className="font-mono text-ink-2">[{c.tag}]</span> {c.name} · joined {when(c.joinedAt)} · {c.leftAt ? `left ${when(c.leftAt)}` : "still a member"}
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/players">Player boards</a></p>
    </main>
  );
}
