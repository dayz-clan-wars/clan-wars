import { readFileSync } from "node:fs";
import { createClient } from "@factions/db";
import { NitradoClient } from "@factions/nitrado";
import { loadConfig } from "./config.js";
import { ingestSweep } from "./sweep.js";
import { loadTemplate } from "./supplies.js";
import { loadTravelTemplate } from "./travel.js";

const cfg = loadConfig(process.env);
const db = createClient(cfg.databaseUrl);

// Parsed ONCE at startup. A malformed template must stop the worker here,
// loudly, rather than throwing on every sweep forever.
const offsets = loadTemplate(JSON.parse(
  readFileSync(new URL("../assets/flag-supplies.template.json", import.meta.url), "utf8"),
));

// The fast-travel config, same treatment: a broken template stops the worker here.
const travelTemplate = loadTravelTemplate(JSON.parse(
  readFileSync(new URL("../assets/teleport-hub.template.json", import.meta.url), "utf8"),
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
        console.log(`supply file uploaded for server ${serverId}: ${r.factions} supplied clans, ${r.flagsOnly} flags-only`),
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
      // ⚠️ The file the mod reads for fast travel. Same name it has on the
      // server today (pra-teleport-hub.json in the mission's custom dir); the
      // template is that file verbatim, so with no active clan the upload is
      // a no-op change.
      travel: {
        clientFor,
        template: travelTemplate,
        fileName: "pra-teleport-hub.json",
      },
      // ⚠️ The third projected file, and inert until an operator adds
      // ./custom/booster-kits.json to cfggameplay.json's objectSpawnersArr —
      // see docs/deploy/2026-09-19-booster-kits.md. Until then the worker
      // uploads a file the server ignores, which is safe.
      boosterKits: {
        clientFor,
        fileName: "booster-kits.json",
      },
      onBoosterKitError: (serverId, err) => console.error(`booster kit tick failed for server ${serverId}`, err),
      onBoosterKitUploaded: (serverId, r) =>
        console.log(`booster kit file uploaded for server ${serverId}: ${r.kits} kits (takes effect at the next server restart)`),
      onBoosterKitDrift: (serverId, d) => {
        const found = d.found ? `size ${d.found.size}, mtime ${new Date(d.found.modifiedAtMs).toISOString()}` : "no such file";
        console.error(
          `booster kit file on server ${serverId} was changed outside this worker — ` +
          `expected size ${d.expected.size}, mtime ${new Date(d.expected.modifiedAtMs).toISOString()}; found ${found}. Re-uploading.`,
        );
      },
      // ⚠️ Inert until an operator adds ./custom/awards.json to
      // cfggameplay.json's objectSpawnersArr (docs/deploy/2026-09-22-awards.md).
      awards: { clientFor, fileName: "awards.json" },
      onAwardError: (serverId, err) => console.error(`award tick failed for server ${serverId}`, err),
      onAwardUploaded: (serverId, r) =>
        console.log(`award file for server ${serverId}: ${r.awards} award(s)${r.uploaded ? ", uploaded (takes effect at the next restart)" : ""}${r.stamped ? `, ${r.stamped} clock(s) started` : ""}`),
      onAwardDropped: (serverId, ids) =>
        console.warn(`award file for server ${serverId}: grant(s) ${ids.map((i) => `#${i}`).join(", ")} left out — a pick is no longer in awards.json, or the award key is unknown. Their clocks keep running.`),
      onAwardDrift: (serverId, d) => {
        const found = d.found ? `size ${d.found.size}, mtime ${new Date(d.found.modifiedAtMs).toISOString()}` : "no such file";
        console.error(
          `award file on server ${serverId} was changed outside this worker — ` +
          `expected size ${d.expected.size}, mtime ${new Date(d.expected.modifiedAtMs).toISOString()}; found ${found}. Re-uploading.`,
        );
      },
      // The in-game name for the site's server strip. A failure keeps the
      // last name stored and is only logged.
      hostnames: { clientFor },
      onHostnameError: (serverId, err) => console.error(`hostname read failed for server ${serverId}`, err),
      devices: { clientFor },
      onDeviceError: (serverId, err) => console.error(`device lookup failed for server ${serverId}:`, err),
      onTravelError: (serverId, err) => console.error(`travel tick failed for server ${serverId}`, err),
      onTravelUploaded: (serverId, r) =>
        console.log(`travel file uploaded for server ${serverId}: ${r.poles} active clan poles (takes effect at the next server restart)`),
      onTravelDrift: (serverId, d) => {
        const found = d.found ? `size ${d.found.size}, mtime ${new Date(d.found.modifiedAtMs).toISOString()}` : "no such file";
        console.error(
          `travel file on server ${serverId} was changed outside this worker — ` +
          `expected size ${d.expected.size}, mtime ${new Date(d.expected.modifiedAtMs).toISOString()}; found ${found}. Re-uploading.`,
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
