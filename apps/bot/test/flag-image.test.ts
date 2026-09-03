import { describe, it, expect } from "vitest";
import { flagImageResolver } from "../src/flag-image.js";

describe("flagImageResolver", () => {
  it("builds a URL under /flags/ named for the texture", () => {
    const resolve = flagImageResolver("https://dayzclanwars.com");
    expect(resolve("Flag_Wolf")).toBe("https://dayzclanwars.com/flags/Flag_Wolf.png");
  });

  it("⚠️ uses our texture name for every flag, including Sakhal", () => {
    // The wiki calls Sakhal's image Sakhal_flag.PNG, but that inconsistency is
    // absorbed at fetch time in apps/web. The bot carries no alias table, and
    // adding one here would be a second place for the same fact to live.
    const resolve = flagImageResolver("https://dayzclanwars.com");
    expect(resolve("Flag_Sakhal")).toBe("https://dayzclanwars.com/flags/Flag_Sakhal.png");
  });

  it("⚠️ strips a trailing slash rather than emitting a double one", () => {
    // A base URL copied from a browser usually has one. Harmless on most
    // servers, not on all, and the symptom is a missing thumbnail nobody
    // connects to a stray character in an env var.
    const resolve = flagImageResolver("https://dayzclanwars.com/");
    expect(resolve("Flag_Wolf")).toBe("https://dayzclanwars.com/flags/Flag_Wolf.png");
  });

  it("returns null for every texture when no base URL is configured", () => {
    const resolve = flagImageResolver(undefined);
    expect(resolve("Flag_Wolf")).toBeNull();
    expect(resolve("Flag_Sakhal")).toBeNull();
  });
});
