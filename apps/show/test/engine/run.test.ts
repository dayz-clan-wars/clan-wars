import { describe, it, expect } from "vitest";
import { spawnRun } from "../../src/engine/run.js";

describe("spawnRun", () => {
  it("resolves stdout on success", async () => {
    const out = await spawnRun("node", ["-e", "process.stdout.write('hi')"]);
    expect(out.toString()).toBe("hi");
  });

  it("rejects with the exit code and stderr on failure", async () => {
    await expect(
      spawnRun("node", ["-e", "console.error('bad'); process.exit(3)"]),
    ).rejects.toThrow(/3/);
    await expect(
      spawnRun("node", ["-e", "console.error('bad'); process.exit(3)"]),
    ).rejects.toThrow(/bad/);
  });
});
