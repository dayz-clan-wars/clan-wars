const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };

/**
 * Make one gamertag read naturally aloud (for TTS only — the text recap keeps the real tag).
 * 1) drop a trailing digit run (Xbox appends random numbers), 2) symbols/underscores -> spaces,
 * 3) drop decorative all-x tokens (xX / Xx), 4) de-leet interior digits, 5) collapse. Falls back
 * to the original tag if nothing speakable remains.
 */
export function speakableName(tag: string): string {
  if (typeof tag !== "string" || !tag) return tag ?? "";
  let s = tag.replace(/\d+$/, ""); // 1. trailing Xbox digit suffix
  s = s.replace(/^[xX]{2,}|[xX]{2,}$/g, ""); // 2. strip attached xX/Xx wrapper clusters (2+)
  s = s.replace(/[^A-Za-z0-9]+/g, " "); // 3. symbols/underscores -> spaces
  s = s.split(" ").filter((t) => t && !/^x+$/i.test(t)).join(" "); // 4. drop standalone xX/Xx tokens
  s = s.replace(/[013457]/g, (d) => LEET[d]!); // 5. de-leet interior digits
  s = s.replace(/\s+/g, " ").trim(); // 6. collapse
  return s.length ? s : tag;
}
