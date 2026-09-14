import { loadConfig } from "./config.js";
import { start } from "./discord.js";
import { installCrashHandlers } from "./crash-handlers.js";

installCrashHandlers();

await start(loadConfig(process.env));
