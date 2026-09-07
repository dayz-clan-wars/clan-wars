import { NO_PROFILE } from "@/lib/stats-copy";

const label = "font-mono text-xs uppercase tracking-[0.18em] text-muted";

export default function PlayerNotFound() {
  return (
    <main className="mx-auto max-w-[34rem] px-4 py-10">
      <p className={label}>Player</p>
      <p className="mt-6 text-ink-2">{NO_PROFILE}</p>
      <p className="mt-8"><a className={`${label} underline-offset-4 hover:underline`} href="/players">Player boards</a></p>
    </main>
  );
}
