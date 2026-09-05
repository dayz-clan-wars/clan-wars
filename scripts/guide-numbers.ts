/**
 * Regenerate docs/guide-numbers.json from the field guide's numbers table.
 *
 *   pnpm guide:numbers            # reads ../field-guide/numbers.html
 *   pnpm guide:numbers <path>     # any copy of numbers.html
 *
 * ⚠️ Commit the JSON. The drift test reads the JSON, not the guide, so the
 * test is deterministic in CI, and a stale JSON is caught by the reviewer
 * diffing this file against the guide's commit — which is the point of
 * vendoring it rather than reaching across repositories at test time.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const src = process.argv[2] ?? resolve(process.cwd(), "..", "field-guide", "numbers.html");
const html = readFileSync(src, "utf8");

const ROW = /<tr><td>([^<]*)<\/td><td class="v">([^<]*)<\/td><\/tr>/gu;
const decode = (s: string) =>
  s.replace(/&rarr;/gu, "→").replace(/&ndash;/gu, "–").replace(/&amp;/gu, "&").trim();

const rows = [...html.matchAll(ROW)].map((m) => ({ label: decode(m[1]!), value: decode(m[2]!) }));
if (rows.length < 40) {
  throw new Error(`only ${rows.length} rows matched in ${src}; the table markup has changed`);
}

const out = { source: "field-guide/numbers.html", generatedAt: new Date().toISOString(), rows };
writeFileSync(resolve(process.cwd(), "docs", "guide-numbers.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`${rows.length} rows → docs/guide-numbers.json`);
