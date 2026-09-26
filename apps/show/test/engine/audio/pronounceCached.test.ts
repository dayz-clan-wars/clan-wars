import { describe, test, expect } from "vitest";
import type { ChatFn, ChatRequest } from "../../../src/engine/llm/openrouter.js";
import { MemoryPronunciationStore } from "../../../src/engine/audio/pronunciationStore.js";
import { resolveCachedPronouncer } from "../../../src/engine/audio/pronounceCached.js";

// Fake chat that records calls and echoes `spoken-<tag>` for each requested tag.
function pronounceChat(): ChatFn & { calls: ChatRequest[] } {
  const calls: ChatRequest[] = [];
  const fn = (async (req: ChatRequest) => {
    calls.push(req);
    const tags = JSON.parse(req.messages[1]!.content) as string[];
    const map = Object.fromEntries(tags.map((t) => [t, `spoken-${t}`]));
    return JSON.stringify(map);
  }) as ChatFn & { calls: ChatRequest[] };
  fn.calls = calls;
  return fn;
}

const base = (chat: ChatFn, extra: Partial<Parameters<typeof resolveCachedPronouncer>[0]> = {}) => ({
  store: new MemoryPronunciationStore(),
  names: [] as string[],
  overrides: {} as Record<string, string>,
  chat,
  model: "cap-model",
  ...extra,
});

describe("resolveCachedPronouncer", () => {
  test("cached tags skip the LLM; fresh tags are generated, persisted, and resolved", async () => {
    const store = new MemoryPronunciationStore();
    await store.insertMissing([{ text: "Cached1", spoken: "Cashed", source: "llm" }]);
    const chat = pronounceChat();

    const pr = await resolveCachedPronouncer(base(chat, { store, names: ["Cached1", "Fresh2"] }));

    const sent = chat.calls.flatMap((b) => JSON.parse(b.messages[1]!.content) as string[]);
    expect(sent).toEqual(["Fresh2"]); // cached one filtered out
    expect(chat.calls[0]!.model).toBe("cap-model");
    expect(pr("Cached1")).toBe("Cashed"); // from cache
    expect(pr("Fresh2")).toBe("spoken-Fresh2"); // freshly generated
    expect(await store.get(["Fresh2"])).toEqual({ Fresh2: "spoken-Fresh2" }); // persisted
  });

  test("a name already in the store is not sent to chat", async () => {
    const store = new MemoryPronunciationStore();
    await store.insertMissing([{ text: "Known", spoken: "Nown", source: "llm" }]);
    const chat = pronounceChat();
    await resolveCachedPronouncer(base(chat, { store, names: ["Known"] }));
    expect(chat.calls).toHaveLength(0);
  });

  test("no tags to generate makes no LLM call", async () => {
    const chat = pronounceChat();
    const pr = await resolveCachedPronouncer(base(chat, { names: [] }));
    expect(chat.calls).toHaveLength(0);
    expect(typeof pr).toBe("function");
  });

  test("chat throwing falls back to speakableName and does not throw", async () => {
    const chat: ChatFn = async () => {
      throw new Error("boom");
    };
    const store = new MemoryPronunciationStore();
    const pr = await resolveCachedPronouncer(base(chat, { store, names: ["DarkSniper4729"] }));
    expect(pr("DarkSniper4729")).toBe("DarkSniper"); // speakableName fallback
    expect(await store.get(["DarkSniper4729"])).toEqual({}); // nothing persisted
  });

  test("a redacted alias never reaches chat or the store; the resolver speaks it", async () => {
    const chat = pronounceChat();
    const store = new MemoryPronunciationStore();
    const pr = await resolveCachedPronouncer(
      base(chat, { store, names: ["REDACTED_PLAYER_1", "Real"] }),
    );
    const sent = chat.calls.flatMap((b) => JSON.parse(b.messages[1]!.content) as string[]);
    expect(sent).toEqual(["Real"]);
    expect(pr("REDACTED_PLAYER_1")).toBe("the player whose name we cannot say");
    expect(await store.get(["REDACTED_PLAYER_1"])).toEqual({});
  });

  test("a stored row is never overwritten by a later insertMissing with a different spoken", async () => {
    const store = new MemoryPronunciationStore();
    const chat1 = pronounceChat();
    await resolveCachedPronouncer(base(chat1, { store, names: ["Tag"] }));
    expect(await store.get(["Tag"])).toEqual({ Tag: "spoken-Tag" });

    const chat2 = jsonChatConst("different");
    const pr = await resolveCachedPronouncer(base(chat2, { store, names: ["Tag"] }));
    expect(pr("Tag")).toBe("spoken-Tag"); // the stored value wins, chat isn't even asked
    expect(await store.get(["Tag"])).toEqual({ Tag: "spoken-Tag" });
  });

  test("an override wins over a stored row and is inserted with source override only if missing", async () => {
    const store = new MemoryPronunciationStore();
    const chat = pronounceChat();
    const pr = await resolveCachedPronouncer(
      base(chat, { store, names: ["Boss"], overrides: { Boss: "The Boss" } }),
    );
    expect(chat.calls).toHaveLength(0); // nothing to generate
    expect(pr("Boss")).toBe("The Boss");
    expect(await store.get(["Boss"])).toEqual({ Boss: "The Boss" }); // inserted since missing

    // A second run with a different override does not change the stored row.
    const chat2 = pronounceChat();
    await resolveCachedPronouncer(base(chat2, { store, names: ["Boss"], overrides: { Boss: "Different" } }));
    expect(await store.get(["Boss"])).toEqual({ Boss: "The Boss" });
  });
});

function jsonChatConst(spoken: string): ChatFn {
  return async (req) => {
    const tags = JSON.parse(req.messages[1]!.content) as string[];
    return JSON.stringify(Object.fromEntries(tags.map((t) => [t, spoken])));
  };
}
