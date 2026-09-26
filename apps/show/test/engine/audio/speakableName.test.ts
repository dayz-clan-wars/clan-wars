import { describe, test, expect } from "vitest";
import { speakableName } from "../../../src/engine/audio/speakableName.js";

describe("speakableName", () => {
    test("drops the trailing Xbox digit suffix", () => {
        expect(speakableName("DarkSniper4729")).toBe("DarkSniper");
        expect(speakableName("Klug0042")).toBe("Klug");
    });
    test("de-leets interior digits", () => {
        expect(speakableName("Sn1p3r")).toBe("Sniper");
    });
    test("strips decorative wrappers and symbols", () => {
        expect(speakableName("xX_Klug_Xx")).toBe("Klug");
        expect(speakableName("xX_Sn1p3r_Xx0042")).toBe("Sniper");
    });
    test("falls back to the raw tag when nothing speakable remains", () => {
        expect(speakableName("1337")).toBe("1337");
        expect(speakableName("____")).toBe("____");
    });
    test("non-strings return empty", () => {
        expect(speakableName(null as unknown as string)).toBe("");
    });
    test("strips attached xX/Xx wrapper clusters", () => {
        expect(speakableName("XxBE4zyxX")).toBe("BEazy"); // wrappers gone, 4->a
        expect(speakableName("xXSniperXx")).toBe("Sniper");
    });
    test("does not strip a single trailing/leading x", () => {
        expect(speakableName("Max")).toBe("Max");
    });
});
