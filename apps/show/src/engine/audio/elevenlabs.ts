import { trimSilencePcm } from "./pcm.js";
import type { TtsInput } from "./buildDialogueScript.js";
import type { Span } from "./jingle.js";

// ElevenLabs returns pcm_24000 = raw s16le / 24 kHz / mono, which is exactly the pipeline format,
// so no decode step is needed. Unlike gpt-audio, ElevenLabs has NO free-text delivery-direction
// knob — it would read such a prompt aloud — so we send ONLY the line; tone comes from the voice.
const ENDPOINT = "https://api.elevenlabs.io/v1/text-to-speech";
const SAMPLE_RATE = 24000;
const GAP = Buffer.alloc(Math.round(2 * SAMPLE_RATE * 0.1)); // ~0.1s s16le silence between turns

export type VoiceSettings = {
  stability: number;
  similarity_boost: number;
  use_speaker_boost: boolean;
};

// Firmer than the 0.5 default: higher stability + speaker_boost hold the voice identity so a single
// turn doesn't "drift" into a different-sounding take (which showed up as one line in the wrong voice).
const DEFAULT_SETTINGS: VoiceSettings = { stability: 0.65, similarity_boost: 0.85, use_speaker_boost: true };

/** Synthesize one line with one ElevenLabs voice -> raw PCM (s16le/24k/mono). Throws on non-2xx. */
export async function elevenTurnPcm(o: {
  text: string;
  voiceId: string;
  apiKey: string;
  modelId?: string;
  voiceSettings?: VoiceSettings;
  fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  const { text, voiceId, apiKey, modelId = "eleven_multilingual_v2", voiceSettings, fetchImpl = fetch } = o;
  const res = await fetchImpl(`${ENDPOINT}/${voiceId}?output_format=pcm_24000`, {
    method: "POST",
    headers: { "xi-api-key": apiKey, "content-type": "application/json", accept: "audio/pcm" },
    body: JSON.stringify({ text, model_id: modelId, voice_settings: voiceSettings ?? DEFAULT_SETTINGS }),
  });
  if (!res.ok) {
    let d = "";
    try {
      d = (await res.text()).slice(0, 200);
    } catch {
      /* body unavailable */
    }
    throw new Error(`elevenlabs tts failed: ${res.status}${d ? ` ${d}` : ""}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * Synthesize each turn's PCM (voice per turn via input.voice_id), trim per-clip silence, concatenate
 * with short gaps. Any per-input `direction` is ignored (ElevenLabs has no delivery-prompt knob).
 */
export async function synthesizeElevenPcm(o: {
  inputs: TtsInput[];
  apiKey: string;
  modelId?: string;
  voiceSettings?: VoiceSettings;
  fetchImpl?: typeof fetch;
}): Promise<Buffer> {
  const { inputs, apiKey, modelId = "eleven_multilingual_v2", voiceSettings, fetchImpl = fetch } = o;
  const parts: Buffer[] = [];
  for (const input of inputs) {
    const pcm = trimSilencePcm(
      await elevenTurnPcm({ text: input.text, voiceId: input.voice_id, apiKey, modelId, voiceSettings, fetchImpl }),
    );
    if (pcm.length) parts.push(pcm, GAP);
  }
  return Buffer.concat(parts);
}

/**
 * Like synthesizeElevenPcm, but also returns per-turn spans within the concatenated PCM so the
 * animation pipeline can slice each turn for lip-sync. `pcm` is byte-identical to synthesizeElevenPcm.
 * Each recorded turn's [startSec,endSec) covers ITS audio only (the following GAP is excluded).
 */
export async function synthesizeElevenPcmTimed(o: {
  inputs: TtsInput[];
  apiKey: string;
  modelId?: string;
  voiceSettings?: VoiceSettings;
  fetchImpl?: typeof fetch;
}): Promise<{ pcm: Buffer; turns: (Span & { voiceId: string })[] }> {
  const { inputs, apiKey, modelId = "eleven_multilingual_v2", voiceSettings, fetchImpl = fetch } = o;
  const parts: Buffer[] = [];
  const turns: (Span & { voiceId: string })[] = [];
  let cursorBytes = 0;
  for (const input of inputs) {
    const pcm = trimSilencePcm(
      await elevenTurnPcm({ text: input.text, voiceId: input.voice_id, apiKey, modelId, voiceSettings, fetchImpl }),
    );
    if (!pcm.length) continue;
    const startSec = cursorBytes / (2 * SAMPLE_RATE);
    const endSec = (cursorBytes + pcm.length) / (2 * SAMPLE_RATE);
    turns.push({ startSec, endSec, voiceId: input.voice_id });
    parts.push(pcm, GAP);
    cursorBytes += pcm.length + GAP.length;
  }
  return { pcm: Buffer.concat(parts), turns };
}
