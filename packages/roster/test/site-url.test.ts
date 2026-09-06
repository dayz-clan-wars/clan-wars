import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { siteBaseUrl } from "../src/internal/site-url";

describe("siteBaseUrl", () => {
  const ORIGINAL = process.env.SITE_BASE_URL;

  beforeEach(() => {
    delete process.env.SITE_BASE_URL;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SITE_BASE_URL;
    else process.env.SITE_BASE_URL = ORIGINAL;
  });

  it("defaults to the production site when unset", () => {
    expect(siteBaseUrl()).toBe("https://dayzclanwars.com");
  });

  it("⚠️ strips a trailing slash, mirroring apps/bot/src/config.ts's handling of the same variable — every consumer concatenates its own path with no strip of its own", () => {
    process.env.SITE_BASE_URL = "https://x.com/";
    expect(siteBaseUrl()).toBe("https://x.com");
  });

  it("leaves a value with no trailing slash unchanged", () => {
    process.env.SITE_BASE_URL = "https://x.com";
    expect(siteBaseUrl()).toBe("https://x.com");
  });
});
