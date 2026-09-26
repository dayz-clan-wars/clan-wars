import { describe, test, expect } from "vitest";
import { parseDialogue } from "../../../src/engine/audio/parseDialogue.js";

describe("parseDialogue", () => {
    test("splits Boris/Pavel turns and normalizes the speaker", () => {
        expect(parseDialogue("Boris: hi there\nPAVEL: bye now")).toEqual([
            { speaker: "Boris", text: "hi there" },
            { speaker: "Pavel", text: "bye now" }
        ]);
    });
    test("tolerates bold markdown labels and appends continuation lines", () => {
        expect(parseDialogue("**Boris:** line one\nstill boris\n**Pavel:** line two")).toEqual([
            { speaker: "Boris", text: "line one still boris" },
            { speaker: "Pavel", text: "line two" }
        ]);
    });
    test("ignores preamble before the first label and empty turns", () => {
        expect(parseDialogue("intro junk\nBoris: real\nPavel:   ")).toEqual([
            { speaker: "Boris", text: "real" }
        ]);
    });
});
