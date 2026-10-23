/**
 * The microphone, as blocks of samples. Browser only; everything it feeds
 * (detector, decoder, tally) is pure and tested without it.
 */

export type CaptureError = "denied" | "no-device" | "unsupported";

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

export async function startCapture(onSamples: (block: Float32Array) => void): Promise<{ sampleRate: number; stop(): void }> {
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
    throw new Error("unsupported" satisfies CaptureError);
  }

  const url = URL.createObjectURL(new Blob([TAP], { type: "application/javascript" }));
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  await resumed;
  const source = ctx.createMediaStreamSource(stream);
  const tap = new AudioWorkletNode(ctx, "radio-tap");
  tap.port.onmessage = (ev: MessageEvent<Float32Array>) => onSamples(ev.data);
  // A node nothing pulls from may never run; a silent gain to the speakers keeps it pulled.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  source.connect(tap).connect(mute).connect(ctx.destination);

  return {
    sampleRate: ctx.sampleRate,
    stop() {
      tap.port.onmessage = null;
      for (const t of stream.getTracks()) t.stop();
      void ctx.close();
    },
  };
}
