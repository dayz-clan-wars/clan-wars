import { describe, it, expect } from "vitest";
import config from "../next.config";
import { GUIDE_URL } from "../lib/guide";

/**
 * ⚠️ Spec §10.2 lists `/guide` as a public route. The guide is published by
 * its own repo (`../field-guide/`, GitHub Pages, the CNAME is the host in
 * GUIDE_URL), so the site hands the request over with a permanent redirect
 * rather than carrying a copy that would drift from the authority. Pinned
 * here because a redirect is one config entry that reads as harmless to
 * delete in review — and `/guide` is a link the bot and the Discord both
 * hand out.
 */
describe("/guide redirects to the field guide", () => {
  it("names the guide host without a trailing slash", () => {
    expect(GUIDE_URL).toBe("https://fieldguide.dayzclanwars.com");
    expect(GUIDE_URL.endsWith("/")).toBe(false);
  });

  it("redirects the bare route and every subpath, permanently", async () => {
    const redirects = await config.redirects!();
    expect(redirects).toEqual([
      { source: "/guide", destination: `${GUIDE_URL}/`, permanent: true },
      { source: "/guide/:path*", destination: `${GUIDE_URL}/:path*`, permanent: true },
    ]);
  });
});
