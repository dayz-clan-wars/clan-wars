import { describe, it, expect, vi } from "vitest";
import { placeBunker } from "@factions/domain";
import { stageBunker } from "../src/bunker-stage.js";

const exit = (customString: string, pos: number[], yaw: number) =>
  ({ name: "Land_Underground_Stairs_Exit", pos, ypr: [yaw, 0, 0], scale: 1, enableCEPersistency: 0, customString });
const ROOMS = JSON.stringify({ Objects: [exit("NWAF", [4765.7, 338.8, 10384.0], 149), exit("VMC", [4565.1, 317.7, 8275.3], -167)] });
const TEMPLATE = { Objects: [exit("", [2782.4, 25.9, 1195.4], 0),
  { name: "Land_Underground_Panel", pos: [2785.8, 28.2, 1196.1], ypr: [0, 0, 0], scale: 1, enableCEPersistency: 0, customString: "" }] };

function host(over: Record<string, string | undefined> = {}) {
  const files: Record<string, string | undefined> = {
    "/m/custom/keycard-rooms.json": ROOMS,
    "/m/custom/keycard-bunker-boom.json": JSON.stringify(TEMPLATE),
    "/m/custom/keycard-bunker-guns.json": JSON.stringify(TEMPLATE),
    ...over,
  };
  const uploadFile = vi.fn(async (_d: string, _n: string, _b: string) => {});
  return {
    uploadFile,
    target: {
      missionRootDir: async () => "/m",
      downloadFile: async (p: string) => { const v = files[p]; if (v === undefined) throw new Error(`404 ${p}`); return v; },
      uploadFile,
    },
  };
}

describe("stageBunker", () => {
  it("uploads the template placed on the room, as custom/bunker-online.json", async () => {
    const h = host();
    await stageBunker(h.target, { location: "nwaf", kind: "boom" });
    expect(h.uploadFile).toHaveBeenCalledTimes(1);
    const [dir, name, body] = h.uploadFile.mock.calls[0]!;
    expect([dir, name]).toEqual(["/m/custom", "bunker-online.json"]);
    expect(JSON.parse(body)).toEqual(placeBunker(TEMPLATE as never, { x: 4765.7, y: 338.8, z: 10384.0, yaw: 149 }));
  });
  for (const [what, spec, over, msg] of [
    ["a pre-bunker row with no kind", { location: "dolnik", kind: null }, {}, /no kind/],
    ["a room slug that is not a bunker room", { location: "dolnik", kind: "boom" }, {}, /dolnik is not a bunker room/],
    // ⚠️ Review focus 2: someone renamed the room in the chernarus repo.
    ["a room whose name is not in the server's rooms file", { location: "kamensk-military", kind: "boom" }, {}, /Kamensk Military.*not in .*keycard-rooms\.json/],
    ["a missing template", { location: "nwaf", kind: "guns" }, { "/m/custom/keycard-bunker-guns.json": undefined }, /keycard-bunker-guns\.json/],
    ["a missing rooms file", { location: "nwaf", kind: "boom" }, { "/m/custom/keycard-rooms.json": undefined }, /keycard-rooms\.json/],
    ["an unparseable template", { location: "nwaf", kind: "boom" }, { "/m/custom/keycard-bunker-boom.json": "{" }, /keycard-bunker-boom\.json/],
    ["a template with no stairs exit", { location: "nwaf", kind: "boom" }, { "/m/custom/keycard-bunker-boom.json": JSON.stringify({ Objects: [TEMPLATE.Objects[1]] }) }, /found 0/],
  ] as const) {
    it(`${what} throws and uploads nothing`, async () => {
      const h = host(over as Record<string, string | undefined>);
      await expect(stageBunker(h.target, spec as never)).rejects.toThrow(msg);
      expect(h.uploadFile).not.toHaveBeenCalled();
    });
  }
});
