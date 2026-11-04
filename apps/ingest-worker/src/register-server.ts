import { createClient, servers } from "@factions/db";
import { isValidTimeZone } from "@factions/adm-parser";

/**
 * Register or update one server row.
 *
 * Deliberately separate from the worker: the row carries a credential-scoped
 * Nitrado service id and a clock offset the schema refuses to default, and
 * re-running the worker must never silently reactivate a server someone
 * deactivated.
 *
 * Usage:
 *   DATABASE_URL=... pnpm --filter @factions/ingest-worker exec tsx src/register-server.ts \
 *     --name "Clan Wars Livonia" --map livonia --service-id 1234 --offset-ms 25200000 \
 *     --time-zone America/Los_Angeles
 */
function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const databaseUrl = process.env.DATABASE_URL;
const name = arg("--name");
const map = arg("--map");
const serviceIdRaw = arg("--service-id");
const offsetRaw = arg("--offset-ms");
const active = arg("--active") !== "false";
// Optional. Omitted on a new row means no zone; omitted on an existing row
// leaves its zone alone (see the update below).
const timeZone = arg("--time-zone") ?? null;

if (!databaseUrl || !name || !map || !serviceIdRaw || !offsetRaw) {
  console.error(
    "Usage: DATABASE_URL=... pnpm --filter @factions/ingest-worker exec tsx src/register-server.ts --name <name> --map <map> " +
    "--service-id <n> --offset-ms <n> [--time-zone <IANA zone>] [--active false]\n\n" +
    "--offset-ms is milliseconds to ADD to this server's local ADM time to get UTC.\n" +
    "Measured production values: chernarus 14400000 (+4h), livonia and sakhal 25200000 (+7h).\n" +
    "It has no default: a wrong offset stores every timestamp hours off while every\n" +
    "count-based check stays green.\n\n" +
    "--time-zone is the IANA zone the server's clock follows (e.g. America/Los_Angeles).\n" +
    "Give it for any server that observes daylight saving: ingest then converts with\n" +
    "the zone's rules and --offset-ms is kept only as the fallback value.\n" +
    "Re-running without it keeps a zone already set; clear one in SQL, deliberately.",
  );
  process.exit(1);
}

const nitradoServiceId = Number(serviceIdRaw);
const clockOffsetMs = Number(offsetRaw);
if (!Number.isSafeInteger(nitradoServiceId) || !Number.isSafeInteger(clockOffsetMs)) {
  console.error("--service-id and --offset-ms must both be integers.");
  process.exit(1);
}
if (timeZone !== null && !isValidTimeZone(timeZone)) {
  console.error(`--time-zone ${JSON.stringify(timeZone)} is not an IANA time zone (e.g. America/Los_Angeles).`);
  process.exit(1);
}

const db = createClient(databaseUrl);
const [row] = await db.insert(servers)
  .values({ name, map, clockOffsetMs, timeZone, nitradoServiceId, active })
  .onConflictDoUpdate({
    target: [servers.name, servers.map],
    // ⚠️ The zone is written only when given. Re-registering a DST server to
    // change its service id must not quietly put it back on the fixed offset,
    // which is the exact failure the zone exists to end.
    set: { clockOffsetMs, nitradoServiceId, active, ...(timeZone !== null ? { timeZone } : {}) },
  })
  .returning();

console.log(`server ${row!.id}: ${row!.name} (${row!.map}) service ${row!.nitradoServiceId}, ` +
  `time zone ${row!.timeZone ?? "none (fixed offset)"}, active=${row!.active}`);
process.exit(0);
