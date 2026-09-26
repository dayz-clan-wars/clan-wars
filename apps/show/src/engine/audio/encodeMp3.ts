import { spawnRun, type Run } from "../run.js";

/**
 * Encode raw PCM16 (24 kHz mono) to an mp3 Buffer via ffmpeg (with loudnorm), in-memory.
 * `runImpl` defaults to `spawnRun` and is DI'd for tests.
 */
export async function encodeMp3(pcm: Buffer, o: { runImpl?: Run } = {}): Promise<Buffer> {
  const { runImpl = spawnRun } = o;
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "s16le",
    "-ar",
    "24000",
    "-ac",
    "1",
    "-i",
    "pipe:0",
    "-af",
    "loudnorm=I=-16:TP=-1.5:LRA=11",
    "-f",
    "mp3",
    "pipe:1",
  ];
  const mp3 = await runImpl("ffmpeg", args, { input: pcm });
  if (!mp3 || !mp3.length) throw new Error("mp3 encode produced no output");
  return mp3;
}
