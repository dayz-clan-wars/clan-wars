import { readFile } from "node:fs/promises";
import { parseBootHeader } from "@factions/adm-parser";

/**
 * Reads one .ADM file. The boot header names the file's start instant; without it
 * no line in the file can be given an absolute timestamp, so the file is rejected.
 */
export async function readAdmFile(path: string): Promise<{ bootAt: Date; lines: string[] }> {
  const text = await readFile(path, "utf8");
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);

  for (const line of lines) {
    const boot = parseBootHeader(line);
    if (boot) return { bootAt: boot, lines };
  }
  throw new Error(`No "AdminLog started on" header found in ${path}`);
}
