import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const COMPOSE = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "docker-compose.yml"),
  "utf8",
);

/**
 * ⚠️ nginx owns :80 and :443 on the host this stack is deployed to, and serves
 * three other production sites from them. A `caddy` service in this file is a
 * request for a port that is permanently taken: the failure is a container in
 * a restart loop and a site that looks deployed. So is any OTHER service in
 * this file publishing a host port nginx already owns — a `caddy:` name check
 * alone would pass right through `web` growing a `ports: ["80:80"]` entry,
 * which is the actual hazard.
 *
 * The compose file and the deployment topology are two statements of one fact.
 * Nothing but this test holds them together — `docker compose config` will
 * happily validate a container that can never bind.
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

  /**
   * ⚠️ This is the assertion that actually catches the stated hazard. A
   * `caddy` name check does nothing to stop `web` (or anything else in this
   * file) from growing a second `ports:` entry like `"80:80"` — nginx owns
   * that port on the host, so any container publishing it is a guaranteed
   * bind failure at best and a stolen request at worst. No host port mapping
   * anywhere in this file may target :80 or :443.
   */
  it("publishes no host port on :80 or :443 anywhere in the file", () => {
    expect(COMPOSE).not.toMatch(/"[^"]*:80"/);
    expect(COMPOSE).not.toMatch(/"[^"]*:443"/);
  });
});
