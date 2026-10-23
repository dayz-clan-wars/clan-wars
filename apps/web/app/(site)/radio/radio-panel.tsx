import type { BunkerCard } from "@/lib/radio/tally";
import { btnPrimary, btnQuiet, btnSecondary } from "@/app/components/ui";
import { BunkerCardView } from "./bunker-card";

export type RadioState = "idle" | "starting" | "listening" | "denied" | "no-device" | "unsupported";

const PROBLEM: Partial<Record<RadioState, string>> = {
  denied: "Your browser blocked the microphone. Allow it for this site in your browser settings, then press Listen again.",
  "no-device": "No microphone found. Plug one in or use a phone, then press Listen again.",
  unsupported: "This browser can't listen. Try Chrome or Safari on a phone.",
};

/** Everything the page shows, from plain values: radio-view.tsx owns the microphone and feeds this. */
export function RadioPanel({ state, level, toneOn, locked, current, cards, onListen, onStop, onClear }: {
  state: RadioState; level: number; toneOn: boolean; locked: boolean; current: string; cards: BunkerCard[];
  onListen(): void; onStop(): void; onClear(): void;
}) {
  const listening = state === "listening";
  const problem = PROBLEM[state];
  const unsettled = cards.length < 3 || cards.some((c) => !c.settled);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        {problem
          ? <p className="text-ink-2" role="alert">{problem}</p>
          : !listening && (
            <>
              <p className="text-ink-2">Stand by the radio in game, press Listen, and hold your phone or laptop near the speaker. The codes fill in as the beeps come in.</p>
              <p className="text-sm text-muted">The sound never leaves your device.</p>
            </>
          )}
        {listening && <p className="text-ink-2" aria-live="polite">{locked ? "Hearing the radio." : "Listening for the beeps…"}</p>}
        <div className="flex flex-wrap items-center gap-3">
          {listening
            ? <>
              <button type="button" className={btnSecondary} onClick={onStop}>Stop</button>
              <button type="button" className={btnQuiet} onClick={onClear}>Clear</button>
            </>
            : state !== "unsupported" && <button type="button" className={btnPrimary} onClick={onListen} disabled={state === "starting"}>Listen</button>}
        </div>
        {listening && (
          <div className="flex items-center gap-3" aria-hidden="true">
            <div className="h-2 w-40 bg-rule-2"><div className="h-2 bg-ink-2" style={{ width: `${Math.round(level * 100)}%` }} /></div>
            <div className={`h-3 w-3 rounded-full ${toneOn ? "bg-gold" : "bg-rule-3"}`} />
            {current && <div className="font-mono text-sm tracking-[0.12em] text-muted">{current}</div>}
          </div>
        )}
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        {([1, 2, 3] as const).map((n) => <BunkerCardView key={n} n={n} card={cards[n - 1] ?? null} />)}
      </div>
      {listening && unsettled && <p className="text-sm text-muted">Keep listening. Each code is settled once it&apos;s been heard twice the same way.</p>}
    </div>
  );
}
