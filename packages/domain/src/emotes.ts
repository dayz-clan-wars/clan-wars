export type EmoteEntry = { label: string; token: string; safe: boolean };

/**
 * Every `performed Emote*` token observed in the production ADM export
 * (2026-08-26: 35 distinct tokens across 2,093 lines).
 *
 * `safe: false` excludes an emote from verification sequences, for one of two
 * reasons:
 *
 *   1. It occurs in natural play. `EmoteSitA` is 1,611 of the 2,093 emote
 *      lines — 77% of all emote traffic. A sequence containing it would
 *      routinely be completed by accident, binding a UID that never ran
 *      `/link`.
 *   2. It carries a gameplay penalty. Asking a player to prove identity by
 *      killing their character is not a verification flow.
 *
 * ⚠️ Do not add a token here that has not been observed in a real ADM line.
 * A guessed token can never be performed, so a sequence containing it can
 * never complete, and the failure looks like a broken parser.
 */
export const EMOTE_DICTIONARY: EmoteEntry[] = [
  { label: "salute", token: "EmoteSalute", safe: true },
  { label: "surrender", token: "EmoteSurrender", safe: true },
  { label: "greeting", token: "EmoteGreeting", safe: true },
  { label: "clap", token: "EmoteClap", safe: true },
  { label: "heart", token: "EmoteHeart", safe: true },
  { label: "point", token: "EmotePoint", safe: true },
  { label: "point at self", token: "EmotePointSelf", safe: true },
  { label: "thumbs up", token: "EmoteThumb", safe: true },
  { label: "thumbs down", token: "EmoteThumbDown", safe: true },
  { label: "nod head", token: "EmoteNod", safe: true },
  { label: "shake head", token: "EmoteShake", safe: true },
  { label: "dance", token: "EmoteDance", safe: true },
  { label: "facepalm", token: "EmoteFacepalm", safe: true },
  { label: "shrug", token: "EmoteShrug", safe: true },
  { label: "timeout", token: "EmoteTimeout", safe: true },
  { label: "look at me", token: "EmoteLookAtMe", safe: true },
  { label: "listen", token: "EmoteListening", safe: true },
  { label: "come", token: "EmoteCome", safe: true },
  { label: "move", token: "EmoteMove", safe: true },
  { label: "silent", token: "EmoteSilent", safe: true },
  { label: "watching", token: "EmoteWatching", safe: true },
  { label: "cut throat", token: "EmoteThroat", safe: true },
  { label: "rock paper scissors", token: "EmoteRPSRandom", safe: true },
  { label: "hold", token: "EmoteHold", safe: true },
  { label: "SOS", token: "EmoteSOS", safe: true },
  // Taunts — observed in the export, absent from one-life's dictionary.
  { label: "taunt", token: "EmoteTaunt", safe: true },
  { label: "taunt elbow", token: "EmoteTauntElbow", safe: true },
  { label: "blow a kiss", token: "EmoteTauntKiss", safe: true },
  { label: "thinking", token: "EmoteTauntThink", safe: true },
  // Unsafe — natural play (postures players hold for minutes at a time).
  { label: "sit", token: "EmoteSitA", safe: false },
  { label: "sit cross-legged", token: "EmoteSitB", safe: false },
  { label: "sit at campfire", token: "EmoteCampfireSit", safe: false },
  { label: "lie down", token: "EmoteLyingDown", safe: false },
  // Unsafe — gameplay penalty.
  { label: "suicide", token: "EmoteSuicide", safe: false },
  { label: "vomit", token: "EmoteVomit", safe: false },
];

const byLabel = new Map(EMOTE_DICTIONARY.map((e) => [e.label.toLowerCase(), e]));
const byToken = new Map(EMOTE_DICTIONARY.map((e) => [e.token, e]));

export function emoteToken(label: string): string | undefined {
  return byLabel.get(label.toLowerCase())?.token;
}

export function emoteLabel(token: string): string | undefined {
  return byToken.get(token)?.label;
}

export function safeVerificationEmotes(): EmoteEntry[] {
  return EMOTE_DICTIONARY.filter((e) => e.safe);
}
