import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COMPOSE = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "docker-compose.yml"),
  "utf8",
);

/**
 * ⚠️ nginx owns :80 and :443 on the host this stack is deployed to, and serves
 * four other production sites from them. A `caddy` service in this file is a
 * request for a port that is permanently taken: the failure is a container in
 * a restart loop and a site that looks deployed.
 *
 * The compose file and the deployment topology are two statements of one fact.
 * Nothing but this test holds them together — `docker compose config` will
 * happily validate a Caddy that can never bind.
 */
describe("compose matches the single-host deployment", () => {
  it("declares no caddy service", () => {
    expect(COMPOSE).not.toMatch(/^\s{2}caddy:/m);
  });

  it("declares no caddy volumes", () => {
    expect(COMPOSE).not.toContain("caddy-data");
    expect(COMPOSE).not.toContain("caddy-config");
  });

  /**
   * ⚠️ Loopback, not 0.0.0.0. Publishing all interfaces would serve the site
   * over plain HTTP on :3020 alongside the TLS one nginx terminates — the
   * exact hazard the original "no ports mapping" comment was guarding.
   */
  it("publishes web on loopback only", () => {
    expect(COMPOSE).toContain('"127.0.0.1:3020:3000"');
    expect(COMPOSE).not.toMatch(/"0\.0\.0\.0:\d+:3000"/);
    expect(COMPOSE).not.toMatch(/"\d+:3000"/);
  });
});
