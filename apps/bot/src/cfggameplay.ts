/**
 * Set `GeneralData.disableBaseDamage` in the game server's cfggameplay.json,
 * returning the new document and whether anything actually changed.
 *
 * ⚠️ A targeted splice, NEVER a parse-and-reserialize. The live file is
 * tab-indented with a specific key order; a round trip through JSON.stringify
 * rewrites all 4,450 bytes, making the diff unreviewable and silently
 * reformatting a file a human may have to read under pressure. Everything
 * outside the one boolean comes back byte-identical.
 *
 * ⚠️ This file is the one whose corruption stops the server BOOTING, for every
 * player — not degrading, like events.xml. That is why every branch below
 * throws rather than doing its best: refusing to write costs at most a window
 * that opens two hours late, and the next slot retries.
 */
const KEY_RE = /("disableBaseDamage"\s*:\s*)(true|false)/g;

export function setBaseDamageDisabled(json: string, wanted: boolean): { json: string; changed: boolean } {
  // Guard: the input itself must be valid. A file that is already broken is not
  // one we should be splicing into and re-uploading.
  try {
    JSON.parse(json);
  } catch (err) {
    throw new Error(`cfggameplay.json: input did not parse — refusing to edit it (${(err as Error).message})`);
  }

  const matches = [...json.matchAll(KEY_RE)];
  if (matches.length === 0) {
    throw new Error('cfggameplay.json: no "disableBaseDamage" key found — refusing to guess where it went');
  }
  if (matches.length > 1) {
    throw new Error(
      `cfggameplay.json: "disableBaseDamage" appears ${matches.length}× — ` +
        "refusing to guess which one the server reads",
    );
  }

  const m = matches[0]!;
  if ((m[2] === "true") === wanted) return { json, changed: false };

  const from = m.index!;
  const to = from + m[0].length;
  const next = json.slice(0, from) + m[1] + String(wanted) + json.slice(to);

  // ⚠️ Guard 2, and it is not redundant with the parse above. A key matched
  // outside GeneralData produces a file that parses perfectly and leaves
  // GeneralData untouched — success by every check except the one that matters.
  // Parsing proves the file is loadable; only reading the value back proves the
  // edit did what it meant to.
  let parsed: unknown;
  try {
    parsed = JSON.parse(next);
  } catch (err) {
    throw new Error(`cfggameplay.json: the edit produced a file that does not parse (${(err as Error).message})`);
  }
  const got = (parsed as { GeneralData?: { disableBaseDamage?: unknown } })?.GeneralData?.disableBaseDamage;
  if (got !== wanted) {
    throw new Error(
      `cfggameplay.json: after the edit GeneralData.disableBaseDamage is ${JSON.stringify(got)}, ` +
        `not ${wanted} — the key that was replaced is not the one the server reads`,
    );
  }

  return { json: next, changed: true };
}
