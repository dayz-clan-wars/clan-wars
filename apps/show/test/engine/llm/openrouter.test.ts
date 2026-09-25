import { describe, it, expect, vi } from "vitest";
import { createChat, parseJsonObject, OpenRouterError } from "../../../src/engine/llm/openrouter.js";

const ok = (content: unknown) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

describe("createChat", () => {
  it("posts model, messages and response_format, and returns the content", async () => {
    const fetchImpl = vi.fn(async () => ok("hello"));
    const chat = createChat({ apiKey: "k", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(chat({ model: "m", messages: [{ role: "user", content: "hi" }], responseFormat: "json_object" })).resolves.toBe("hello");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(String(init.body))).toEqual({ model: "m", messages: [{ role: "user", content: "hi" }], response_format: { type: "json_object" } });
  });

  it("throws on a non-2xx and on an empty reply", async () => {
    const bad = createChat({ apiKey: "k", fetchImpl: (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch });
    await expect(bad({ model: "m", messages: [] })).rejects.toThrow(OpenRouterError);
    const empty = createChat({ apiKey: "k", fetchImpl: (async () => ok("  ")) as unknown as typeof fetch });
    await expect(empty({ model: "m", messages: [] })).rejects.toThrow(/no content/u);
  });
});

describe("parseJsonObject", () => {
  it("reads bare JSON, fenced JSON, and JSON with prose around it", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(parseJsonObject('Sure! {"a":1} Hope that helps.')).toEqual({ a: 1 });
  });
  it("throws when there is no JSON object", () => {
    expect(() => parseJsonObject("no json here")).toThrow(SyntaxError);
  });
});
