import { spawn } from "node:child_process";

/**
 * Spawn `cmd args`, optionally write `opts.input` to stdin, resolve stdout as a Buffer.
 * Rejects with an Error whose message includes the exit code and the last 2,000
 * characters of stderr. The one child-process helper every ffmpeg/rhubarb call uses —
 * KOTH had several private copies of this (`jingle.js`, `encodeMp3.js`, `compositor.js`,
 * `visemes.js`); every ported file here takes a `runImpl`-style parameter defaulting to
 * `spawnRun` instead.
 */
export type Run = (cmd: string, args: string[], opts?: { input?: Buffer }) => Promise<Buffer>;

const STDERR_TAIL = 2_000;

export const spawnRun: Run = (cmd, args, opts) => {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => stdout.push(d));
    child.stderr.on("data", (d: Buffer) => stderr.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
        return;
      }
      const tail = Buffer.concat(stderr).toString("utf8").slice(-STDERR_TAIL);
      reject(new Error(`${cmd} exited ${code}: ${tail}`));
    });
    child.stdin.on("error", () => {}); // ignore EPIPE if the child exits before we finish writing
    if (opts?.input?.length) child.stdin.write(opts.input);
    child.stdin.end();
  });
};
