/**
 * The microphone's own samples as a 16-bit mono WAV, for /radio?debug. It is
 * the only way to see what a phone's browser actually hands the page: a
 * camera-app recording of the same radio goes through a different audio path
 * and decoded fine while the page heard nothing (2026-10-26, Pixel + Chrome).
 */
export function wavOf(blocks: readonly Float32Array[], sampleRate: number): ArrayBuffer {
  let n = 0;
  for (const b of blocks) n += b.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const text = (at: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i)); };
  text(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  text(36, "data");
  v.setUint32(40, n * 2, true);
  let at = 44;
  for (const b of blocks) {
    for (let i = 0; i < b.length; i++, at += 2) v.setInt16(at, Math.round(Math.max(-1, Math.min(1, b[i]!)) * 32767), true);
  }
  return buf;
}
