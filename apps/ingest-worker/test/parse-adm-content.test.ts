import { describe, it, expect } from "vitest";
import { parseAdmContent } from "../src/parse-adm-content.js";

const HEADER = "AdminLog started on 2026-07-22 at 07:01:37";

describe("parseAdmContent", () => {
  it("reads the boot instant from the header", () => {
    const { bootAt } = parseAdmContent(`${HEADER}\n07:52:16 | something`);
    expect(bootAt.toISOString()).toBe("2026-07-22T07:01:37.000Z");
  });

  it("drops blank lines so lineIndex is an ordinal over real lines", () => {
    // ⚠️ This indexing is already persisted: raw_lines rows and
    // adm_files.lines_ingested from Plan 1 onward all count non-blank lines.
    // Changing it would invalidate every row written so far.
    const { lines } = parseAdmContent(`${HEADER}\n\n07:52:16 | a\n   \n07:52:17 | b\n`);
    expect(lines).toEqual([HEADER, "07:52:16 | a", "07:52:17 | b"]);
  });

  it("handles CRLF line endings", () => {
    const { lines } = parseAdmContent(`${HEADER}\r\n07:52:16 | a\r\n`);
    expect(lines).toEqual([HEADER, "07:52:16 | a"]);
  });

  it("needs no trailing-empty-line guard, because blanks are already gone", () => {
    // one-life pops one phantom trailing element before counting. Here the
    // filter removes every blank, so a file ending in a newline yields the
    // same count as one that does not — and the persisted cursor stays
    // aligned as the live file grows.
    const withNewline = parseAdmContent(`${HEADER}\n07:52:16 | a\n`);
    const without = parseAdmContent(`${HEADER}\n07:52:16 | a`);
    expect(withNewline.lines.length).toBe(without.lines.length);
  });

  it("rejects content with no boot header", () => {
    // Without it no line can be given an absolute timestamp, so the file is
    // unusable rather than partially usable.
    expect(() => parseAdmContent("07:52:16 | orphan line")).toThrow(/AdminLog started on/);
  });

  it("drops the final line when told to and the text ends mid-line", () => {
    // ⚠️ The live file is downloaded while the server appends to it, so the
    // last byte can land mid-line. That fragment must not be stored: doing so
    // advances the cursor past it, and the complete version can never be
    // written afterwards.
    const { lines } = parseAdmContent(`${HEADER}\n07:52:16 | a\n07:52:17 | trunc`, {
      dropPartialTrailingLine: true,
    });
    expect(lines).toEqual([HEADER, "07:52:16 | a"]);
  });

  it("keeps the final line when the text ends in a newline", () => {
    // A newline proves the line is whole, so nothing is dropped even with the
    // option on.
    const { lines } = parseAdmContent(`${HEADER}\n07:52:16 | a\n`, {
      dropPartialTrailingLine: true,
    });
    expect(lines).toEqual([HEADER, "07:52:16 | a"]);
  });

  it("keeps the final line by default even without a trailing newline", () => {
    // ⚠️ Default OFF. For a finished file the last line is real, and dropping
    // it would lose a line permanently.
    const { lines } = parseAdmContent(`${HEADER}\n07:52:16 | a`);
    expect(lines).toEqual([HEADER, "07:52:16 | a"]);
  });
});
