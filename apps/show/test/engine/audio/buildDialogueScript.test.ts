import { describe, test, expect } from "vitest";
import { buildDialogueScript } from "../../../src/engine/audio/buildDialogueScript.js";

const opts = { gamertags: ["DarkSniper4729"], borisVoiceId: "bV", pavelVoiceId: "pV" };

describe("buildDialogueScript", () => {
    test("maps speaker to voice and speakable-izes gamertags", () => {
        const turns = [
            { speaker: "Boris" as const, text: "DarkSniper4729 went off!" },
            { speaker: "Pavel" as const, text: "barely." }
        ];
        expect(buildDialogueScript(turns, opts)).toEqual([
            { text: "DarkSniper went off!", voice_id: "bV" },
            { text: "barely.", voice_id: "pV" }
        ]);
    });
    test("drops empty turns", () => {
        expect(buildDialogueScript([{ speaker: "Boris", text: "   " }], opts)).toEqual([]);
    });
    test("uses a provided pronounce fn for names", () => {
        const out = buildDialogueScript(
            [{ speaker: "Boris", text: "XxBE4zyxX dropped him" }],
            { ...opts, gamertags: ["XxBE4zyxX"], pronounce: () => "Beezy" }
        );
        expect(out[0]!.text).toBe("Beezy dropped him");
    });
    test("speaks every mention — including a CAPS or backticked emphasis repeat", () => {
        const out = buildDialogueScript(
            [{ speaker: "Boris", text: "First XxBE4zyxX, then XXBE4ZYXX again, and `XxBE4zyxX`!" }],
            { ...opts, gamertags: ["XxBE4zyxX"], pronounce: () => "Beezy" }
        );
        expect(out[0]!.text).toBe("First Beezy, then Beezy again, and Beezy!"); // backticks stripped, all spoken
    });
    test("caps cumulative text under maxChars (provider request limit), dropping the tail", () => {
        const long = "x".repeat(3000);
        const turns = [
            { speaker: "Boris" as const, text: long },
            { speaker: "Pavel" as const, text: long }, // would push total to 6000
            { speaker: "Boris" as const, text: "tail" }
        ];
        const out = buildDialogueScript(turns, { ...opts, maxChars: 4800 });
        expect(out).toHaveLength(1);
        expect(out.reduce((n, i) => n + i.text.length, 0)).toBeLessThanOrEqual(4800);
    });
    test("does not truncate a 5,900-character narrative by default (cap is 6,000)", () => {
        const long = "x".repeat(5900);
        const out = buildDialogueScript([{ speaker: "Boris", text: long }], opts);
        expect(out).toHaveLength(1);
        expect(out[0]!.text).toHaveLength(5900);
    });
});
