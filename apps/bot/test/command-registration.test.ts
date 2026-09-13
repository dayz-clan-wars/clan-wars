import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { GROUPS, SPECS, buildCommands } from "../src/commands/index.js";

const here = dirname(fileURLToPath(import.meta.url));

/**
 * "Parity" is only a claim unless something checks it. This file checks the
 * half that is structural: every subcommand Discord is told about has a
 * handler, and every handler is reachable by a subcommand. A command
 * registered with no handler answers a player with discord.js's default
 * failure; a handler with no command is dead code that reads as shipped.
 */
describe("command registration", () => {
  it("gives every registered subcommand a handler", () => {
    for (const group of GROUPS) {
      const json = group.command.toJSON();
      const subs = (json.options ?? []).filter((o) => o.type === 1);
      const paths = subs.length === 0 ? [json.name] : subs.map((s) => `${json.name} ${s.name}`);
      for (const path of paths) {
        expect(SPECS.has(path), `no handler for /${path}`).toBe(true);
      }
    }
  });

  it("makes every handler reachable by a registered subcommand", () => {
    const registered = new Set(
      GROUPS.flatMap((g) => {
        const json = g.command.toJSON();
        const subs = (json.options ?? []).filter((o) => o.type === 1);
        return subs.length === 0 ? [json.name] : subs.map((s) => `${json.name} ${s.name}`);
      }),
    );
    for (const path of SPECS.keys()) {
      expect(registered.has(path), `/${path} has a handler but is not registered`).toBe(true);
    }
  });

  it("stays inside Discord's limits", () => {
    const payload = buildCommands();
    expect(payload.length).toBeLessThanOrEqual(100);
    const names = payload.map((c) => c.name);
    expect(new Set(names).size, `duplicate command name in ${names.join(", ")}`).toBe(names.length);
    for (const group of GROUPS) {
      const json = group.command.toJSON();
      expect((json.options ?? []).length, `/${json.name} has too many subcommands`).toBeLessThanOrEqual(25);
    }
  });

  it("names an autocomplete source for every option marked autocomplete", () => {
    for (const group of GROUPS) {
      const json = group.command.toJSON();
      for (const sub of (json.options ?? []).filter((o) => o.type === 1)) {
        for (const opt of ((sub as { options?: { name: string; autocomplete?: boolean }[] }).options ?? [])) {
          if (!opt.autocomplete) continue;
          const spec = SPECS.get(`${json.name} ${sub.name}`);
          expect(spec?.autocomplete?.[opt.name], `/${json.name} ${sub.name} ${opt.name} has no source`).toBeTypeOf("function");
        }
      }
    }
  });
});

/**
 * Spec §1. Every reply a player sees is ephemeral, forever. A grep, not a
 * behavioural test, because the failure it guards is someone adding a NEW
 * reply path months from now and reaching for a plain `interaction.reply`.
 */
describe("commands are ephemeral", () => {
  const files = readdirSync(resolve(here, "..", "src", "commands"), { recursive: true, encoding: "utf8" })
    .filter((f) => f.endsWith(".ts"));

  it("has files to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("never sets ephemeral to anything but true", () => {
    for (const f of files) {
      const src = readFileSync(resolve(here, "..", "src", "commands", f), "utf8");
      expect(src, f).not.toMatch(/ephemeral:\s*false/u);
    }
  });

  /**
   * `route.ts` acknowledges an interaction in exactly one place, and that
   * place must carry the flag. Asserted structurally rather than by counting
   * `.reply(` calls: the router defers first and edits after, so the literal
   * string ".reply(" never appears and a count-based check would pass
   * vacuously forever.
   */
  it("acknowledges only with MessageFlags.Ephemeral", () => {
    const route = readFileSync(resolve(here, "..", "src", "commands", "route.ts"), "utf8");
    const acks = route.match(/\.(deferReply|reply)\(/gu) ?? [];
    expect(acks.length, "route.ts must acknowledge interactions").toBeGreaterThan(0);
    expect(route).toMatch(/deferReply\(\{\s*flags:\s*MessageFlags\.Ephemeral\s*\}\)/u);
    // An un-flagged acknowledgement would be a public reply.
    expect(route).not.toMatch(/\.reply\(\{(?![^}]*MessageFlags\.Ephemeral)/u);
  });
});
