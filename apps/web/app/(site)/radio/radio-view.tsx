"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startCapture } from "@/lib/radio/capture";
import { ToneDetector } from "@/lib/radio/detector";
import { readsOf, spellGroups, toDigits, type Read, type ToneRun } from "@/lib/radio/decode";
import { browserStore, loadReads, saveReads } from "@/lib/radio/saved";
import { TapKey } from "@/lib/radio/tap";
import { wavOf } from "@/lib/radio/wav";
import { btnQuiet } from "@/app/components/ui";
import { tally, type BunkerCard } from "@/lib/radio/tally";
import { RadioPanel, type RadioState } from "./radio-panel";

const REDRAW_MS = 100;
/** /radio?debug keeps this much of the microphone's own audio (about 29 MB as a WAV), the newest: a whole broadcast round is about 4½ minutes. */
const DEBUG_KEEP_S = 300;
/** How long Start over's Undo stays on offer. */
const UNDO_MS = 10_000;

type View = { level: number; toneOn: boolean; locked: boolean; current: string; symbols: string; cards: BunkerCard[] };
const EMPTY: View = { level: 0, toneOn: false, locked: false, current: "", symbols: "", cards: [] };
type WakeLock = { release(): Promise<void> };

const key = (reads: Read[]) => reads.map((r) => r.digits).join(",");

/**
 * The microphone or the tap key, the detector and the decoder, redrawn ten
 * times a second. Every pass re-reads everything heard this session: a late
 * read can still fix an early digit. Reads from earlier sessions (kept on
 * this device, lib/radio/saved.ts) are voted in beside them, so the map and
 * back costs nothing. Nothing is sent anywhere.
 */
export default function RadioView() {
  const [state, setState] = useState<RadioState>("idle");
  const [view, setView] = useState<View>(EMPTY);
  const [pressed, setPressed] = useState(false);
  const [restored, setRestored] = useState(false);
  const [undo, setUndo] = useState<Read[] | null>(null);
  const capture = useRef<{ stop(): void } | null>(null);
  const detector = useRef<ToneDetector | null>(null);
  const tap = useRef<TapKey | null>(null);
  const generation = useRef(0);
  const runs = useRef<ToneRun[]>([]);
  const heardMs = useRef(0);
  // ⚠️ Clear restarts the clock as well as the runs: a group counts as heard
  // from its start only after a real group gap of heard silence, so clearing
  // mid-group must leave that group a tail. Mic ms or tap ms, by mode.
  const clearedAt = useRef(0);
  // Reads from finished sessions (and this device's saved ones), and this
  // session's, re-derived every redraw. ⚠️ Kept apart until the session ends:
  // folding a redraw's reads into `kept` would count each one again every 100 ms.
  const kept = useRef<Read[]>([]);
  const current = useRef<Read[]>([]);
  const savedKey = useRef("");
  const wake = useRef<WakeLock | null>(null);
  // ⚠️ Bumped by every Listen, Tap along and Stop. Each await in listen()
  // checks it: a capture that resolves after Stop, or after the page is gone,
  // is shut at once instead of leaving the microphone and the wake lock on.
  const session = useRef(0);
  // /radio?debug: the raw samples and the mic settings the browser applied,
  // so a player can send us exactly what the page heard.
  const [debug, setDebug] = useState(false);
  const [debugInfo, setDebugInfo] = useState<{ rate: number; settings: MediaTrackSettings } | null>(null);
  const debugBlocks = useRef<Float32Array[]>([]);
  const debugLen = useRef(0);
  useEffect(() => setDebug(new URLSearchParams(window.location.search).has("debug")), []);

  /** Vote everything, show it, and keep it if it changed. Stamped only on a change, so the two hours run from the last new read. */
  const publish = useCallback((extra: Partial<View> = {}) => {
    const all = [...kept.current, ...current.current];
    const k = key(all);
    if (k !== savedKey.current) {
      savedKey.current = k;
      saveReads(browserStore(), all, Date.now());
    }
    setView((v) => ({ ...v, ...extra, cards: tally(all) }));
  }, []);

  // Read on mount, not during render: the page is static, and the server has no store.
  useEffect(() => {
    const got = loadReads(browserStore(), Date.now());
    if (got.length === 0) return;
    kept.current = got;
    savedKey.current = key(got);
    setRestored(true);
    setView((v) => ({ ...v, cards: tally(got) }));
  }, []);

  const requestWake = useCallback(async (id: number) => {
    try {
      const lock = await (navigator as Navigator & { wakeLock?: { request(t: "screen"): Promise<WakeLock> } }).wakeLock?.request("screen");
      if (!lock) return;
      if (id !== session.current) void lock.release().catch(() => {});
      else wake.current = lock;
    } catch {
      // No wake lock, or refused: the page still works while the screen is on.
    }
  }, []);

  /** Ends whatever session is running and keeps what it heard. */
  const end = useCallback(() => {
    session.current++;
    capture.current?.stop();
    capture.current = null;
    tap.current = null;
    setPressed(false);
    kept.current = [...kept.current, ...current.current];
    current.current = [];
    void wake.current?.release().catch(() => {});
    wake.current = null;
  }, []);

  const stop = useCallback(() => {
    end();
    setView((v) => ({ ...v, current: "", symbols: "" }));
    setState((s) => (s === "listening" || s === "starting" || s === "tapping" ? "idle" : s));
  }, [end]);

  useEffect(() => end, [end]);

  const listen = useCallback(async () => {
    end();
    const id = session.current;
    setRestored(false);
    setState("starting");
    // Blocks arriving before the new detector exists belong to no session.
    detector.current = null;
    try {
      const c = await startCapture(
        (block) => {
          const d = detector.current;
          if (!d) return;
          heardMs.current += (block.length / c.sampleRate) * 1000;
          if (debug) {
            debugBlocks.current.push(block);
            debugLen.current += block.length;
            while (debugLen.current - debugBlocks.current[0]!.length > DEBUG_KEEP_S * c.sampleRate) debugLen.current -= debugBlocks.current.shift()!.length;
          }
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
      debugBlocks.current = [];
      debugLen.current = 0;
      setDebugInfo({ rate: c.sampleRate, settings: c.settings });
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
  }, [end, requestWake, debug]);

  const downloadDebug = useCallback(() => {
    if (!debugInfo || debugBlocks.current.length === 0) return;
    const url = URL.createObjectURL(new Blob([wavOf(debugBlocks.current, debugInfo.rate)], { type: "audio/wav" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `radio-${new Date().toISOString().replace(/[:.]/g, "-")}.wav`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }, [debugInfo]);

  const tapAlong = useCallback(() => {
    end();
    const id = session.current;
    setRestored(false);
    tap.current = new TapKey(performance.now());
    clearedAt.current = 0;
    setState("tapping");
    void requestWake(id);
  }, [end, requestWake]);

  // performance.now() at the handler, not the event's timeStamp: the gap
  // between the two is a few ms and the same every tap, so the rhythm the
  // decoder reads is unchanged, and it sits on the TapKey's own clock.
  const press = useCallback(() => {
    if (!tap.current) return;
    tap.current.press(performance.now());
    setPressed(true);
  }, []);
  const release = useCallback(() => {
    if (!tap.current?.pressed) return;
    tap.current.release(performance.now());
    setPressed(false);
  }, []);

  // The browser drops a wake lock whenever the page is hidden; take it again on return.
  // A tap held as the page hides would never see its release: end it here.
  useEffect(() => {
    if (state !== "listening" && state !== "tapping") return;
    const id = session.current;
    const onVisible = () => {
      if (document.visibilityState === "visible" && !wake.current) void requestWake(id);
      if (document.visibilityState === "hidden") {
        wake.current = null;
        release();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [state, requestWake, release]);

  const clear = useCallback(() => {
    const all = [...kept.current, ...current.current];
    if (all.length > 0) setUndo(all);
    kept.current = [];
    current.current = [];
    runs.current = [];
    clearedAt.current = tap.current ? tap.current.elapsed(performance.now()) : heardMs.current;
    setRestored(false);
    publish({ current: "", symbols: "" });
  }, [publish]);

  const undoClear = useCallback(() => {
    if (!undo) return;
    // Anything heard since Start over stays: it is this session's, and votes with the rest.
    kept.current = [...undo, ...kept.current];
    setUndo(null);
    publish();
  }, [undo, publish]);

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), UNDO_MS);
    return () => clearTimeout(t);
  }, [undo]);

  useEffect(() => {
    if (state !== "listening" && state !== "tapping") return;
    const tick = setInterval(() => {
      let all: ToneRun[];
      let from: number;
      let now: number;
      let extra: Partial<View>;
      const d = detector.current;
      const k = tap.current;
      if (state === "tapping" && k) {
        all = k.runs;
        from = clearedAt.current;
        now = k.elapsed(performance.now());
        extra = { level: 0, toneOn: false, locked: false };
      } else if (state === "listening" && d) {
        all = runs.current;
        from = Math.max(clearedAt.current, d.heardFrom);
        now = heardMs.current;
        extra = { level: d.level, toneOn: d.toneOn, locked: d.tone !== null };
      } else {
        return;
      }
      const rs = all.filter((r) => r.start >= from).map((r) => ({ start: r.start - from, length: r.length }));
      const groups = spellGroups(rs, now - from);
      const last = groups.at(-1);
      current.current = readsOf(groups);
      publish({
        ...extra,
        current: last?.open && last.fromStart ? toDigits(last.symbols) : "",
        symbols: last?.open ? last.symbols.join("") : "",
      });
    }, REDRAW_MS);
    return () => clearInterval(tick);
  }, [state, publish]);

  return (
    <>
    <RadioPanel
      state={state}
      {...view}
      pressed={pressed}
      restored={restored}
      undoable={undo !== null}
      onListen={() => void listen()}
      onTap={tapAlong}
      onStop={stop}
      onClear={clear}
      onUndo={undoClear}
      onPress={press}
      onRelease={release}
    />
    {debug && debugInfo && (
      <div className="mt-6 flex flex-col gap-2 font-mono text-xs text-muted">
        <p>Debug · {debugInfo.rate} Hz · {JSON.stringify(debugInfo.settings)}</p>
        <button type="button" className={btnQuiet} onClick={downloadDebug}>Save what the page heard (last {DEBUG_KEEP_S / 60} min)</button>
      </div>
    )}
    </>
  );
}
