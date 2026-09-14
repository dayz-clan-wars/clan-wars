import { safeErrorInfo } from "./commands/route.js";

/**
 * Last-resort logging for a promise nobody caught, or a throw nobody caught.
 *
 * ⚠️ This exists to SANITISE, not to survive. Node's default handler prints
 * the raw error, and a `DiscordAPIError` carries the whole failed request as
 * `err.requestBody = { files, json: body }` — for `/vault reveal` that body
 * is a clan's lock code. A postgres.js error is the same shape of problem:
 * its `.query` and `.parameters` hold the statement and its values, and
 * `/vault add` submits a code as a parameter. `safeErrorInfo` keeps the
 * diagnosis (name, message, code, status) and drops everything shaped like a
 * request or response body. Nothing else in the bot logs a raw error on a
 * path where a secret can be in scope; these two handlers were the gap.
 *
 * ⚠️ The process still dies, deliberately. Node exits on an unhandled
 * rejection by default and this does not change that: a bot that reached an
 * unhandled rejection is in a state nobody reasoned about, and `Restart=`
 * plus a fresh boot is a better answer than carrying on. Turning these into
 * log-and-continue is a real option, but it is a decision about when the bot
 * stays up — not something to smuggle in under a logging fix.
 *
 * `process.exit` rather than a rethrow: rethrowing from inside these
 * handlers gets Node to print the raw error after all, which is precisely
 * what we are here to prevent.
 */
export function installCrashHandlers(): void {
  process.on("unhandledRejection", (reason) => {
    console.error("unhandled rejection — exiting", safeErrorInfo(reason));
    process.exit(1);
  });
  process.on("uncaughtException", (err) => {
    console.error("uncaught exception — exiting", safeErrorInfo(err));
    process.exit(1);
  });
}
