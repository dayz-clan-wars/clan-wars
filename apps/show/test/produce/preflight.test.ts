import { describe, it, expect } from "vitest";
import path from "node:path";
import { preflightRender, renderCacheDir } from "../../src/produce/preflight.js";
import type { Run } from "../../src/engine/run.js";

describe("renderCacheDir", () => {
  it("uses <renderDir>/.cache when SHOW_CACHE_DIR was not set", () => {
    expect(renderCacheDir({ cacheDir: "/var/lib/clan-wars-show", cacheDirSet: false }, "./out")).toBe(path.join("./out", ".cache"));
  });

  it("uses SHOW_CACHE_DIR when it was set", () => {
    expect(renderCacheDir({ cacheDir: "/srv/cache", cacheDirSet: true }, "./out")).toBe("/srv/cache");
  });
});

describe("preflightRender", () => {
  const cfg = { cacheDir: "/c", ffmpegPath: "/bin/ffmpeg", rhubarbPath: "/bin/rhubarb" };

  function harness(fail: { mkdir?: boolean; cmd?: string } = {}) {
    const calls: { cmd: string; args: string[] }[] = [];
    const made: string[] = [];
    const runImpl: Run = async (cmd, args) => {
      calls.push({ cmd, args });
      if (cmd === fail.cmd) throw new Error(`spawn ${cmd} ENOENT`);
      return Buffer.from("version 1");
    };
    const fsImpl = {
      mkdirSync: (p: string) => {
        if (fail.mkdir) throw new Error(`EACCES: permission denied, mkdir '${p}'`);
        made.push(p);
      },
    };
    return { calls, made, deps: { runImpl, fsImpl } };
  }

  it("creates the cache dir and checks both binaries run", async () => {
    const h = harness();
    await preflightRender(cfg, h.deps);
    expect(h.made).toEqual(["/c"]);
    expect(h.calls).toEqual([
      { cmd: "/bin/ffmpeg", args: ["-version"] },
      { cmd: "/bin/rhubarb", args: ["--version"] },
    ]);
  });

  it("fails naming the cache dir when it cannot be created", async () => {
    const h = harness({ mkdir: true });
    await expect(preflightRender(cfg, h.deps)).rejects.toThrow(/cache directory "\/c".*SHOW_CACHE_DIR/);
    expect(h.calls).toEqual([]);
  });

  it("fails naming ffmpeg when it does not run", async () => {
    const h = harness({ cmd: "/bin/ffmpeg" });
    await expect(preflightRender(cfg, h.deps)).rejects.toThrow(/ffmpeg.*"\/bin\/ffmpeg".*FFMPEG_PATH/);
  });

  it("fails naming rhubarb when it does not run", async () => {
    const h = harness({ cmd: "/bin/rhubarb" });
    await expect(preflightRender(cfg, h.deps)).rejects.toThrow(/rhubarb.*"\/bin\/rhubarb".*RHUBARB_PATH/i);
  });
});
