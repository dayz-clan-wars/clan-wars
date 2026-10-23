"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startCapture } from "@/lib/radio/capture";
import { ToneDetector } from "@/lib/radio/detector";
import { readsOf, spellGroups, toDigits, type ToneRun } from "@/lib/radio/decode";
import { tally, type BunkerCard } from "@/lib/radio/tally";
import { RadioPanel, type RadioState } from "./radio-panel";

const REDRAW_MS = 100;

type View = { level: number; toneOn: boolean; locked: boolean; current: string; cards: BunkerCard[] };
const EMPTY: View = { level: 0, toneOn: false, locked: false, current: "", cards: [] };

/**
 * The microphone, the detector and the decoder, redrawn ten times a second.
 * Every pass re-reads everything heard so far: a few hundred runs, cheap,
 * and it means a late read can still fix an early digit. Nothing is stored
 * or sent; leaving the page drops it all.
 */
export default function RadioView() {
  const [state, setState] = useState<RadioState>("idle");
  const [view, setView] = useState<View>(EMPTY);
  const capture = useRef<{ stop(): void } | null>(null);
  const detector = useRef<ToneDetector | null>(null);
  const runs = useRef<ToneRun[]>([]);
  const heardMs = useRef(0);
  const rate = useRef(48_000);
  // ⚠️ Clear restarts the clock as well as the runs: the decoder treats a
  // group as heard from its start only if a group gap of silence came first,
  // measured from zero, so clearing mid-group must make that group a tail.
  const clearedAt = useRef(0);
  const wake = useRef<{ release(): Promise<void> } | null>(null);

  const stop = useCallback(() => {
    capture.current?.stop();
    capture.current = null;
    void wake.current?.release().catch(() => {});
    wake.current = null;
    setState((s) => (s === "listening" ? "idle" : s));
  }, []);

  useEffect(() => stop, [stop]);

  const listen = useCallback(async () => {
    setState("starting");
    // Blocks arriving before the new detector exists belong to no session.
    detector.current = null;
    try {
      const c = await startCapture((block) => {
        const d = detector.current;
        if (!d) return;
        heardMs.current += (block.length / rate.current) * 1000;
        runs.current.push(...d.push(block));
      });
      rate.current = c.sampleRate;
      detector.current = new ToneDetector(c.sampleRate);
      runs.current = [];
      heardMs.current = 0;
      clearedAt.current = 0;
      capture.current = c;
      setState("listening");
      try {
        wake.current = await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<{ release(): Promise<void> }> } }).wakeLock?.request("screen") ?? null;
      } catch {
        // No wake lock (or refused): the page still listens while the screen is on.
      }
    } catch (e) {
      const why = e instanceof Error ? e.message : "";
      setState(why === "denied" || why === "no-device" ? why : "unsupported");
    }
  }, []);

  const clear = useCallback(() => {
    runs.current = [];
    clearedAt.current = heardMs.current;
    setView((v) => ({ ...v, current: "", cards: [] }));
  }, []);

  useEffect(() => {
    if (state !== "listening") return;
    const id = setInterval(() => {
      const d = detector.current;
      if (!d) return;
      const from = clearedAt.current;
      const rs = runs.current.filter((r) => r.start >= from).map((r) => ({ start: r.start - from, length: r.length }));
      const groups = spellGroups(rs, heardMs.current - from);
      const last = groups.at(-1);
      setView({
        level: d.level,
        toneOn: d.toneOn,
        locked: d.tone !== null,
        current: last?.open && last.fromStart ? toDigits(last.symbols) : "",
        cards: tally(readsOf(groups)),
      });
    }, REDRAW_MS);
    return () => clearInterval(id);
  }, [state]);

  return <RadioPanel state={state} {...view} onListen={() => void listen()} onStop={stop} onClear={clear} />;
}
