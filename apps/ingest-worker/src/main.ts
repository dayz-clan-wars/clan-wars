import { readFileSync } from "node:fs";
import { createClient } from "@factions/db";
import { NitradoClient } from "@factions/nitrado";
import { loadConfig } from "./config.js";
import { ingestSweep } from "./sweep.js";
import { loadTemplate } from "./supplies.js";

const cfg = loadConfig(process.env);
const db = createClient(cfg.databaseUrl);

// Parsed ONCE at startup. A malformed template must stop the worker here,
// loudly, rather than throwing on every sweep forever.
const offsets = loadTemplate(JSON.parse(
  readFileSync(new URL("../assets/flag-supplies.template.json", import.meta.url), "utf8"),
));

// One client per service id, cached for the process lifetime. Typed to the
// concrete NitradoClient (not the narrower NitradoLike) because it also
// needs to satisfy SupplyUploader for the supply tick below.
const clients = new Map<number, NitradoClient>();
const clientFor = (serviceId: number): NitradoClient => {
  let c = clients.get(serviceId);
  if (!c) {
    c = new NitradoClient(cfg.nitradoToken, serviceId);
    clients.set(serviceId, c);
  }
  return c;
};

// ⚠️ ONE map for the whole process: the bounded per-file failure counter that
// stops a single un-ingestible file from blocking a server's live file
// forever. Resetting it per sweep would restore the permanent block.
const failures = new Map<string, number>();

const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

// Sequential by construction: the next sweep starts only after this one
// returns, so no overlap guard is needed (unlike the bot, whose timer fires
// regardless of whether the previous run finished).
for (;;) {
  const started = Date.now();
  try {
    const r = await ingestSweep(db, {
      clientFor,
      backfillBudget: cfg.backfillBudget,
      failures,
      onServerError: (serverId, err) => console.error(`ingest failed for server ${serverId}`, err),
      supplies: {
        clientFor,
        offsets,
        fileName: "faction-supplies.json",
      },
      onSupplyError: (serverId, err) => console.error(`supply tick failed for server ${serverId}`, err),
      // Only fires on an actual upload, so this stays quiet on the ticks where
      // nothing changed — which is almost all of them.
      onSupplyUploaded: (serverId, r) =>
        console.log(`supply file uploaded for server ${serverId}: ${r.factions} holding factions`),
      // ⚠️ Loud on purpose. The tick has already repaired the file by the time
      // this runs, so nothing is broken — but something outside this system
      // rewrote it, and whatever did is unlikely to have stopped at one file.
      onSupplyDrift: (serverId, d) => {
        const found = d.found
          ? `size ${d.found.size}, mtime ${new Date(d.found.modifiedAtMs).toISOString()}`
          : "no such file";
        console.error(
          `supply file on server ${serverId} was changed outside this worker — ` +
          `expected size ${d.expected.size}, mtime ${new Date(d.expected.modifiedAtMs).toISOString()}; ` +
          `found ${found}. Re-uploading.`,
        );
      },
    });
    console.log(`ingest sweep: ${r.servers} servers in ${Date.now() - started}ms`);
  } catch (err) {
    // A thrown sweep must not kill the loop and silently stop all ingest.
    console.error("ingest sweep failed", err);
  }
  await sleep(cfg.intervalSeconds * 1000);
}
