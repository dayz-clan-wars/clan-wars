/**
 * The deterministic first pass over player text and over the finished script (spec section 7).
 * Narrow on purpose: hate terms, extremist references and slurs. NOT general profanity
 * or innuendo, which the show happily riffs on ("The Cocks" is a rooster clan and must
 * pass). Anything subtler is the LLM moderator's call; a hit here is final.
 *
 * ⚠️ Matches WITHIN one word, never across words. Joining a sentence into one run of
 * letters turns "the illness" into a hit on "heil" and "ok I keep" into a slur, and the
 * output screen runs this over a whole script. Across words it only catches an exact
 * spelling across two to four consecutive words ("White Power") and runs of spaced-out
 * single letters ("n a z i").
 *
 * ⚠️ A false positive cannot be overridden by the moderator, only by an operator row.
 * Add a term only if no reasonable word or gamertag contains it.
 */

/** Common Cyrillic and Greek letters that render like Latin ones. NFKC does not fold these. */
const CONFUSABLES: Record<string, string> = {
  "\u0430": "a", "\u0435": "e", "\u043e": "o", "\u0440": "p", "\u0441": "c", "\u0445": "x", "\u0443": "y",
  "\u0456": "i", "\u0458": "j", "\u043a": "k", "\u043c": "m", "\u043d": "h", "\u0442": "t", "\u0432": "b",
  "\u03b1": "a", "\u03bf": "o", "\u03b5": "e", "\u03b9": "i", "\u03ba": "k", "\u03bd": "v", "\u03c1": "p",
  "\u03c4": "t", "\u03c5": "u", "\u03c7": "x", "\u03b6": "z",
};

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "8": "b", "@": "a", "$": "s", "!": "i", "|": "i" };

/**
 * Substring of one word's `letters`, a whole word's `collapsed` form (optionally plus
 * "s"), or the exact join of two to four words.
 */
// Words with common innocent uses (a gamertag, ordinary prose in the script) are left
// to the LLM moderator rather than blocked here - see the file comment above.
const TERMS = [
  // Extremism
  "nazi", "hitler", "siegheil", "thirdreich", "kkk", "whitepower", "whitepride", "swastika",
  "holohoax", "zyklon", "totenkopf", "sonnenrad",
  // Slurs
  "nigger", "nigga", "faggot", "kike", "wetback", "beaner",
];

/**
 * A whole word only (its `letters` or `collapsed` form EQUALS the term), or the exact
 * join of two to four words. Never a substring: "Sheila", "Theil", "Reichert".
 */
const WORD_TERMS = ["heil", "reich"];

/**
 * Spec §7.1 allowlist for known false positives. Each stem is removed from a word's
 * `letters` and `collapsed` forms before term matching, so "Nazir" passes while
 * "NazirHitler" still hits "hitler". A stem only removes itself.
 */
const ALLOW = ["snigger", "nazir", "nazim", "nazia"];

const unallow = (s: string) => ALLOW.reduce((acc, a) => acc.split(a).join(""), s);

/** Substring of one word's `alnum` (digits kept, no leet, since leet would turn them into letters). */
const CODES = ["1488", "14words"];

/** Substring of one word's `base` (symbols kept). */
const SYMBOLS = ["\u5350", "\u534d", "\u16cb\u16cb", "\u03df\u03df"];

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
  const letters = unallow(f.letters);
  const collapsed = unallow(f.collapsed);
  // ⚠️ Both forms: `collapsed` catches "Naaazi", `letters` catches "kkk" directly.
  // The `collapsed` comparison is skipped when a term's own collapsed form is under
  // three letters ("kkk" collapses to "k") - a one- or two-letter needle would then
  // match almost any word that happens to contain those letters, once the word's own
  // repeated letters are collapsed too ("Cocks" -> "cocks", "keep" -> "kep", etc. all
  // contain "k"). "KKK" and "k k k" still block: both already match via the `letters`
  // comparison ("kkk" is a literal substring/equality there, never collapsed).
  // ⚠️ The `collapsed` comparison is whole-word (the term, or the term plus "s"), never a
  // substring: collapsing turns "Nigeria" into a word containing "niger".
  for (const t of TERMS) {
    const c = collapse(t);
    if (letters.includes(t) || (c.length >= 3 && (collapsed === c || collapsed === `${c}s`))) return t;
  }
  for (const t of WORD_TERMS) {
    const c = collapse(t);
    if (letters === t || (c.length >= 3 && collapsed === c)) return t;
  }
  return null;
}

function exactly(joined: string): string | null {
  const f = normalizeForms(joined);
  for (const code of CODES) if (f.alnum === code) return code;
  // ⚠️ See the matching comment in `withinWord`: skip the collapsed-form check for a
  // term whose collapsed form is under three letters, to avoid a near-universal match.
  for (const t of [...TERMS, ...WORD_TERMS]) {
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
  // Every window of 2, 3 and 4 consecutive words, joined, checked for exact equality
  // with a term or code - not just adjacent pairs, so a slur or code spelled out one
  // word per letter/syllable across three or four words ("na z i", "h i tler") still
  // hits, while still never joining the whole sentence into one run (see the file
  // comment above).
  for (let n = 2; n <= 4; n++) {
    for (let i = 0; i + n <= words.length; i++) {
      const hit = exactly(words.slice(i, i + n).join(""));
      if (hit !== null) return hit;
    }
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
