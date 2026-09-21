import { airdropSpawnerPath, type AirdropSpec } from "@factions/domain";

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
// The match is textual, not JSON-aware — it finds bytes to splice, never the
// authority on the current value; the same scope note events-xml.ts carries
// for its own `[^>]*` bounding.
const KEY_RE = /("disableBaseDamage"\s*:\s*)(true|false)/g;

export function setBaseDamageDisabled(json: string, wanted: boolean): { json: string; changed: boolean } {
  // Guard: the input itself must be valid. A file that is already broken is not
  // one we should be splicing into and re-uploading. Keep the parsed result —
  // it is the only trustworthy source for "is this already in the wanted
  // state", because the regex below cannot tell GeneralData's key apart from
  // an identically-named one that has drifted somewhere else in the file.
  let input: unknown;
  try {
    input = JSON.parse(json);
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

  // The no-op decision — and every other decision below — comes from the
  // parsed GeneralData value, never from the regex match: a key that appears
  // exactly once but has drifted outside GeneralData still passes the two
  // guards above, so only this check catches it. Read it as absent (missing,
  // wrong type, or simply not under GeneralData) and throw, the same as a
  // literally-missing key — "the key the server reads" means GeneralData's,
  // not any key with this name anywhere in the file.
  const current = (input as { GeneralData?: { disableBaseDamage?: unknown } })?.GeneralData?.disableBaseDamage;
  if (typeof current !== "boolean") {
    throw new Error(
      `cfggameplay.json: no "disableBaseDamage" key found under GeneralData.disableBaseDamage — ` +
        "refusing to guess where the key the server reads went",
    );
  }

  if (current === wanted) return { json, changed: false };

  const m = matches[0]!;
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

/** The array body, bounded by its own brackets. Textual, like KEY_RE above. */
const SPAWNERS_RE = /("objectSpawnersArr"\s*:\s*\[)([^\]]*)(\])/g;
/** What marks an element as this feature's — see `airdropSpawnerPath`. */
const AIRDROP_MARK = "/airdrop-";

/** Is this array-body line an element, rather than the blank after `[` or the indent before `]`? */
const isEntry = (line: string) => line.trim().startsWith('"');

/**
 * Set which airdrop spawner, if any, `WorldsData.objectSpawnersArr` registers,
 * returning the new document and whether anything actually changed.
 *
 * ⚠️ A targeted splice, NEVER a parse-and-reserialize, for the reason
 * `setBaseDamageDisabled` gives above: the live file is tab-indented with a
 * specific key order, and a round trip rewrites all 4,450 bytes. Only the lines
 * inside this one array are touched; every byte outside comes back identical.
 *
 * ⚠️ Same refuse-rather-than-guess discipline, and for the same reason: this is
 * the file whose corruption stops the server BOOTING, for every player. Refusing
 * costs one event; the next slot recomputes and retries.
 */
export function setAirdropSpawner(json: string, spec: AirdropSpec | null): { json: string; changed: boolean } {
  let input: unknown;
  try {
    input = JSON.parse(json);
  } catch (err) {
    throw new Error(`cfggameplay.json: input did not parse — refusing to edit it (${(err as Error).message})`);
  }

  // ⚠️ The parsed array is the authority on the current state, never the regex:
  // the regex finds bytes to splice and cannot tell WorldsData's key from one that
  // has drifted elsewhere in the file.
  const current = (input as { WorldsData?: { objectSpawnersArr?: unknown } })?.WorldsData?.objectSpawnersArr;
  if (!Array.isArray(current) || current.some((e) => typeof e !== "string")) {
    throw new Error(
      "cfggameplay.json: WorldsData.objectSpawnersArr is missing or is not an array of strings — " +
        "refusing to guess where the list the server reads went",
    );
  }

  const present = (current as string[]).filter((e) => e.includes(AIRDROP_MARK));
  if (present.length > 1) {
    throw new Error(
      `cfggameplay.json: objectSpawnersArr registers ${present.length}× airdrop spawners — ` +
        "refusing to guess which one is live",
    );
  }

  const wanted = spec ? airdropSpawnerPath(spec) : null;
  if ((present[0] ?? null) === wanted) return { json, changed: false };

  const matches = [...json.matchAll(SPAWNERS_RE)];
  if (matches.length !== 1) {
    throw new Error(
      `cfggameplay.json: "objectSpawnersArr" appears ${matches.length}× — ` +
        "refusing to guess which one the server reads",
    );
  }

  const m = matches[0]!;
  const [, head, body, tail] = m as unknown as [string, string, string, string];
  const lines = body.split("\n");
  const kept = lines.filter((l) => !l.includes(AIRDROP_MARK));
  const firstEntry = kept.findIndex(isEntry);
  const indent = (kept.find(isEntry) ?? '\t\t\t"').match(/^\s*/)![0];

  let next = kept;
  if (wanted) {
    const line = `${indent}"${wanted}"`;
    next = firstEntry === -1
      // An empty array: the new element is the only one, and the blank line after
      // `[` plus the indent before `]` are all that is around it.
      ? [kept[0] ?? "", line, kept[kept.length - 1] ?? ""]
      : [...kept.slice(0, firstEntry), line, ...kept.slice(firstEntry)];
  }

  // ⚠️ Commas are rebuilt across the element lines, not left where they fell.
  // Deleting the LAST element otherwise leaves the one before it ending in `,`
  // directly in front of `]` — a file that does not parse, which is exactly the
  // failure this whole module exists to avoid.
  const entries = next.filter(isEntry);
  let seen = 0;
  const rebuilt = next.map((l) => {
    if (!isEntry(l)) return l;
    seen += 1;
    return l.replace(/,\s*$/, "") + (seen < entries.length ? "," : "");
  });

  const from = m.index!;
  const nextJson = json.slice(0, from) + head + rebuilt.join("\n") + tail + json.slice(from + m[0].length);

  // ⚠️ Guard 2, not redundant with the parse above, and it is the same one
  // setBaseDamageDisabled carries: parsing proves the file is loadable, and only
  // reading the value back proves the edit did what it meant to.
  let parsed: unknown;
  try {
    parsed = JSON.parse(nextJson);
  } catch (err) {
    throw new Error(`cfggameplay.json: the edit produced a file that does not parse (${(err as Error).message})`);
  }
  const got = (parsed as { WorldsData?: { objectSpawnersArr?: string[] } })?.WorldsData?.objectSpawnersArr ?? [];
  const after = got.filter((e) => e.includes(AIRDROP_MARK));
  if (after.length !== (wanted ? 1 : 0) || (wanted && after[0] !== wanted)) {
    throw new Error(
      `cfggameplay.json: after the edit objectSpawnersArr holds ${JSON.stringify(after)}, ` +
        `not ${wanted ? JSON.stringify([wanted]) : "[]"} — the array that was edited is not the one the server reads`,
    );
  }

  // ⚠️ The airdrop subset above is only half of "the array holds what was
  // intended" (spec §5). The splice works on LINES, so two array elements sharing
  // one line — which a reformat by Nitrado's web editor, a prettifier or a
  // `livonia` Release can produce at any time — make removing the drop take its
  // line-mate with it. The result parses, the airdrop check passes, and
  // `teleports.json`, `faction-supplies.json` or `admin-castle.json` is silently
  // gone, with nothing level-triggering it back.
  const othersBefore = (current as string[]).filter((e) => !e.includes(AIRDROP_MARK));
  const othersAfter = got.filter((e) => !e.includes(AIRDROP_MARK));
  if (othersBefore.length !== othersAfter.length || othersBefore.some((e, i) => e !== othersAfter[i])) {
    throw new Error(
      `cfggameplay.json: after the edit objectSpawnersArr's other entries are ${JSON.stringify(othersAfter)}, ` +
        `not ${JSON.stringify(othersBefore)} — the edit changed a spawner it does not own`,
    );
  }

  return { json: nextJson, changed: true };
}
