import { describe, test, expect } from "vitest";
import { boldHostNames, backtickNames, formatBanter, replaceNames, replaceNamesForSpeech } from "../../../src/engine/llm/formatBanter.js";

describe("boldHostNames", () => {
    test("uppercases and bolds host mentions", () => {
        expect(boldHostNames("Boris: hi\nPavel: bye")).toBe("**BORIS**: hi\n**PAVEL**: bye");
    });
    test("normalizes existing bold/case, idempotent", () => {
        expect(boldHostNames("**Boris** and PAVEL and *pavel*")).toBe("**BORIS** and **PAVEL** and **PAVEL**");
        expect(boldHostNames("**BORIS**")).toBe("**BORIS**");
    });
    test("does not touch other words", () => {
        expect(boldHostNames("the borisovich hill")).toBe("the borisovich hill"); // \b prevents partial
    });
});

describe("backtickNames", () => {
    test("backticks known gamertags, longest-first, no partial/double", () => {
        expect(backtickNames("PlayerX farmed Player and PlayerXTRA", ["Player", "PlayerX"])).toBe(
            "`PlayerX` farmed `Player` and PlayerXTRA"
        );
    });
    test("does not double-wrap already-backticked", () => {
        expect(backtickNames("`PlayerX` and PlayerX", ["PlayerX"])).toBe("`PlayerX` and `PlayerX`");
    });
    test("handles names with regex special chars", () => {
        expect(backtickNames("gg [KOS]Bob.exe", ["[KOS]Bob"])).toBe("gg `[KOS]Bob`.exe");
    });
});

describe("formatBanter", () => {
    test("combines host caps and gamertag backticks", () => {
        expect(formatBanter("Boris: PlayerX won, Pavel", ["PlayerX"])).toBe("**BORIS**: `PlayerX` won, **PAVEL**");
    });
});

describe("replaceNames", () => {
    test("replaces known names via the render fn, longest-first, no partial/double", () => {
        const out = replaceNames("PlayerX and Player and PlayerXTRA", ["Player", "PlayerX"], (g) => `<${g}>`);
        expect(out).toBe("<PlayerX> and <Player> and PlayerXTRA");
    });
});

describe("replaceNamesForSpeech", () => {
    test("converts every occurrence — any case, backticked, or emphasized — to the spoken form", () => {
        const text = "Plain XxBE4zyxX, caps XXBE4ZYXX, lower xxbe4zyxx, ticked `XxBE4zyxX`, bold **XxBE4zyxX**.";
        const out = replaceNamesForSpeech(text, ["XxBE4zyxX"], () => "BEEZY");
        expect(out).not.toMatch(/be4zyx/i);                  // no raw-tag variant reaches the TTS
        expect((out.match(/BEEZY/g) || []).length).toBe(5);  // all five mentions converted
    });

    test("render is always given the canonical name, even for a CAPS/backtick variant", () => {
        const seen: string[] = [];
        replaceNamesForSpeech("caps XXBE4ZYXX and `XxBE4zyxX`", ["XxBE4zyxX"], (g) => { seen.push(g); return "Beezy"; });
        expect(seen).toEqual(["XxBE4zyxX", "XxBE4zyxX"]);    // spoken form stays the frozen one
    });

    test("does not match inside larger words; longest name wins on overlap", () => {
        expect(replaceNamesForSpeech("Players and PlayerXTRA", ["Player"], (g) => `<${g}>`))
            .toBe("Players and PlayerXTRA");
        expect(replaceNamesForSpeech("go X3LittleRed go", ["Red", "X3LittleRed"], (g) => `<${g}>`))
            .toBe("go <X3LittleRed> go");
    });
});
