import { describe, it, expect, vi } from "vitest";
import { createModerator, ModerationError, MODERATION_SYSTEM } from "../../src/screening/moderate.js";
import type { ChatFn } from "../../src/engine/llm/openrouter.js";

const chatReturning = (content: string) => vi.fn<ChatFn>(async () => content);

describe("createModerator", () => {
  it("sends indexed items and maps results back in input order", async () => {
    const chat = chatReturning('{"results":[{"i":1,"block":true,"reason":"hate"},{"i":0,"block":false,"reason":""}]}');
    const moderate = createModerator({ chat, model: "m" });
    await expect(moderate(["The Cocks", "bad"])).resolves.toEqual([{ block: false, reason: "" }, { block: true, reason: "hate" }]);
    const req = chat.mock.calls[0]![0];
    expect(req.responseFormat).toBe("json_object");
    expect(JSON.parse(req.messages[1]!.content)).toEqual([{ i: 0, text: "The Cocks" }, { i: 1, text: "bad" }]);
  });

  it("makes no call for nothing", async () => {
    const chat = chatReturning("{}");
    await expect(createModerator({ chat, model: "m" })([])).resolves.toEqual([]);
    expect(chat).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "I cannot help with that"],
    ["no results array", '{"ok":true}'],
    ["a skipped item", '{"results":[{"i":0,"block":false,"reason":""}]}'],
    ["a non-boolean block", '{"results":[{"i":0,"block":"no"},{"i":1,"block":false}]}'],
  ])("warns: fails closed on %s", async (_label, content) => {
    await expect(createModerator({ chat: chatReturning(content), model: "m" })(["a", "b"])).rejects.toThrow(ModerationError);
  });

  it("the moderation prompt allows crude humour and names the things it blocks", () => {
    expect(MODERATION_SYSTEM).toContain("The Cocks");
    expect(MODERATION_SYSTEM).toMatch(/Nazi/u);
    expect(MODERATION_SYSTEM).not.toMatch(/faction/iu);
    expect(MODERATION_SYSTEM).not.toContain("—");
  });
});
