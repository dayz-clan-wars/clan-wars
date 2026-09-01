import { createClient } from "@factions/db";
import { NitradoClient } from "@factions/nitrado";
import { loadConfig } from "./config.js";
import { ingestSweep } from "./sweep.js";
import type { NitradoLike } from "./tick.js";

const cfg = loadConfig(process.env);
const db = createClient(cfg.databaseUrl);

// One client per service id, cached for the process lifetime.
const clients = new Map<number, NitradoLike>();
const clientFor = (serviceId: number): NitradoLike => {
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
    });
    console.log(`ingest sweep: ${r.servers} servers in ${Date.now() - started}ms`);
  } catch (err) {
    // A thrown sweep must not kill the loop and silently stop all ingest.
    console.error("ingest sweep failed", err);
  }
  await sleep(cfg.intervalSeconds * 1000);
}
