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
    test("throws, naming the character count, when the raw script is over maxChars", () => {
        const long = "x".repeat(3000);
        const turns = [
            { speaker: "Boris" as const, text: long },
            { speaker: "Pavel" as const, text: long }, // pushes the raw total to 6000
            { speaker: "Boris" as const, text: "tail" }
        ];
        expect(() => buildDialogueScript(turns, { ...opts, maxChars: 4800 })).toThrow(/6004 characters.*4800/);
        expect(() => buildDialogueScript([{ speaker: "Boris", text: "x".repeat(6001) }], opts)).toThrow(/6001 characters/);
    });
    test("measures the cap on the raw text, so name expansion never drops a turn", () => {
        // 60 turns of 99 raw characters = 5,940, under the cap; each alias expands by 20+ characters.
        const turns = Array.from({ length: 60 }, (_, i) => ({
            speaker: (i % 2 ? "Pavel" : "Boris") as "Boris" | "Pavel",
            text: `REDACTED_PLAYER_1 ${"y".repeat(99 - "REDACTED_PLAYER_1 ".length - 3)} ${String(i).padStart(2, "0")}`,
        }));
        expect(turns.reduce((n, t) => n + t.text.length, 0)).toBeLessThan(6000);
        const out = buildDialogueScript(turns, {
            ...opts,
            gamertags: ["REDACTED_PLAYER_1"],
            pronounce: () => "the player whose name we cannot say",
        });
        expect(out).toHaveLength(60);
        expect(out.reduce((n, i) => n + i.text.length, 0)).toBeGreaterThan(6000);
        expect(out[59]!.text.endsWith(" 59")).toBe(true);
    });
    test("does not truncate a 5,900-character narrative by default (cap is 6,000)", () => {
        const long = "x".repeat(5900);
        const out = buildDialogueScript([{ speaker: "Boris", text: long }], opts);
        expect(out).toHaveLength(1);
        expect(out[0]!.text).toHaveLength(5900);
    });
});
