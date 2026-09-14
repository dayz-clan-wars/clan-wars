import { describe, it, expect, vi, afterEach } from "vitest";
import { installCrashHandlers } from "../src/crash-handlers.js";

/**
 * The two handlers exist to keep a secret out of the journal, so that is
 * what these assert — not that the process exits, which is Node's behaviour
 * and not ours to re-test.
 */
describe("crash handlers", () => {
  const added: { event: "unhandledRejection" | "uncaughtException"; fn: (...a: never[]) => void }[] = [];

  /**
   * Installs onto a captured listener list rather than the real process, so
   * a test can invoke a handler without vitest's own runner taking the exit.
   */
  function capture() {
    const on = vi.spyOn(process, "on").mockImplementation(((event: string, fn: (...a: never[]) => void) => {
      if (event === "unhandledRejection" || event === "uncaughtException") added.push({ event, fn });
      return process;
    }) as never);
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    installCrashHandlers();
    on.mockRestore();
    return { exit, err };
  }

  afterEach(() => { added.length = 0; vi.restoreAllMocks(); });

  it("registers a handler for each of the two events", () => {
    capture();
    expect(added.map((a) => a.event).sort()).toEqual(["uncaughtException", "unhandledRejection"]);
  });

  /**
   * ⚠️ The reason this file exists. `@discordjs/rest` attaches the failed
   * request to the errors it throws — `err.requestBody.json.content` — and
   * for `/vault reveal` that content is a clan's lock code. Node's default
   * handler prints the error's own enumerable properties, so an unhandled
   * rejection carrying one would put it in the journal in plain text.
   */
  it("never prints a discord REST error's request body", () => {
    const { err } = capture();
    const leak = "9182";
    const restError = Object.assign(new Error("rate limited"), {
      code: 429,
      status: 429,
      requestBody: { files: [], json: { content: `Front gate — \`${leak}\`` } },
      url: "https://discord.com/api/v10/webhooks/x/TOKEN-SHAPED-SECRET/messages/@original",
    });
    added.find((a) => a.event === "unhandledRejection")!.fn(restError as never);
    const printed = JSON.stringify(err.mock.calls);
    expect(printed).not.toContain(leak);
    expect(printed).not.toContain("TOKEN-SHAPED-SECRET");
    // The diagnosis still has to survive, or the handler is useless.
    expect(printed).toContain("rate limited");
    expect(printed).toContain("429");
  });

  /**
   * ⚠️ Same class, different driver. postgres.js errors carry `.query` and
   * `.parameters` — and `/vault add` submits a caller-chosen code as a bound
   * parameter, so a failed insert's error holds it.
   */
  it("never prints a postgres error's query or parameters", () => {
    const { err } = capture();
    const pgError = Object.assign(new Error("deadlock detected"), {
      code: "40P01",
      query: "insert into vault_locks (name, code) values ($1, $2)",
      parameters: ["Front gate", "9182"],
    });
    added.find((a) => a.event === "uncaughtException")!.fn(pgError as never);
    const printed = JSON.stringify(err.mock.calls);
    expect(printed).not.toContain("9182");
    expect(printed).not.toContain("vault_locks");
    expect(printed).toContain("deadlock detected");
  });

  it("says something useful for a rejection that is not an Error at all", () => {
    const { err } = capture();
    added.find((a) => a.event === "unhandledRejection")!.fn("just a string" as never);
    expect(JSON.stringify(err.mock.calls)).toContain("just a string");
  });
});
