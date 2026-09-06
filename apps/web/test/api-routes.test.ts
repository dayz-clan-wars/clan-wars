import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Every write on the site is a form POST; a GET that mutates can be fired by
 * any <img> on the internet (see api/auth/logout). The auth routes and the
 * /link status poll are the only GETs.
 */
const API = join(import.meta.dirname, "..", "app", "api");
const routes = readdirSync(API, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith("route.ts")).map((f) => join(API, f));
const GET_ALLOWED = [`${sep}api${sep}auth${sep}`, `${sep}api${sep}link${sep}status${sep}`, `${sep}api${sep}link${sep}search${sep}`];

describe("api routes", () => {
  // Task 6 adds the /api/clan/* routes; un-todo this once they exist.
  it.todo("finds the clan routes", () => {
    expect(routes.some((f) => f.includes(`${sep}api${sep}clan${sep}`))).toBe(true);
  });
  it.each(routes)("%s exports POST unless it is an allowed read", (file) => {
    const text = readFileSync(file, "utf8");
    if (GET_ALLOWED.some((p) => file.includes(p))) return;
    expect(text).toMatch(/export async function POST\(/u);
    expect(text).not.toMatch(/export async function GET\(/u);
  });
});
