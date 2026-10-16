/**
 * An operator starts a clan's flag change, skipping the leader and the 30-day
 * rebrand cooldown. A dry run unless `--apply` is passed.
 *
 *   DATABASE_URL=postgres://... pnpm flag:change --server 1 --tag VOLK --flag Flag_Wolf [--apply]
 *
 * Everything after the start is the ordinary rebrand (spec
 * docs/superpowers/specs/2026-10-13-clan-rebrand-flag-design.md): the clan's
 * channel is told, the kit delivers the flag at the next restart, a member must
 * raise it at home within 24 hours or it lapses, and the old flag is held for
 * 3 days. Completing it does NOT restart the clan's own rebrand cooldown.
 *
 * ⚠️ Refuses a DATABASE_URL that does not end in `/factions_live` unless
 * `--allow-test-db` is passed — same guard as `scripts/wipe.ts`.
 */
import { createClient } from "@factions/db";
import { adminFlagChange } from "../apps/bot/src/admin-flag-change.js";

const args = process.argv.slice(2);

const USAGE = "usage: flag:change --server <id> --tag <TAG> --flag <Flag_X> [--apply] [--allow-test-db]";
function usageError(message: string): never {
  console.error(`${message}\n${USAGE}`);
  process.exit(2);
}
function arg(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
}

const serverArg = arg("server");
if (!serverArg || !/^\d+$/u.test(serverArg)) {
  usageError(`--server is missing or not a positive integer (got: ${serverArg ?? "nothing"})`);
}
const tag = arg("tag");
if (!tag) usageError("--tag is required.");
const texture = arg("flag");
if (!texture) usageError("--flag is required (a class name, e.g. Flag_Wolf).");

const apply = args.includes("--apply");
const allowTestDb = args.includes("--allow-test-db");

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set.");
}
if (!allowTestDb && !url.endsWith("/factions_live")) {
  throw new Error("DATABASE_URL does not end in /factions_live. Pass --allow-test-db to run against a non-production database.");
}

const db = createClient(url);
const result = await adminFlagChange(db, { serverId: Number(serverArg), tag, texture, at: new Date(), apply });
console.log(JSON.stringify(result));
await db.$client.end();
if (result.outcome !== "flag-pending" && result.outcome !== "dry-run") process.exit(1);
