import { speakableName } from "./speakableName.js";
import { replaceNamesForSpeech } from "../llm/formatBanter.js";
import type { Turn } from "./parseDialogue.js";

export type TtsInput = { text: string; voice_id: string };

/**
 * Map parsed dialogue turns to audio inputs: each turn's text with every name rendered via
 * `pronounce` (default `speakableName`) — caught in any case/emphasis form via
 * `replaceNamesForSpeech`, since the TTS must never read a raw tag — and a voice chosen by speaker
 * (Pavel -> pavelVoiceId, else borisVoiceId). Leftover markdown (backticks/asterisks) is stripped so
 * it isn't vocalized. Empty turns are dropped. Cumulative text is capped at `maxChars` so the audio
 * request stays within provider limits — once a turn would exceed it, it and the rest are dropped
 * (the episode ends a touch early rather than failing the whole synthesis).
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
  const inputs: TtsInput[] = [];
  let total = 0;
  for (const t of turns) {
    const text = replaceNamesForSpeech(t.text, gamertags, pronounce)
      .replace(/[`*]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    if (total + text.length > maxChars) break;
    const isPavel = t.speaker === "Pavel";
    inputs.push({ text, voice_id: isPavel ? pavelVoiceId : borisVoiceId });
    total += text.length;
  }
  return inputs;
}
