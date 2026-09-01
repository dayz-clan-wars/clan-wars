import { readFile } from "node:fs/promises";
import { parseAdmContent } from "./parse-adm-content.js";

/**
 * Reads one .ADM file from disk. Parsing lives in `parseAdmContent` so the
 * Nitrado path, which already holds the text, shares one implementation.
 */
export async function readAdmFile(path: string): Promise<{ bootAt: Date; lines: string[] }> {
  try {
    return parseAdmContent(await readFile(path, "utf8"));
  } catch (err) {
    // Keep the filename in the message; a bare "no header" is useless when
    // replaying a directory of 1,026 files.
    throw new Error(`${(err as Error).message} in ${path}`);
  }
}
