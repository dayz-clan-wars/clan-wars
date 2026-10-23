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
type WakeLock = { release(): Promise<void> };

/**
 * The microphone, the detector and the decoder, redrawn ten times a second.
 * Every pass re-reads everything heard so far: a late read can still fix an
 * early digit. Nothing is stored or sent; leaving the page drops it all.
 */
export default function RadioView() {
  const [state, setState] = useState<RadioState>("idle");
  const [view, setView] = useState<View>(EMPTY);
  const capture = useRef<{ stop(): void } | null>(null);
  const detector = useRef<ToneDetector | null>(null);
  const generation = useRef(0);
  const runs = useRef<ToneRun[]>([]);
  const heardMs = useRef(0);
  // ⚠️ Clear restarts the clock as well as the runs: a group counts as heard
  // from its start only after a real group gap of heard silence, so clearing
  // mid-group must leave that group a tail.
  const clearedAt = useRef(0);
  const wake = useRef<WakeLock | null>(null);
  // ⚠️ Bumped by every Listen and Stop. Each await in listen() checks it: a
  // capture that resolves after Stop, or after the page is gone, is shut at
  // once instead of leaving the microphone and the wake lock on.
  const session = useRef(0);

  const requestWake = useCallback(async (id: number) => {
    try {
      const lock = await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<WakeLock> } }).wakeLock?.request("screen");
      if (!lock) return;
      if (id !== session.current) void lock.release().catch(() => {});
      else wake.current = lock;
    } catch {
      // No wake lock, or refused: the page still listens while the screen is on.
    }
  }, []);

  const stop = useCallback(() => {
    session.current++;
    capture.current?.stop();
    capture.current = null;
    void wake.current?.release().catch(() => {});
    wake.current = null;
    setState((s) => (s === "listening" || s === "starting" ? "idle" : s));
  }, []);

  useEffect(() => stop, [stop]);

  const listen = useCallback(async () => {
    const id = ++session.current;
    setState("starting");
    // Blocks arriving before the new detector exists belong to no session.
    detector.current = null;
    try {
      const c = await startCapture(
        (block) => {
          const d = detector.current;
          if (!d) return;
          heardMs.current += (block.length / c.sampleRate) * 1000;
          const got = d.push(block);
          // A new lock replays the recent audio: what the old one said is void.
          if (d.generation !== generation.current) {
            runs.current = [];
            generation.current = d.generation;
          }
          runs.current.push(...got);
        },
        (ms) => {
          const d = detector.current;
          if (!d) return;
          heardMs.current += ms;
          runs.current.push(...d.skip(ms));
        },
      );
      if (id !== session.current) {
        c.stop();
        return;
      }
      detector.current = new ToneDetector(c.sampleRate);
      generation.current = detector.current.generation;
      runs.current = [];
      heardMs.current = 0;
      clearedAt.current = 0;
      capture.current = c;
      setState("listening");
      void requestWake(id);
    } catch (e) {
      if (id !== session.current) return;
      const why = e instanceof Error ? e.message : "";
      setState(why === "denied" || why === "no-device" || why === "busy" ? why : "unsupported");
    }
  }, [requestWake]);

  // The browser drops a wake lock whenever the page is hidden; take it again on return.
  useEffect(() => {
    if (state !== "listening") return;
    const id = session.current;
    const onVisible = () => {
      if (document.visibilityState === "visible" && !wake.current) void requestWake(id);
      if (document.visibilityState === "hidden") wake.current = null;
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [state, requestWake]);

  const clear = useCallback(() => {
    runs.current = [];
    clearedAt.current = heardMs.current;
    setView((v) => ({ ...v, current: "", cards: [] }));
  }, []);

  useEffect(() => {
    if (state !== "listening") return;
    const tick = setInterval(() => {
      const d = detector.current;
      if (!d) return;
      const from = Math.max(clearedAt.current, d.heardFrom);
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
    return () => clearInterval(tick);
  }, [state]);

  return <RadioPanel state={state} {...view} onListen={() => void listen()} onStop={stop} onClear={clear} />;
}
