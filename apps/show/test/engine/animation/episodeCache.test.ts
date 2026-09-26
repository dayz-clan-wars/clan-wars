import { describe, test, expect } from "vitest";
import os from "node:os";
import fsreal from "node:fs";
import pathreal from "node:path";
import {
  episodeCacheKey,
  writeEpisodeCache,
  readEpisodeCache,
  writeEpisodeVideo,
  readEpisodeVideoPath,
} from "../../../src/engine/animation/episodeCache.js";

// Ported from KOTH bot/test/animation/episodeCache.test.js at a5ef8e7. `episodeCacheKey` is a named
// change (global-context.md): KOTH keyed on a numeric `weekStartTs`; this plan keys on an ISO
// `weekStart` string with `:`/`.` replaced so the key is a safe directory name.

function memFs() {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();
  return {
    files,
    mkdirSync: (d: string) => {
      dirs.add(d);
    },
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    writeFileSync: (p: string, d: Buffer | string) => {
      files.set(p, Buffer.isBuffer(d) ? d : Buffer.from(d));
    },
    readFileSync: (p: string) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return files.get(p)!;
    },
    renameSync: (from: string, to: string) => {
      files.set(to, files.get(from)!);
      files.delete(from);
    },
  };
}

const artifacts = {
  mp3: Buffer.from([1, 2, 3]),
  segATimeline: [{ speaker: "boris", startSec: 0, endSec: 1, visemes: [] }],
  spans: { totalSec: 42, epCode: "S01E01", serverNames: ["A", "B"] },
};

describe("episodeCacheKey", () => {
  test("depends on the narrative, and the weekStart's colons/dots are replaced so the key is a safe directory name", () => {
    const a = episodeCacheKey({ weekStart: "2026-09-21T00:00:00.000Z", narrative: "x" });
    const b = episodeCacheKey({ weekStart: "2026-09-21T00:00:00.000Z", narrative: "y" });
    expect(a).not.toBe(b);
    expect(a.startsWith("2026-09-21T00-00-00-000Z-")).toBe(true);
    expect(a).not.toContain(":");
    expect(a).not.toMatch(/\.\d/); // no literal dot before the millis digits
  });
});

describe("episodeCache", () => {
  test("write then read round-trips", () => {
    const fsImpl = memFs();
    writeEpisodeCache({ fsImpl }, { cacheDir: "/c", key: "k", ...artifacts });
    const got = readEpisodeCache({ fsImpl }, { cacheDir: "/c", key: "k" });
    expect(got!.mp3).toEqual(artifacts.mp3);
    expect(got!.segATimeline).toEqual(artifacts.segATimeline);
    expect((got!.spans as { totalSec: number }).totalSec).toBe(42);
  });

  test("missing file -> null (miss, never partial)", () => {
    const fsImpl = memFs();
    writeEpisodeCache({ fsImpl }, { cacheDir: "/c", key: "k", ...artifacts });
    fsImpl.files.delete("/c/k/spans.json");
    expect(readEpisodeCache({ fsImpl }, { cacheDir: "/c", key: "k" })).toBeNull();
    expect(readEpisodeCache({ fsImpl }, { cacheDir: "/c", key: "nope" })).toBeNull();
  });
});

function tmpCache(): string {
  return fsreal.mkdtempSync(pathreal.join(os.tmpdir(), "evcache-"));
}

test("readEpisodeVideoPath returns null when absent, path when present and non-empty", () => {
  const cacheDir = tmpCache();
  try {
    expect(readEpisodeVideoPath({}, { cacheDir, key: "k1" })).toBeNull();
    fsreal.mkdirSync(pathreal.join(cacheDir, "k1"), { recursive: true });
    fsreal.writeFileSync(pathreal.join(cacheDir, "k1", "video.mp4"), Buffer.from("MP4DATA"));
    expect(readEpisodeVideoPath({}, { cacheDir, key: "k1" })).toBe(pathreal.join(cacheDir, "k1", "video.mp4"));
  } finally {
    fsreal.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("readEpisodeVideoPath returns null for a zero-byte file", () => {
  const cacheDir = tmpCache();
  try {
    fsreal.mkdirSync(pathreal.join(cacheDir, "k1"), { recursive: true });
    fsreal.writeFileSync(pathreal.join(cacheDir, "k1", "video.mp4"), Buffer.alloc(0));
    expect(readEpisodeVideoPath({}, { cacheDir, key: "k1" })).toBeNull();
  } finally {
    fsreal.rmSync(cacheDir, { recursive: true, force: true });
  }
});

test("writeEpisodeVideo copies the mp4 in and prunes OTHER keys' videos but keeps their audio", () => {
  const cacheDir = tmpCache();
  try {
    // an older episode with both audio + video cached
    fsreal.mkdirSync(pathreal.join(cacheDir, "old"), { recursive: true });
    fsreal.writeFileSync(pathreal.join(cacheDir, "old", "episode.mp3"), Buffer.from("AUDIO"));
    fsreal.writeFileSync(pathreal.join(cacheDir, "old", "video.mp4"), Buffer.from("OLDVID"));
    // the source render to cache under a new key
    const src = pathreal.join(cacheDir, "render.mp4");
    fsreal.writeFileSync(src, Buffer.from("NEWVID"));

    const dest = writeEpisodeVideo({}, { cacheDir, key: "new", videoPath: src });

    expect(dest).toBe(pathreal.join(cacheDir, "new", "video.mp4"));
    expect(fsreal.readFileSync(dest).toString()).toBe("NEWVID");
    // other key's video pruned, its audio kept
    expect(fsreal.existsSync(pathreal.join(cacheDir, "old", "video.mp4"))).toBe(false);
    expect(fsreal.existsSync(pathreal.join(cacheDir, "old", "episode.mp3"))).toBe(true);
  } finally {
    fsreal.rmSync(cacheDir, { recursive: true, force: true });
  }
});

/**
 * An fs fake for the atomic-write tests. `failOn(path)` decides which write/copy dies midway:
 * it leaves the first half of the bytes at that path (a truncated file, as on ENOSPC or a kill)
 * and then throws.
 */
function crashFs(failOn: (p: string) => boolean = () => false) {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>();
  const ops: string[] = [];
  const put = (p: string, b: Buffer) => {
    if (failOn(p)) {
      files.set(p, b.subarray(0, Math.floor(b.length / 2)));
      throw new Error(`ENOSPC: no space left on device, write '${p}'`);
    }
    files.set(p, b);
  };
  return {
    files,
    ops,
    mkdirSync: (d: string) => {
      dirs.add(d);
    },
    existsSync: (p: string) => files.has(p) || dirs.has(p),
    writeFileSync: (p: string, d: Buffer | string) => {
      ops.push(`write ${p}`);
      put(p, Buffer.isBuffer(d) ? Buffer.from(d) : Buffer.from(d));
    },
    copyFileSync: (src: string, dest: string) => {
      ops.push(`copy ${dest}`);
      put(dest, Buffer.from(files.get(src)!));
    },
    renameSync: (from: string, to: string) => {
      ops.push(`rename ${to}`);
      const b = files.get(from);
      if (!b) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, b);
    },
    rmSync: (p: string) => {
      files.delete(p);
    },
    readFileSync: (p: string) => {
      if (!files.has(p)) throw new Error("ENOENT");
      return files.get(p)!;
    },
    readdirSync: () => [] as string[],
    statSync: (p: string) => {
      const b = files.get(p);
      if (!b) throw new Error("ENOENT");
      return { size: b.length };
    },
  };
}

describe("atomic cache writes", () => {
  test("writeEpisodeCache writes each file to a tmp path and renames it in, spans.json last", () => {
    const fsImpl = crashFs();
    writeEpisodeCache({ fsImpl }, { cacheDir: "/c", key: "k", ...artifacts });
    const finals = ["/c/k/episode.mp3", "/c/k/segA-timeline.json", "/c/k/spans.json"];
    for (const f of finals) expect(fsImpl.ops).not.toContain(`write ${f}`);
    expect(fsImpl.ops.filter((o) => o.startsWith("rename "))).toEqual(finals.map((f) => `rename ${f}`));
    expect([...fsImpl.files.keys()].filter((k) => k.includes(".tmp-"))).toEqual([]);
    expect(readEpisodeCache({ fsImpl }, { cacheDir: "/c", key: "k" })).not.toBeNull();
  });

  test("a write that dies midway leaves no hit", () => {
    for (const name of ["episode.mp3", "segA-timeline", "spans.json"]) {
      const fsImpl = crashFs((p) => p.includes(name));
      expect(() => writeEpisodeCache({ fsImpl }, { cacheDir: "/c", key: "k", ...artifacts })).toThrow(/ENOSPC/);
      expect(readEpisodeCache({ fsImpl }, { cacheDir: "/c", key: "k" })).toBeNull();
    }
  });

  test("writeEpisodeVideo: a copy that dies midway leaves no cached video", () => {
    const fsImpl = crashFs((p) => p.startsWith("/c/k/"));
    fsImpl.files.set("/work/final.mp4", Buffer.from("FULL-VIDEO-BYTES"));
    expect(() => writeEpisodeVideo({ fsImpl }, { cacheDir: "/c", key: "k", videoPath: "/work/final.mp4" })).toThrow(/ENOSPC/);
    expect(readEpisodeVideoPath({ fsImpl }, { cacheDir: "/c", key: "k" })).toBeNull();
    expect([...fsImpl.files.keys()].filter((k) => k.includes(".tmp-"))).toEqual([]);
  });

  test("writeEpisodeVideo copies to a tmp path and renames it in", () => {
    const fsImpl = crashFs();
    fsImpl.files.set("/work/final.mp4", Buffer.from("FULL-VIDEO-BYTES"));
    const dest = writeEpisodeVideo({ fsImpl }, { cacheDir: "/c", key: "k", videoPath: "/work/final.mp4" });
    expect(fsImpl.ops).not.toContain(`copy ${dest}`);
    expect(fsImpl.ops).toContain(`rename ${dest}`);
    expect(fsImpl.files.get(dest)!.toString()).toBe("FULL-VIDEO-BYTES");
  });
});
