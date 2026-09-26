import { speakableName } from "./speakableName.js";
import { replaceNamesForSpeech } from "../llm/formatBanter.js";
import type { Turn } from "./parseDialogue.js";

export type TtsInput = { text: string; voice_id: string };

/**
 * Map parsed dialogue turns to audio inputs: each turn's text with every name rendered via
 * `pronounce` (default `speakableName`), caught in its exact or ALL-CAPS form and any emphasis via
 * `replaceNamesForSpeech`, since the TTS must never read a raw tag — and a voice chosen by speaker
 * (Pavel -> pavelVoiceId, else borisVoiceId). Leftover markdown (backticks/asterisks) is stripped so
 * it isn't vocalized. Empty turns are dropped. The script is capped at `maxChars`, measured on the
 * RAW turn text before name expansion (so a script that passed the narrative cap is never cut by
 * its own spoken names). Over the cap this throws, naming the character count, so the stage fails
 * and retries instead of publishing an episode with its ending silently dropped.
 *
 * `borisDirection`/`pavelDirection` from KOTH are dropped here: they only fed gpt-audio, and
 * ElevenLabs reads directions aloud (KOTH `showNotifier.js:253`).
 */
export function buildDialogueScript(
  turns: Turn[],
  o: {
    gamertags: string[];
    pronounce?: (tag: string) => string;
    borisVoiceId: string;
    pavelVoiceId: string;
    maxChars?: number;
  }
): TtsInput[] {
  const { gamertags = [], pronounce = speakableName, borisVoiceId, pavelVoiceId, maxChars = 6000 } = o;
  const rawTotal = turns.reduce((n, t) => n + (t.text ?? "").trim().length, 0);
  if (rawTotal > maxChars) {
    throw new Error(`buildDialogueScript: the script is ${rawTotal} characters, over the ${maxChars}-character speech cap`);
  }
  const inputs: TtsInput[] = [];
  for (const t of turns) {
    const text = replaceNamesForSpeech(t.text, gamertags, pronounce)
      .replace(/[`*]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const isPavel = t.speaker === "Pavel";
    inputs.push({ text, voice_id: isPavel ? pavelVoiceId : borisVoiceId });
  }
  return inputs;
}
