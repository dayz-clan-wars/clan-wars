/**
 * The microphone, as blocks of samples. Browser only; everything it feeds
 * (detector, decoder, tally) is pure and tested without it.
 */

export type CaptureError = "denied" | "no-device" | "busy" | "unsupported";
const RESUME_WAIT_MS = 3000;

/**
 * ⚠️ The worklet loads from a Blob URL, never a file in public/: lib/auth/gate.ts
 * gates every public/ path, so a signed-out player's worklet fetch would land
 * on /login and the page would hear nothing, with no error worth showing.
 */
const TAP = `
class RadioTap extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor("radio-tap", RadioTap);
`;

/**
 * `onGap` hears how long the audio stopped for (the context suspended or was
 * interrupted: a screen lock, a phone call), so the detector can count that
 * time as silence rather than join the audio either side of it.
 */
export async function startCapture(onSamples: (block: Float32Array) => void, onGap: (ms: number) => void): Promise<{ sampleRate: number; settings: MediaTrackSettings; stop(): void }> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === "undefined") {
    throw new Error("unsupported" satisfies CaptureError);
  }
  // ⚠️ Made and resumed before the permission prompt, while the tap that
  // called this still counts as a user gesture: browsers only start audio
  // inside one, and on a phone the prompt can use it up, leaving a later
  // resume() pending forever and the page stuck on "starting".
  const ctx = new AudioContext();
  const resumed = ctx.resume();
  let stream: MediaStream;
  try {
    // ⚠️ All three off: a phone's voice processing treats a steady tone as
    // noise and filters the beeps out before the page ever hears them.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  } catch (e) {
    void ctx.close();
    const name = e instanceof DOMException ? e.name : "";
    if (name === "NotAllowedError" || name === "SecurityError") throw new Error("denied" satisfies CaptureError);
    if (name === "NotFoundError" || name === "OverconstrainedError") throw new Error("no-device" satisfies CaptureError);
    // Discord, a call or the Xbox app holding the microphone: worth another try, unlike a browser that cannot.
    if (name === "NotReadableError" || name === "AbortError") throw new Error("busy" satisfies CaptureError);
    throw new Error("unsupported" satisfies CaptureError);
  }

  const release = () => {
    for (const t of stream.getTracks()) t.stop();
    void ctx.close();
  };
  let tap: AudioWorkletNode;
  try {
    const url = URL.createObjectURL(new Blob([TAP], { type: "application/javascript" }));
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }
    // ⚠️ Never wait on resume() unbounded: if the browser never grants it, the
    // page would sit on "starting" with Listen disabled. After a wait, carry
    // on; the visibility handler below asks again.
    await Promise.race([resumed, new Promise((r) => setTimeout(r, RESUME_WAIT_MS))]);
    const source = ctx.createMediaStreamSource(stream);
    tap = new AudioWorkletNode(ctx, "radio-tap");
    tap.port.onmessage = (ev: MessageEvent<Float32Array>) => onSamples(ev.data);
    // A node nothing pulls from may never run; a silent gain to the speakers keeps it pulled.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(tap).connect(mute).connect(ctx.destination);
  } catch {
    // ⚠️ The microphone is open by now: leave it open and the browser shows it in use until the tab closes.
    release();
    throw new Error("unsupported" satisfies CaptureError);
  }

  let pausedAt: number | null = ctx.state === "running" ? null : performance.now();
  ctx.onstatechange = () => {
    if (ctx.state === "running") {
      if (pausedAt !== null) onGap(performance.now() - pausedAt);
      pausedAt = null;
    } else if (pausedAt === null) {
      pausedAt = performance.now();
    }
  };
  const wake = () => {
    if (document.visibilityState === "visible" && ctx.state !== "running" && ctx.state !== "closed") void ctx.resume().catch(() => {});
  };
  document.addEventListener("visibilitychange", wake);

  return {
    sampleRate: ctx.sampleRate,
    // What the browser actually applied: the constraints above are only asked for. Shown on /radio?debug.
    settings: stream.getAudioTracks()[0]?.getSettings() ?? {},
    stop() {
      document.removeEventListener("visibilitychange", wake);
      ctx.onstatechange = null;
      tap.port.onmessage = null;
      release();
    },
  };
}
