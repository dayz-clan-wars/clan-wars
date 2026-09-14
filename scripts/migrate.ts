/**
 * Apply pending schema migrations — as a deliberate, checked deploy step.
 *
 *   DATABASE_URL=postgres://... pnpm db:migrate                       # dry run
 *   DATABASE_URL=postgres://... pnpm db:migrate --apply --production  # live
 *
 * ⚠️ Nothing applies migrations automatically. Not the bot, not the site, not
 * a container entrypoint. The targeted-linking and dormancy runbooks both
 * depend on stop-then-migrate, and a service that migrates itself can never
 * satisfy that. This script is the only migration path, and a human runs it.
 *
 * It is a DRY RUN unless `--apply` is passed: it prints the exact journal tags
 * it would apply and exits without writing. That is the pre-check the dormancy
 * runbook performed by hand with `select count(*), max(created_at)`, and it is
 * safe to run against production at any time.
 *
 * The production guard runs BOTH ways, unlike `pnpm wipe`/`pnpm launch` (which
 * only refuse to leave production). Applying to `factions_live` requires
 * `--production`, AND `--production` at any other database is refused — so the
 * flag cannot be carried by muscle memory onto a database it did not mean.
 *
 * Exit codes: 0 done (or dry run), 1 refused/inconsistent, 2 usage error.
 */
import { createClient, planMigrations, readAppliedState, readJournal, runMigrations } from "@factions/db";

const LIVE_DATABASE = "factions_live";
const USAGE = "usage: DATABASE_URL=... pnpm db:migrate [--apply] [--production]";

function usageError(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}
/** A refusal unwinds to the single exit point below, so the pool still closes. */
class Refusal extends Error {}
function refuse(message: string): never {
  throw new Refusal(message);
}

const args = process.argv.slice(2);
const unknown = args.filter((a) => a !== "--apply" && a !== "--production");
if (unknown.length > 0) usageError(`unrecognised argument(s): ${unknown.join(" ")}`);
const apply = args.includes("--apply");
const production = args.includes("--production");

const url = process.env.DATABASE_URL;
if (!url) usageError("DATABASE_URL is not set.");

/** Host and database only — DATABASE_URL carries the password, and this prints to a deploy log. */
function describeTarget(raw: string): { label: string; database: string } {
  try {
    const parsed = new URL(raw);
    const database = parsed.pathname.replace(/^\//u, "");
    return { label: `${parsed.hostname}:${parsed.port || "5432"}/${database}`, database };
  } catch {
    usageError("DATABASE_URL is not a valid URL.");
  }
}
const { label, database } = describeTarget(url);
const isLive = database === LIVE_DATABASE;

if (production && !isLive) {
  usageError(
    `--production was passed but DATABASE_URL names ${JSON.stringify(database)}, not ${LIVE_DATABASE}. ` +
    "Point at production or drop the flag — do not do both halves separately.",
  );
}
if (apply && isLive && !production) {
  usageError(`Refusing to apply to ${LIVE_DATABASE} without --production.`);
}

const journal = readJournal();
const db = createClient(url);

/** Returns when there is nothing more to do; throws `Refusal` when it must not proceed. */
async function main(): Promise<void> {
  const before = await readAppliedState(db);
  const plan = planMigrations(journal, before);

  console.log(`target:  ${label}`);
  console.log(`journal: ${journal.length} entries, newest ${journal[journal.length - 1]?.tag ?? "(none)"}`);
  console.log(`applied: ${before.count}, newest created_at ${before.maxCreatedAt ?? "(none)"}`);

  if (!plan.ok) refuse(`\nREFUSING (${plan.code}): ${plan.message}`);

  if (plan.pending.length === 0) {
    console.log("pending: none — already up to date.");
    return;
  }

  console.log(`pending: ${plan.pending.length}`);
  for (const entry of plan.pending) console.log(`  ${entry.tag}`);

  if (!apply) {
    console.log("\nDry run — nothing was applied. Re-run with --apply to apply the migrations above.");
    return;
  }

  await runMigrations(db);

  // ⚠️ Re-read rather than trust the migrator's silence. It reports neither
  // what it applied nor that it applied anything, so this is the only evidence
  // the deploy step produces that the plan above is what actually happened.
  const after = await readAppliedState(db);
  const expectedCount = plan.appliedCount + plan.pending.length;
  const expectedWhen = plan.pending[plan.pending.length - 1]!.when;
  if (after.count !== expectedCount || after.maxCreatedAt !== expectedWhen) {
    refuse(
      "\nAPPLIED, BUT THE RESULT IS NOT WHAT WAS PLANNED. " +
      `Expected ${expectedCount} rows with newest created_at ${expectedWhen}; ` +
      `found ${after.count} with ${after.maxCreatedAt ?? "(none)"}. Inspect before running anything else.`,
    );
  }
  console.log(`\nApplied ${plan.pending.length}. Now at ${after.count} of ${journal.length}.`);
}

try {
  await main();
} catch (err) {
  console.error(err instanceof Refusal ? err.message : err);
  process.exitCode = 1;
} finally {
  await db.$client.end();
}
