import { describe, it, expect } from "vitest";
import { parseChangelog } from "../src/changelog";

const SAMPLE = `# Changelog

All notable changes to this project are documented in this file.

## [Unreleased]

### Added

- Something not yet released.

## [1.10.0] - 2026-09-13

### Added

- The tenth release.

### Fixed

- A thing that was broken.

## [1.9.0] - 2026-09-13

### Added

- The ninth release.

## [1.8.0] - 2026-09-13 [WITHDRAWN]

Not a release. A deliberately unhealthy build, cut to rehearse a rollback.
**Never deploy this tag.**
`;

describe("parseChangelog", () => {
  it("returns one release per version heading, skipping Unreleased", () => {
    const releases = parseChangelog(SAMPLE);

    expect(releases.map((r) => r.version)).toEqual(["1.9.0", "1.10.0"]);
  });

  it("orders by semver, not lexically", () => {
    // ⚠️ The case a string sort gets wrong: "1.10.0" < "1.9.0" lexically.
    const releases = parseChangelog(SAMPLE);

    expect(releases[0]!.version).toBe("1.9.0");
    expect(releases[1]!.version).toBe("1.10.0");
  });

  it("carries the date from the heading", () => {
    expect(parseChangelog(SAMPLE)[1]!.date).toBe("2026-09-13");
  });

  it("keeps ### subsections in the body and stops at the next ## heading", () => {
    const body = parseChangelog(SAMPLE)[1]!.body;

    expect(body).toContain("### Added");
    expect(body).toContain("### Fixed");
    expect(body).toContain("- The tenth release.");
    expect(body).not.toContain("The ninth release");
    expect(body).not.toContain("## [1.9.0]");
  });

  it("skips a [WITHDRAWN] heading", () => {
    // ⚠️ Load-bearing, and the reason the heading regex is anchored. v1.16.2
    // and v1.16.4 are real sections in this repo's CHANGELOG.md that say
    // "Not a release … Never deploy this tag" — deliberately unhealthy builds
    // cut to rehearse the deployer's rollback. Announcing one to players would
    // advertise a build that does not exist. The marker IS the per-release
    // opt-out; nothing else provides one.
    expect(parseChangelog(SAMPLE).map((r) => r.version)).not.toContain("1.8.0");
  });

  it("returns nothing for a changelog with no releases", () => {
    expect(parseChangelog("# Changelog\n\n## [Unreleased]\n\n- nothing yet\n")).toEqual([]);
  });

  it("parses the repository's own CHANGELOG.md", async () => {
    // ⚠️ The real file, not a fixture. A format change that the sample above
    // does not happen to cover would otherwise only show up in production,
    // where the symptom is a release that is silently never announced.
    const { readFile } = await import("node:fs/promises");
    const text = await readFile(new URL("../../../CHANGELOG.md", import.meta.url), "utf8");

    const releases = parseChangelog(text);

    // 26 `## [` headings minus `[Unreleased]` minus the two [WITHDRAWN] tags.
    // A floor, not an exact count: keel:release rolls [Unreleased] into a new
    // dated heading on every release, so this repo's own CHANGELOG.md gains
    // one release with every release PR. An exact toBe(23) would go red on
    // the very next one — the parser would be right and the test would be
    // wrong, which is the opposite of what this test is for.
    expect(releases.length).toBeGreaterThanOrEqual(23);
    expect(releases[0]!.version).toBe("1.0.0");
    expect(releases.map((r) => r.version)).not.toContain("1.16.2");
    expect(releases.map((r) => r.version)).not.toContain("1.16.4");
    expect(releases.every((r) => /^\d{4}-\d{2}-\d{2}$/u.test(r.date))).toBe(true);
    expect(releases.every((r) => r.body.length > 0)).toBe(true);
  });
});
