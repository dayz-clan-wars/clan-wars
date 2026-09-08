#!/usr/bin/env node
//
// apps/web/scripts/refresh-map-places.mjs — regenerates lib/map-places.json from
// DZMap's upstream location data (the same source as the mirrored tiles).
//
//
// Run by hand after a DayZ terrain update, on the same cadence as deploy/mirror-tiles.sh
// — place names change with the game, not with our releases:
//
//   node apps/web/scripts/refresh-map-places.mjs            # current pinned version
//   node apps/web/scripts/refresh-map-places.mjs 1.30-1     # after a DayZ update
//
// ⚠️ FINDING THE VERSION SEGMENT. The URL is
// `https://static.xam.nu/dayz/json/<map>/<version>-<iteration>.json` and the host answers
// EVERY path with `200` and a zero-byte body — a wrong version looks like a successful
// fetch of an empty file, not a 404. That is why `assertNonEmpty` below is not paranoia.
// The live pair is embedded in dayz.xam.nu's own JS bundle; to re-derive it:
//
//   curl -s https://dayz.xam.nu/ | grep -oE '/js/bundle[^"]+'      # find the bundle
//   curl -s https://dayz.xam.nu/<bundle> | grep -o '"chernarusplus":{"v":"[^"]*","i":[0-9]*}'
//
// which yields e.g. {"v":"1.29","i":7} ⇒ version segment `1.29-7`.
//
// NOTE the map key mismatch: Livonia's data is published under `livonia`, while our
// `servers.map` codename (and the tile directory) is `enoch`. The output is keyed by OUR
// codename, so nothing downstream has to know about this.
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const VERSION = process.argv[2] ?? "1.29-7";
// [our servers.map codename, DZMap's publishing name]
const MAPS = [
  ["enoch", "livonia"],
];

/** Lowercase source name → display casing. Every word, including after a `(` or `-`. */
function titleCase(raw) {
  // U+0307 COMBINING DOT ABOVE rides on the `i` of `i̇turup` in the source data; upper-casing
  // that sequence produces a stray floating dot, so it is dropped before casing.
  const clean = raw.normalize("NFC").replace(/̇/g, "");
  return clean.replace(/(^|[\s(\-])(\p{Ll})/gu, (_m, lead, ch) => lead + ch.toUpperCase());
}

function assertNonEmpty(text, url) {
  // static.xam.nu answers an unknown path with 200 + an empty body, so a stale version
  // segment would otherwise silently write a file with zero places for that map.
  if (text.trim().length === 0) {
    throw new Error(`empty body from ${url} — the version segment "${VERSION}" is probably stale (see the header comment)`);
  }
}

const out = {};
for (const [codename, upstream] of MAPS) {
  const url = `https://static.xam.nu/dayz/json/${upstream}/${VERSION}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → HTTP ${res.status}`);
  const text = await res.text();
  assertNonEmpty(text, url);
  const locations = JSON.parse(text).markers?.locations;
  if (!Array.isArray(locations) || locations.length === 0) {
    throw new Error(`${url} has no markers.locations array`);
  }
  // `p` is ALREADY a Leaflet CRS.Simple latLng on the same zoom-6 pyramid our tiles use —
  // it is passed through untouched, never re-projected. `s[0]` is the latin-script name
  // (later entries are cyrillic and transliterated search aliases we do not need).
  out[codename] = locations
    .map((l) => ({ kind: l.w, lat: l.p[0], lng: l.p[1], name: titleCase(l.s[0]) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  console.log(`${codename}: ${out[codename].length} places`);
}

const dest = join(dirname(fileURLToPath(import.meta.url)), "..", "lib", "map-places.json");
await writeFile(dest, JSON.stringify(out, null, 1) + "\n");
console.log(`wrote ${dest}`);
