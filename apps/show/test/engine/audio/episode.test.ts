import { describe, it, expect } from "vitest";
import { loadOrBuildSegment } from "../../../src/engine/audio/episode.js";
import type { FsLike } from "../../../src/engine/audio/jingle.js";

function memFs(initial: Record<string, Buffer> = {}): FsLike {
  const files = new Map(Object.entries(initial));
  return {
    existsSync: (p) => files.has(p),
    readFileSync: (p) => files.get(p) as Buffer,
    writeFileSync: (p, b) => files.set(p, Buffer.from(b)),
    mkdirSync: () => undefined,
  };
}

describe("loadOrBuildSegment", () => {
  it("null srcPath -> null (segment omitted)", async () => {
    const r = await loadOrBuildSegment({
      srcPath: null,
      fsImpl: memFs(),
      kind: "intro",
      key: null,
      build: async () => Buffer.from([1]),
    });
    expect(r).toBeNull();
  });

  it("builds + caches on miss, reuses on hit", async () => {
    const fsImpl = memFs({ "/bed.wav": Buffer.from([9]) });
    let builds = 0;
    const opts = {
      srcPath: "/bed.wav",
      fsImpl,
      kind: "intro",
      key: "k1",
      build: async () => {
        builds++;
        return Buffer.from([2, 2]);
      },
    };
    expect([...(await loadOrBuildSegment(opts))!]).toEqual([2, 2]);
    await loadOrBuildSegment(opts);
    expect(builds).toBe(1);
  });

  it("build failure -> null (best-effort)", async () => {
    const fsImpl = memFs({ "/bed.wav": Buffer.from([9]) });
    const r = await loadOrBuildSegment({
      srcPath: "/bed.wav",
      fsImpl,
      kind: "intro",
      key: "k",
      build: async () => {
        throw new Error("boom");
      },
    });
    expect(r).toBeNull();
  });
});
