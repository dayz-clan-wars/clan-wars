/**
 * Decide what deploy-release.sh should do next, as JSON on stdout.
 *
 *   pnpm deploy:select            # nothing deployed yet
 *   pnpm deploy:select v1.9.0     # v1.9.0 is live
 *
 * Reads git; writes nothing. Safe to run at any time.
 */
import { execFileSync } from "node:child_process";
import { classifyChanges, selectNewestTag } from "@factions/deploy";

function git(...args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const current = process.argv[2] ?? "";

// ⚠️ --merged origin/main: a tag pushed on a branch that never landed is not
// a release, and deploying one would put unreviewed code on production.
const tags = git("tag", "--merged", "origin/main").split("\n").filter(Boolean);
const tag = selectNewestTag(tags);

let changed: string[] = [];
if (tag !== null && current !== "" && tag !== current) {
  changed = git("diff", "--name-only", `${current}..${tag}`).split("\n").filter(Boolean);
}

process.stdout.write(`${JSON.stringify({
  tag,
  current: current === "" ? null : current,
  ...classifyChanges(changed),
})}\n`);
