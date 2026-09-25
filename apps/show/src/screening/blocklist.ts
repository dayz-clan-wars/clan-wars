/**
 * The deterministic first pass over player text and over the finished script (spec §7).
 * Narrow on purpose: hate terms, extremist references and slurs. NOT general profanity
 * or innuendo, which the show happily riffs on ("The Cocks" is a rooster clan and must
 * pass). Anything subtler is the LLM moderator's call; a hit here is final.
 *
 * ⚠️ Matches WITHIN one word, never across words. Joining a sentence into one run of
 * letters turns "the illness" into a hit on "heil" and "ok I keep" into a slur, and the
 * output screen runs this over a whole script. Across words it only catches an exact
 * two-word spelling ("White Power") and runs of spaced-out single letters ("n a z i").
 *
 * ⚠️ A false positive cannot be overridden by the moderator, only by an operator row.
 * Add a term only if no reasonable word or gamertag contains it.
 */

/** Common Cyrillic and Greek letters that render like Latin ones. NFKC does not fold these. */
const CONFUSABLES: Record<string, string> = {
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "х": "x", "у": "y",
  "і": "i", "ј": "j", "к": "k", "м": "m", "н": "h", "т": "t", "в": "b",
  "α": "a", "ο": "o", "ε": "e", "ι": "i", "κ": "k", "ν": "v", "ρ": "p",
  "τ": "t", "υ": "u", "χ": "x", "ζ": "z",
};

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i" };

/** Substring of one word's `letters` (or `collapsed`), or the exact join of two words. */
const TERMS = [
  // Extremism
  "nazi", "hitler", "heil", "reich", "kkk", "whitepower", "whitepride", "aryan", "swastika",
  "gasthe", "holohoax", "zyklon", "totenkopf", "sonnenrad",
  // Slurs
  "nigger", "nigga", "faggot", "kike", "chink", "wetback", "tranny", "retard", "beaner", "gook",
];

/** Substring of one word's `alnum` (digits kept, no leet, since leet would turn them into letters). */
const CODES = ["1488", "14words"];

/** Substring of one word's `base` (symbols kept). */
const SYMBOLS = ["卐", "卍", "ᛋᛋ", "ϟϟ"];

export type Forms = { base: string; alnum: string; letters: string; collapsed: string };

export function normalizeForms(s: string): Forms {
  const base = [...s.normalize("NFKC").toLowerCase()].map((ch) => CONFUSABLES[ch] ?? ch).join("");
  const alnum = base.replace(/[^a-z0-9]/gu, "");
  const letters = [...base].map((ch) => LEET[ch] ?? ch).join("").replace(/[^a-z]/gu, "");
  const collapsed = letters.replace(/(.)\1+/gu, "$1");
  return { base, alnum, letters, collapsed };
}

const collapse = (t: string) => t.replace(/(.)\1+/gu, "$1");

function withinWord(word: string): string | null {
  const f = normalizeForms(word);
  for (const sym of SYMBOLS) if (f.base.includes(sym)) return sym;
  for (const code of CODES) if (f.alnum.includes(code)) return code;
  // ⚠️ Both forms: `collapsed` catches "Naaazi", `letters` catches "kkk" directly.
  // The `collapsed` comparison is skipped when a term's own collapsed form is under
  // three letters ("kkk" collapses to "k") — a one- or two-letter needle would then
  // match almost any word that happens to contain those letters, once the word's own
  // repeated letters are collapsed too ("Cocks" -> "cocks", "keep" -> "kep", etc. all
  // contain "k"). "KKK" and "k k k" still block: both already match via the `letters`
  // comparison ("kkk" is a literal substring/equality there, never collapsed).
  for (const t of TERMS) {
    const c = collapse(t);
    if (f.letters.includes(t) || (c.length >= 3 && f.collapsed.includes(c))) return t;
  }
  return null;
}

function exactly(joined: string): string | null {
  const f = normalizeForms(joined);
  for (const code of CODES) if (f.alnum === code) return code;
  // ⚠️ See the matching comment in `withinWord`: skip the collapsed-form check for a
  // term whose collapsed form is under three letters, to avoid a near-universal match.
  for (const t of TERMS) {
    const c = collapse(t);
    if (f.letters === t || (c.length >= 3 && f.collapsed === c)) return t;
  }
  return null;
}

export function blocklistHit(s: string): string | null {
  const words = s.split(/\s+/u).filter((w) => w !== "");
  for (const w of words) {
    const hit = withinWord(w);
    if (hit !== null) return hit;
  }
  for (let i = 0; i + 1 < words.length; i++) {
    const hit = exactly(words[i]! + words[i + 1]!);
    if (hit !== null) return hit;
  }
  // Runs of single characters: "n a z i", "k k k", "1 4 8 8".
  let run = "";
  for (const w of [...words, ""]) {
    if ([...w].length === 1) { run += w; continue; }
    if ([...run].length > 1) {
      const hit = withinWord(run);
      if (hit !== null) return hit;
    }
    run = "";
  }
  return null;
}
