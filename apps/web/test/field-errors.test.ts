import { describe, it, expect } from "vitest";
import { FIELD_FOR, fieldError } from "../lib/field-errors";
import { RESULT_COPY } from "../lib/clan-copy";
import { VAULT_RESULT_COPY } from "../lib/vault-copy";

describe("field errors", () => {
  it("every code that names a field is a code some table has copy for", () => {
    for (const code of Object.keys(FIELD_FOR)) {
      expect(RESULT_COPY[code] ?? VAULT_RESULT_COPY[code], code).toBeTruthy();
    }
  });
  it("returns the field and its sentence", () => {
    expect(fieldError("rename.tag-taken", RESULT_COPY)).toEqual({ field: "tag", message: RESULT_COPY["rename.tag-taken"] });
    expect(fieldError("add.bad-code", VAULT_RESULT_COPY)?.field).toBe("code");
  });
  it("is null for a whole-action outcome, an unknown code, or none", () => {
    expect(fieldError("rename.cooldown", RESULT_COPY)).toBeNull();
    expect(fieldError("nope", RESULT_COPY)).toBeNull();
    expect(fieldError(undefined, RESULT_COPY)).toBeNull();
  });
  it("misses on a prototype key", () => {
    expect(fieldError("__proto__", RESULT_COPY)).toBeNull();
    expect(fieldError("constructor", RESULT_COPY)).toBeNull();
  });
});
