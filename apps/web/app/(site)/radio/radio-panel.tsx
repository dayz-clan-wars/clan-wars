import { useEffect, useRef } from "react";
import type { BunkerCard } from "@/lib/radio/tally";
import { btnPrimary, btnQuiet, btnSecondary, kicker } from "@/app/components/ui";
import { BunkerCardView } from "./bunker-card";

export type RadioState = "idle" | "starting" | "listening" | "tapping" | "denied" | "no-device" | "busy" | "unsupported";

// ⚠️ Every microphone problem offers Tap along: it is the way in that needs no microphone.
const PROBLEM: Partial<Record<RadioState, string>> = {
  denied: "Your browser blocked the microphone. Allow it for this site in your browser settings and press Listen again, or tap along instead.",
  "no-device": "No microphone found. Plug one in and press Listen again, or tap along instead.",
  busy: "Another app is using the microphone. Close it or leave its call and press Listen again, or tap along instead.",
  unsupported: "This browser can't listen. Tap along instead, or try Chrome or Safari on a phone.",
};

export type RadioPanelProps = {
  state: RadioState; level: number; toneOn: boolean; locked: boolean; current: string; symbols: string;
  pressed: boolean; cards: BunkerCard[];
  /** The cards came back from this device, and nothing is being heard right now. */
  restored: boolean;
  /** Start over just wiped the cards; Undo puts them back. */
  undoable: boolean;
  onListen(): void; onTap(): void; onStop(): void; onClear(): void; onUndo(): void; onPress(): void; onRelease(): void;
};

/** Everything the page shows, from plain values: radio-view.tsx owns the microphone, the tap key and the saved reads. */
export function RadioPanel(p: RadioPanelProps) {
  const { state, cards } = p;
  const active = state === "listening" || state === "tapping";
  const problem = PROBLEM[state];
  const heardAny = cards.length > 0;
  const allSettled = cards.length === 3 && cards.every((c) => c.settled);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3">
        {problem && <p className="text-ink-2" role="alert">{problem}</p>}
        {!problem && !active && (
          <>
            <p className="text-ink-2">Stand by the radio in game. Press Listen and hold your phone or laptop near the speaker, or tap along to the beeps yourself. The codes fill in as the beeps come in.</p>
            <p className="text-sm text-muted">The sound never leaves your device.</p>
          </>
        )}
        {p.restored && heardAny && <p className="text-sm text-ink-2">These are the codes from your last listen, kept on this device for 2 hours. Listen again to settle the rest.</p>}
        {state === "listening" && <p className="text-ink-2" aria-live="polite">{p.locked ? "Hearing the radio." : "Listening for the beeps…"}</p>}
        {state === "tapping" && <p className="text-ink-2">Wait for the long pause, then tap with every beep: a quick tap for a short beep, hold for a long one. The space bar works too.</p>}

        <div className="flex flex-wrap items-center gap-3">
          {active
            ? <>
              <button type="button" className={btnSecondary} onClick={p.onStop}>Stop</button>
              {heardAny && <button type="button" className={btnQuiet} onClick={p.onClear}>Start over</button>}
            </>
            : <>
              {state !== "unsupported" && <button type="button" className={btnPrimary} onClick={p.onListen} disabled={state === "starting"}>Listen</button>}
              <button type="button" className={btnSecondary} onClick={p.onTap} disabled={state === "starting"}>Tap along</button>
              {heardAny && <button type="button" className={btnQuiet} onClick={p.onClear}>Start over</button>}
            </>}
          {p.undoable && (
            <p className="flex items-center gap-3 text-sm text-ink-2" role="status">
              Codes cleared.
              <button type="button" className={btnQuiet} onClick={p.onUndo}>Undo</button>
            </p>
          )}
        </div>

        {state === "listening" && <Meter level={p.level} toneOn={p.toneOn} current={p.current} />}
        {state === "tapping" && <TapPad pressed={p.pressed} symbols={p.symbols} current={p.current} onPress={p.onPress} onRelease={p.onRelease} />}
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        {([1, 2, 3] as const).map((n) => <BunkerCardView key={n} n={n} card={cards[n - 1] ?? null} />)}
      </div>
      {(active || heardAny) && !allSettled && (
        <p className="text-sm text-muted">Each code settles once it&apos;s been heard twice the same way. The broadcast comes round again about every 4½ minutes.</p>
      )}
    </div>
  );
}

/** The level and the tone light, each with a word beside it: a grey-or-gold dot alone says nothing to some eyes. */
function Meter({ level, toneOn, current }: { level: number; toneOn: boolean; current: string }) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2" aria-hidden="true">
      <div className="flex items-center gap-2">
        <span className={kicker}>Level</span>
        <div className="h-2 w-32 bg-rule-2"><div className="h-2 bg-ink-2" style={{ width: `${Math.round(level * 100)}%` }} /></div>
      </div>
      <div className="flex items-center gap-2">
        <div className={`h-3 w-3 rounded-full ${toneOn ? "bg-gold" : "bg-rule-3"}`} />
        <span className={toneOn ? kicker.replace("text-muted", "text-gold") : kicker}>{toneOn ? "Beep" : "Quiet"}</span>
      </div>
      {current && <div className="font-mono text-sm tracking-[0.12em] text-muted">{current}</div>}
    </div>
  );
}

const SYM = { ".": "·", "-": "–", "?": "?" } as const;

/**
 * The key. ⚠️ Pointer capture, not click: a click fires on release, so it
 * can't time a press, and a thumb that slides off the pad mid-dash must still
 * end the press here rather than leave it held.
 */
function TapPad({ pressed, symbols, current, onPress, onRelease }: { pressed: boolean; symbols: string; current: string; onPress(): void; onRelease(): void }) {
  const pad = useRef<HTMLButtonElement>(null);
  // Focus lands on the pad as tapping starts, so the space bar works without a click first.
  useEffect(() => pad.current?.focus(), []);
  // Groups of five from the group's start, one digit each, so the player sees
  // a digit come together; the last three digits' worth, so it never wraps.
  const begin = Math.max(0, Math.floor(Math.max(symbols.length - 1, 0) / 5) * 5 - 10);
  const chunks = symbols.slice(begin).match(/.{1,5}/g) ?? [];
  return (
    <div className="flex flex-col gap-3">
      <button
        ref={pad}
        type="button"
        aria-label="Tap key: press with each beep, hold for a long one"
        aria-pressed={pressed}
        className={`flex h-44 w-full touch-none select-none flex-col items-center justify-center gap-1 border-2 font-display uppercase tracking-[0.06em] [-webkit-touch-callout:none] md:max-w-md ${pressed ? "border-gold bg-gold text-ground" : "border-rule-3 text-ink hover:border-muted"}`}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          onPress();
        }}
        onPointerUp={onRelease}
        onPointerCancel={onRelease}
        onLostPointerCapture={onRelease}
        onBlur={onRelease}
        onContextMenu={(e) => e.preventDefault()}
        onKeyDown={(e) => {
          if (e.key !== " " && e.key !== "Enter") return;
          e.preventDefault();
          if (!e.repeat) onPress();
        }}
        onKeyUp={(e) => {
          if (e.key !== " " && e.key !== "Enter") return;
          e.preventDefault();
          onRelease();
        }}
      >
        <span className="text-lg">{pressed ? "Beep" : "Tap"}</span>
        <span className="font-mono text-[11px] normal-case tracking-[0.12em] opacity-70">hold for a long beep</span>
      </button>
      <div className="flex min-h-[28px] items-center gap-4 font-mono text-lg tracking-[0.2em] text-ink-2" aria-hidden="true">
        {chunks.length === 0 ? <span className="text-sm tracking-normal text-muted">Your taps show here.</span> : chunks.map((c, i) => <span key={i}>{[...c].map((s) => SYM[s as keyof typeof SYM]).join("")}</span>)}
        {current && <span className="text-sm text-muted">{current}</span>}
      </div>
    </div>
  );
}
