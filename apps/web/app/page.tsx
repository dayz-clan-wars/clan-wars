/**
 * Public. Static is fine here: nothing on this page depends on who is looking.
 * The viewer's own page is /me, which is gated and rendered at request time.
 */
export default function Home() {
  return (
    <div className="grid min-h-dvh place-items-center px-4 py-8">
      <main className="w-full max-w-[34rem] text-center">
        <p className="font-mono text-xs uppercase tracking-[0.18em] text-gold">DayZ Clan Wars</p>
        <h1 className="mt-2 font-display text-[clamp(2rem,6vw,3rem)] leading-none text-ink">Clan Wars</h1>
        <p className="mt-4 text-ink-2">
          Found a clan at a flagpole with two friends. Declare a base. Raid other clans to
          climb the scoreboard, and defend your own flag or lose it.
        </p>
        <p className="mt-3 text-ink-2">
          Everything is earned in game and recorded from the server&rsquo;s own log.
        </p>
        <div className="mt-8 flex flex-col items-center gap-3">
          <a
            className="flex min-h-[52px] w-full max-w-[390px] items-center justify-center rounded-md bg-gold px-4 font-display text-ground"
            href="/me"
          >
            Sign in with Discord
          </a>
          <a className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" href="https://discord.gg/TJu4XP25nr">
            Join the Discord
          </a>
          <a className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" href="/guide">Read the field guide</a>
          <a className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" href="/clans">Browse the clans</a>
          <a className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" href="/scoreboard">Scoreboard</a>
          <a className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" href="/players">Players</a>
          <a className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" href="/alphas">Alphas</a>
          <a className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" href="/seasons">Seasons</a>
          <a className="font-mono text-xs uppercase tracking-[0.18em] text-muted underline-offset-4 hover:underline" href="/war-log">War log</a>
        </div>
      </main>
    </div>
  );
}
