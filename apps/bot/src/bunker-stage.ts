import { BUNKER_SPAWNER_PATH, bunkerRoom, bunkerTemplateFile, placeBunker, type AirdropSpec, type SpawnerObject } from "@factions/domain";

export type BunkerHost = {
  missionRootDir(): Promise<string>;
  downloadFile(path: string): Promise<string>;
  uploadFile(remoteDir: string, fileName: string, content: string): Promise<void>;
};

const FILE = BUNKER_SPAWNER_PATH.slice("./custom/".length);

async function readJson(host: BunkerHost, path: string): Promise<{ Objects: SpawnerObject[] }> {
  // ⚠️ The path goes into the message: it lands in the row's `detail.error`, and an
  // operator told only "404" cannot tell which of three files to put back.
  const body = await host.downloadFile(path).catch((err: unknown) => {
    throw new Error(`${path} could not be read (${err instanceof Error ? err.message : String(err)})`);
  });
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch (err) { throw new Error(`${path} did not parse (${(err as Error).message})`); }
  const objects = (parsed as { Objects?: unknown })?.Objects;
  if (!Array.isArray(objects)) throw new Error(`${path} has no Objects array`);
  return { Objects: objects as SpawnerObject[] };
}

/**
 * Build and upload `custom/bunker-online.json` for `spec` (spec §5.2): the kind's
 * template, placed on the room as the SERVER's keycard-rooms.json has it.
 *
 * ⚠️ Throws on anything it cannot do, having uploaded nothing. The caller counts
 * that as a failed enable attempt and leaves `objectSpawnersArr` alone, so the
 * spawner is never registered over a missing or stale file.
 */
export async function stageBunker(host: BunkerHost, spec: AirdropSpec): Promise<void> {
  if (spec.kind === null) throw new Error(`the event at ${spec.location} has no kind: it was decided before bunkers existed`);
  const room = bunkerRoom(spec.location);
  if (!room) throw new Error(`${spec.location} is not a bunker room`);
  const custom = `${await host.missionRootDir()}/custom`;
  const rooms = await readJson(host, `${custom}/keycard-rooms.json`);
  // ⚠️ By name, from the server's file: a room renamed in the chernarus repo fails
  // here, named, instead of being placed where the vendored copy remembers it.
  const exits = rooms.Objects.filter((o) => o.name === "Land_Underground_Stairs_Exit" && o.customString === room.name);
  if (exits.length !== 1) throw new Error(`${room.name} is not in ${custom}/keycard-rooms.json exactly once (found ${exits.length})`);
  const e = exits[0]!;
  const template = await readJson(host, `${custom}/${bunkerTemplateFile(spec.kind)}`);
  const placed = placeBunker(template, { x: e.pos[0], y: e.pos[1], z: e.pos[2], yaw: e.ypr[0] });
  await host.uploadFile(custom, FILE, JSON.stringify(placed, null, 4) + "\n");
}
