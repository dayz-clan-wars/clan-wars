import path from "node:path";

/**
 * ⚠️ The root `pnpm run show` runs the CLI with apps/show as its cwd, so a relative
 * `--special apps/show/specials/x` would resolve to apps/show/apps/show/... . pnpm puts the
 * directory it was invoked from in INIT_CWD; paths are read against that, as the operator typed them.
 */
export function fromInvocationDir(p: string, env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  return path.resolve(env.INIT_CWD || cwd, p);
}
