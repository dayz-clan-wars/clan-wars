import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { GET } from "../app/api/og/achievement/[key]/route";

/**
 * Renders one card for real — next/og's satori + resvg run in Node — so a
 * font that fails to load, a CSS property satori rejects, or an <svg> it
 * cannot draw fails here rather than as a 500 under Discord's crawler.
 */
describe("the share card renders", () => {
  const params = (key: string) => ({ params: Promise.resolve({ key }) });
  it("a known key to a 1200×630 PNG", async () => {
    const res = await GET(new Request("https://dayzclanwars.com/api/og/achievement/champions?gamertag=DeadeyeDan&tag=WLF&earned=2026-09-12"), params("champions"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
    const png = Buffer.from(await res.arrayBuffer());
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    // IHDR: width and height are the first two big-endian ints after the chunk header.
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    if (process.env.SHARE_CARD_OUT) writeFileSync(process.env.SHARE_CARD_OUT, png);
  }, 20_000);
  it("an unknown key to a 404", async () => {
    const res = await GET(new Request("https://dayzclanwars.com/api/og/achievement/nope"), params("nope"));
    expect(res.status).toBe(404);
  });
});
