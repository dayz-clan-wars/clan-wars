import crypto from "node:crypto";

// Cache files are the stage-resume mechanism, so a write that dies midway (ENOSPC, a kill) must
// never leave a truncated file at the final path, where a later run would read it as a hit. Each
// write goes to `<target>.tmp-<pid>-<random>` and is then renamed into place (atomic on one
// filesystem); a failed write removes its tmp file, best-effort.

export type AtomicFsLike = {
  renameSync: (from: string, to: string) => void;
  rmSync?: (p: string, o?: { force?: boolean }) => void;
};

function tmpPathFor(target: string): string {
  return `${target}.tmp-${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

function landAtomically(fsImpl: AtomicFsLike, target: string, write: (tmp: string) => void): void {
  const tmp = tmpPathFor(target);
  try {
    write(tmp);
    fsImpl.renameSync(tmp, target);
  } catch (err) {
    try {
      fsImpl.rmSync?.(tmp, { force: true });
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

/** `writeFileSync` to a tmp path, then rename into `target`. */
export function writeFileAtomic<D extends Buffer | string>(
  fsImpl: AtomicFsLike & { writeFileSync: (p: string, d: D) => void },
  target: string,
  data: D,
): void {
  landAtomically(fsImpl, target, (tmp) => fsImpl.writeFileSync(tmp, data));
}

/** `copyFileSync` to a tmp path, then rename into `target`. */
export function copyFileAtomic(
  fsImpl: AtomicFsLike & { copyFileSync: (src: string, dest: string) => void },
  src: string,
  target: string,
): void {
  landAtomically(fsImpl, target, (tmp) => fsImpl.copyFileSync(src, tmp));
}
