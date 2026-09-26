const TRIM_THRESHOLD = 500; // |int16| at/under this counts as silence

/**
 * Trim leading and trailing silence from one turn's PCM16 (mono LE), so a provider's per-clip
 * padding doesn't stack into long pauses between hosts. Returns an empty buffer if all silent.
 * Ported from KOTH `openrouterAudio.js`'s `trimSilencePcm` — the only piece of that file this
 * plan keeps (spec's global constraints: everything else in `openrouterAudio.js` is dropped).
 */
export function trimSilencePcm(pcm: Buffer, threshold: number = TRIM_THRESHOLD): Buffer {
  const n = pcm.length >> 1;
  let start = 0;
  let end = n;
  while (start < n && Math.abs(pcm.readInt16LE(start * 2)) <= threshold) start++;
  while (end > start && Math.abs(pcm.readInt16LE((end - 1) * 2)) <= threshold) end--;
  return start >= end ? Buffer.alloc(0) : pcm.subarray(start * 2, end * 2);
}
