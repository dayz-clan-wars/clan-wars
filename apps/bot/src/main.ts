import { loadConfig } from "./config.js";
import { start } from "./discord.js";

await start(loadConfig(process.env));
