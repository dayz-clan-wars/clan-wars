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
    test("converts the exact-case and ALL-CAPS forms, backticked or emphasized, to the spoken form", () => {
        const text = "Plain XxBE4zyxX, caps XXBE4ZYXX, ticked `XxBE4zyxX`, bold **XxBE4zyxX**.";
        const out = replaceNamesForSpeech(text, ["XxBE4zyxX"], () => "BEEZY");
        expect(out).not.toMatch(/be4zyx/i);                  // no raw-tag variant reaches the TTS
        expect((out.match(/BEEZY/g) || []).length).toBe(4);  // all four mentions converted
    });

    test("a tag only matches its exact case or ALL-CAPS form, never an ordinary word", () => {
        const out = replaceNamesForSpeech("he raided us. Us? US did it, and Us again", ["US"], () => "U S");
        expect(out).toBe("he raided us. Us? U S did it, and Us again");
        expect(replaceNamesForSpeech("Fishy and FISHY but not fishy", ["Fishy"], () => "Fish")).toBe("Fish and Fish but not fishy");
    });

    test("replaces in one pass: a spoken form is never rescanned for a shorter name", () => {
        const spoken: Record<string, string> = {
            REDACTED_CLAN_1: "a clan WE can't NAME on this network",
            WE: "double u ee",
            NAME: "N A M E",
        };
        const out = replaceNamesForSpeech("REDACTED_CLAN_1 raided WE", ["WE", "NAME", "REDACTED_CLAN_1"], (g) => spoken[g]!);
        expect(out).toBe("a clan WE can't NAME on this network raided double u ee");
        expect(replaceNamesForSpeech("the player whose name we cannot say", ["WE", "we"], () => "X"))
            .toBe("the player whose name X cannot say"); // exact-case "we" as a name still matches
        expect(replaceNamesForSpeech("the player whose name we cannot say", ["WE"], () => "X"))
            .toBe("the player whose name we cannot say");
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
