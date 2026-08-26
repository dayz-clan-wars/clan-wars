import { createClient } from "@factions/db";
import { runProjector } from "./run.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("Set DATABASE_URL.");
  process.exit(1);
}

const applied = await runProjector(createClient(DATABASE_URL));
console.log(`projected ${applied} events`);
process.exit(0);
