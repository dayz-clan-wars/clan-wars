/**
 * Queue an announcement for every released version that does not have one.
 *
 *   DATABASE_URL=postgres://... pnpm release:sync
 *   DATABASE_URL=postgres://... pnpm release:sync --dry-run
 *
 * The backfill, the per-deploy hook and the repair tool, all one call. It is
 * idempotent: a version already in `release_announcements` is left alone, so
 * running it twice queues nothing the second time.
 *
 * ⚠️ Inserts in ASCENDING semver order, one statement at a time, because the
 * bot posts by insert id. A batch insert would leave the order to the database.
 *
 * ⚠️ Reads `CHANGELOG.md` from the working tree. Run from the checkout whose
 * release you mean to announce — `deploy-release.sh` calls it after moving the
 * tree to the new tag, so it sees the new section.
 *
 * ⚠️ Refuses a DATABASE_URL whose database is not `factions_live` unless
 * `--allow-test-db` is passed — same guard as `scripts/wipe.ts`, for the same
 * reason: the target must never be a typo.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createClient, releaseAnnouncements } from "@factions/db";
import { parseChangelog } from "@factions/deploy";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const allowTestDb = args.includes("--allow-test-db");

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set.");
}
if (!allowTestDb && !url.endsWith("/factions_live")) {
  throw new Error(
    `DATABASE_URL does not end in /factions_live (got: ${url}). ` +
      "Pass --allow-test-db to run against a non-production database.",
  );
}

const changelogPath = fileURLToPath(new URL("../CHANGELOG.md", import.meta.url));
const releases = parseChangelog(readFileSync(changelogPath, "utf8"));
if (releases.length === 0) {
  console.warn(`release:sync: no releases found in ${changelogPath}; nothing to queue.`);
  process.exit(0);
}

/**
 * The tag's subject line, or null when it carries nothing beyond the version.
 *
 * ⚠️ Never throws. A changelog section written before its tag exists is a
 * normal state during a release, and an untitled announcement is a much better
 * outcome than a deploy-time crash in the bookkeeping block.
 */
function tagSubject(version: string): string | null {
  try {
    const subject = execFileSync("git", ["tag", "-l", "--format=%(contents:subject)", `v${version}`], {
      encoding: "utf8",
      cwd: fileURLToPath(new URL("..", import.meta.url)),
    }).trim();
    if (subject === "" || subject === `v${version}`) return null;
    return subject;
  } catch {
    return null;
  }
}

const db = createClient(url);

const existing = new Set(
  (await db.select({ version: releaseAnnouncements.version }).from(releaseAnnouncements))
    .map((r) => r.version),
);

let queued = 0;
for (const release of releases) {
  if (existing.has(release.version)) continue;

  const title = tagSubject(release.version);
  if (dryRun) {
    console.log(`DRY: would queue ${release.version} — ${title ?? "(no title)"} (${release.body.length} chars)`);
    queued += 1;
    continue;
  }

  await db.insert(releaseAnnouncements).values({
    version: release.version,
    releasedAt: new Date(`${release.date}T00:00:00Z`),
    title,
    body: release.body,
  }).onConflictDoNothing({ target: releaseAnnouncements.version });
  console.log(`release:sync: queued ${release.version} — ${title ?? "(no title)"}`);
  queued += 1;
}

console.log(
  queued === 0
    ? "release:sync: nothing to queue; every release is already announced or queued."
    : `release:sync: ${queued} release(s) ${dryRun ? "would be " : ""}queued.`,
);
await db.$client.end();
process.exit(0);
