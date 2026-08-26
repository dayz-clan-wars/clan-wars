import { describe, it, expect } from "vitest";
import { parseExportLine, groupExportByFile } from "../src/replay-export.js";

const L1 = '[Livonia] 2026-07-23T17:21:40Z  DayZServer_X1_x64_2026-07-23_09-01-42.ADM:151  |  10:21:40 | Player "XxBE4zyxX" (id=D34AD4C2D9A2D1068C2B4971CAA01177C20B24C1 pos=<2990.4, 1138.3, 448.0>) has raised Flag_Livonia on TerritoryFlag at <2991.569092, 447.946503, 1138.587646>';
const L2 = '[Sakhal] 2026-08-02T02:12:44Z  DayZServer_X1_x64_2026-08-01_19-01-26.ADM:25  |  19:12:44 | Player "Popin 0ps" (id=7D7BE4A8627CF9B969DA293B3A72F3369DFD8D8E pos=<12470.7, 2386.4, 9.5>) placed Flag Pole Kit<TerritoryFlagKit>';

describe("parseExportLine", () => {
  it("splits map, timestamp, filename, line index and verbatim content", () => {
    const r = parseExportLine(L1);
    expect(r?.map).toBe("livonia");
    expect(r?.occurredAt.toISOString()).toBe("2026-07-23T17:21:40.000Z");
    expect(r?.filename).toBe("DayZServer_X1_x64_2026-07-23_09-01-42.ADM");
    expect(r?.lineIndex).toBe(151);
    expect(r?.content.startsWith("10:21:40 | Player")).toBe(true);
  });

  it("preserves the full flag clause in the verbatim content", () => {
    expect(parseExportLine(L1)?.content).toContain("at <2991.569092, 447.946503, 1138.587646>");
  });

  it("returns null for the export's comment header", () => {
    expect(parseExportLine("# DayZ One Life — raw ADM log export")).toBeNull();
  });
});

describe("groupExportByFile", () => {
  it("groups lines by source file and derives bootAt from the earliest line", () => {
    const g = groupExportByFile([L1, L2]);
    expect(g.size).toBe(2);
    const liv = g.get("DayZServer_X1_x64_2026-07-23_09-01-42.ADM");
    expect(liv?.map).toBe("livonia");
    expect(liv?.bootAt.toISOString()).toBe("2026-07-23T09:01:42.000Z");
  });

  it("derives bootAt from the filename timestamp, not the line time", () => {
    const g = groupExportByFile([L2]);
    expect(g.get("DayZServer_X1_x64_2026-08-01_19-01-26.ADM")?.bootAt.toISOString())
      .toBe("2026-08-01T19:01:26.000Z");
  });
});
