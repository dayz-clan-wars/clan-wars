import { createClient, servers } from "@factions/db";

/**
 * Register or update one server row.
 *
 * Deliberately separate from the worker: the row carries a credential-scoped
 * Nitrado service id and a clock offset the schema refuses to default, and
 * re-running the worker must never silently reactivate a server someone
 * deactivated.
 *
 * Usage:
 *   DATABASE_URL=... pnpm exec tsx scripts/register-server.ts \
 *     --name "Clan Wars Livonia" --map livonia --service-id 1234 --offset-ms 25200000
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

if (!databaseUrl || !name || !map || !serviceIdRaw || !offsetRaw) {
  console.error(
    "Usage: DATABASE_URL=... tsx scripts/register-server.ts --name <name> --map <map> " +
    "--service-id <n> --offset-ms <n> [--active false]\n\n" +
    "--offset-ms is milliseconds to ADD to this server's local ADM time to get UTC.\n" +
    "Measured production values: chernarus 14400000 (+4h), livonia and sakhal 25200000 (+7h).\n" +
    "It has no default: a wrong offset stores every timestamp hours off while every\n" +
    "count-based check stays green.",
  );
  process.exit(1);
}

const nitradoServiceId = Number(serviceIdRaw);
const clockOffsetMs = Number(offsetRaw);
if (!Number.isSafeInteger(nitradoServiceId) || !Number.isSafeInteger(clockOffsetMs)) {
  console.error("--service-id and --offset-ms must both be integers.");
  process.exit(1);
}

const db = createClient(databaseUrl);
const [row] = await db.insert(servers)
  .values({ name, map, clockOffsetMs, nitradoServiceId, active })
  .onConflictDoUpdate({
    target: [servers.name, servers.map],
    set: { clockOffsetMs, nitradoServiceId, active },
  })
  .returning();

console.log(`server ${row!.id}: ${row!.name} (${row!.map}) service ${row!.nitradoServiceId}, active=${row!.active}`);
process.exit(0);
