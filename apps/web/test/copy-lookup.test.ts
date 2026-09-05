import { describe, it, expect } from "vitest";
import { lookupCopy } from "../lib/copy-lookup";

describe("lookupCopy", () => {
  const table = { hello: "Hello!" };

  it("returns the value for a real key", () => {
    expect(lookupCopy(table, "hello")).toBe("Hello!");
  });

  it("misses on __proto__", () => {
    expect(lookupCopy(table, "__proto__")).toBeUndefined();
  });

  it("misses on toString", () => {
    expect(lookupCopy(table, "toString")).toBeUndefined();
  });

  it("misses on constructor", () => {
    expect(lookupCopy(table, "constructor")).toBeUndefined();
  });
});
