import realFs from "node:fs";
import path from "node:path";
import type { StoryContext } from "../../src/story/types.js";

/**
 * In-memory fs covering every call the produce/ wiring and the engine pieces it drives make
 * (built up from the KOTH tests' `memFs` helpers). Writes stay in memory. Reads of a path never
 * written fall through to the real disk only when `readThrough` says so (the rig SVGs and fonts
 * under apps/show/assets, which the posing code needs as real SVG text).
 */
export function memFs(initial: Record<string, Buffer> = {}, readThrough: (p: string) => boolean = () => false) {
  const files = new Map<string, Buffer>(Object.entries(initial));
  const dirs = new Set<string>();
  let tmp = 0;
  const has = (p: string) => files.has(p) || dirs.has(p);
  return {
    files,
    dirs,
    existsSync: (p: string) => has(p) || (readThrough(p) && realFs.existsSync(p)),
    readFileSync: ((p: string, enc?: BufferEncoding) => {
      const b = files.get(p) ?? (readThrough(p) ? realFs.readFileSync(p) : undefined);
      if (!b) throw new Error(`ENOENT ${p}`);
      return enc ? b.toString(enc) : b;
    }) as {
      (p: string): Buffer;
      (p: string, enc: BufferEncoding): string;
    },
    writeFileSync: (p: string, d: Buffer | string) => {
      files.set(p, Buffer.isBuffer(d) ? Buffer.from(d) : Buffer.from(d));
    },
    mkdirSync: (p: string) => {
      dirs.add(p);
    },
    mkdtempSync: (prefix: string) => {
      const d = `${prefix}${++tmp}`;
      dirs.add(d);
      return d;
    },
    statSync: (p: string) => {
      const b = files.get(p);
      if (!b) throw new Error(`ENOENT ${p}`);
      return { size: b.length, mtimeMs: 0 };
    },
    copyFileSync: (src: string, dest: string) => {
      const b = files.get(src);
      if (!b) throw new Error(`ENOENT ${src}`);
      files.set(dest, Buffer.from(b));
    },
    readdirSync: (p: string) => {
      const prefix = p.endsWith(path.sep) ? p : p + path.sep;
      const out = new Set<string>();
      for (const k of [...files.keys(), ...dirs]) if (k.startsWith(prefix)) out.add(k.slice(prefix.length).split(path.sep)[0]!);
      return [...out];
    },
    rmSync: (p: string) => {
      files.delete(p);
      dirs.delete(p);
      for (const k of [...files.keys()]) if (k.startsWith(p + path.sep)) files.delete(k);
    },
    renameSync: (from: string, to: string) => {
      const b = files.get(from);
      if (!b) throw new Error(`ENOENT ${from}`);
      files.delete(from);
      files.set(to, b);
    },
    unlinkSync: (p: string) => {
      files.delete(p);
    },
  };
}

export function storyContext(over: Partial<StoryContext> = {}): StoryContext {
  return {
    week: { start: "2026-09-21T00:00:00.000Z", end: "2026-09-28T00:00:00.000Z", season: 1, episode: 3, alpha: null },
    clans: [], raids: [], flagEvents: [], friendlyFire: [], clanBeefs: [],
    players: { topKillers: [], mostDeaths: [], longestShots: [], oddDeaths: [] },
    bounties: [], koth: [], airdrops: [], previous: null,
    ...over,
  };
}
