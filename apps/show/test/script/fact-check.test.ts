import { describe, it, expect, vi } from "vitest";
import { factCheck, FactCheckError, FACT_CHECK_SYSTEM } from "../../src/script/fact-check.js";

describe("factCheck", () => {
  it("sends the data and the script, and reads the errors list out of the reply", async () => {
    const generate = vi.fn(async () => 'Sure.\n{"errors":[{"line":"Boris: X.","problem":"reversed"},{"line":7}]}');
    expect(await factCheck("Boris: X.", "DATA", generate)).toEqual([{ line: "Boris: X.", problem: "reversed" }]);
    const [system, user] = generate.mock.calls[0]! as unknown as [string, string];
    expect(system).toBe(FACT_CHECK_SYSTEM);
    expect(user).toMatch(/^DATA\n\nThe script to check:\nBoris: X\.$/u);
  });

  it("drops an entry the checker cleared itself, and tolerates loose times and rounding", async () => {
    const reply = '{"errors":[{"line":"a","problem":"This is correct. No error here."},{"line":"b","problem":"two explosions, not three"}]}';
    expect(await factCheck("s", "d", async () => reply)).toEqual([{ line: "b", problem: "two explosions, not three" }]);
    expect(FACT_CHECK_SYSTEM).toMatch(/Never list a claim you checked and found correct/u);
    expect(FACT_CHECK_SYSTEM).toMatch(/within about ten percent/u);
  });

  it("reads the last errors object when the checker thinks aloud first", async () => {
    const reply = 'Checking {each} claim.\n```json\n{"errors":[{"line":"b","problem":"reversed"}]}\n```';
    expect(await factCheck("s", "d", async () => reply)).toEqual([{ line: "b", problem: "reversed" }]);
    expect(FACT_CHECK_SYSTEM).toMatch(/"A was killed by B 17 times" means B killed A 17 times/u);
  });

  it("passes a clean script", async () => {
    expect(await factCheck("s", "d", async () => '{"errors":[]}')).toEqual([]);
  });

  it("⚠️ never reads an unreadable reply as a pass", async () => {
    await expect(factCheck("s", "d", async () => "looks fine to me")).rejects.toThrow(FactCheckError);
    await expect(factCheck("s", "d", async () => '{"ok":true}')).rejects.toThrow(FactCheckError);
  });

  it("checks kill direction, superlatives and Livonia place names", () => {
    expect(FACT_CHECK_SYSTEM).toMatch(/never reversed/u);
    expect(FACT_CHECK_SYSTEM).toMatch(/longest, most, top/u);
    expect(FACT_CHECK_SYSTEM).toMatch(/Chernarus town/u);
  });
});
