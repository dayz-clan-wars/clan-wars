import { describe, expect, it } from "vitest";
import { classifyChanges } from "../src/index";

describe("classifyChanges", () => {
  it("flags nginx and systemd config under deploy/", () => {
    // ⚠️ /etc symlinks into this tree, so these paths are live config for
    // four sites the moment the tag is checked out.
    expect(classifyChanges(["deploy/nginx/dayzclanwars.com.conf"]).touchesHostConfig).toBe(true);
    expect(classifyChanges(["deploy/systemd/clan-wars-bot.service"]).touchesHostConfig).toBe(true);
  });

  it("flags migrations", () => {
    expect(classifyChanges(["packages/db/migrations/0037_x.sql"]).touchesMigrations).toBe(true);
  });

  it("does not flag ordinary code", () => {
    const c = classifyChanges(["apps/bot/src/discord.ts", "CHANGELOG.md"]);
    expect(c.touchesHostConfig).toBe(false);
    expect(c.touchesMigrations).toBe(false);
  });

  it("does not mistake a lookalike path for the real one", () => {
    // `deployment-notes.md` is not `deploy/`, and a substring match would
    // claim nginx was reloaded when it was not.
    const c = classifyChanges(["docs/deployment-notes.md", "apps/web/deploy.ts"]);
    expect(c.touchesHostConfig).toBe(false);
  });

  it("reports both when both changed", () => {
    const c = classifyChanges(["deploy/nginx/a.conf", "packages/db/migrations/0038_y.sql"]);
    expect(c.touchesHostConfig).toBe(true);
    expect(c.touchesMigrations).toBe(true);
  });
});
