import { describe, it, expect } from "vitest";
import { advance } from "../src/match.js";

const SEQ = ["EmoteSalute", "EmoteClap", "EmoteDance"];

describe("advance", () => {
  it("advances on the expected token", () => {
    expect(advance(SEQ, 0, "EmoteSalute")).toEqual({ index: 1, complete: false });
  });

  it("holds on an unexpected token instead of resetting", () => {
    expect(advance(SEQ, 1, "EmoteShrug")).toEqual({ index: 1, complete: false });
  });

  it("holds when the token is a LATER member of the sequence", () => {
    // Order is the proof. Performing step 3 while step 2 is pending must not skip ahead.
    expect(advance(SEQ, 1, "EmoteDance")).toEqual({ index: 1, complete: false });
  });

  it("completes on the final token", () => {
    expect(advance(SEQ, 2, "EmoteDance")).toEqual({ index: 3, complete: true });
  });

  it("stays complete-safe past the end", () => {
    expect(advance(SEQ, 3, "EmoteDance")).toEqual({ index: 3, complete: true });
  });

  it("never completes an empty sequence by accident", () => {
    expect(advance([], 0, "EmoteDance")).toEqual({ index: 0, complete: true });
  });
});
