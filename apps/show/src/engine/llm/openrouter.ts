export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };
export type ChatRequest = { model: string; messages: ChatMessage[]; responseFormat?: "json_object"; temperature?: number };
export type ChatFn = (req: ChatRequest) => Promise<string>;

export class OpenRouterError extends Error {}

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

/** One OpenRouter chat completion. Throws on any failure; callers decide what failure means. */
export function createChat(deps: { apiKey: string; fetchImpl?: typeof fetch }): ChatFn {
  const fetchImpl = deps.fetchImpl ?? fetch;
  return async (req) => {
    const res = await fetchImpl(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${deps.apiKey}`, "x-title": "Clan Wars show" },
      body: JSON.stringify({
        model: req.model,
        messages: req.messages,
        ...(req.responseFormat ? { response_format: { type: req.responseFormat } } : {}),
        ...(req.temperature === undefined ? {} : { temperature: req.temperature }),
      }),
    });
    if (!res.ok) throw new OpenRouterError(`openrouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
    const content = data.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim() === "") throw new OpenRouterError("openrouter reply had no content");
    return content;
  };
}

/**
 * A JSON object out of a model reply. Anthropic models behind OpenRouter wrap JSON in a
 * ``` fence even when `json_object` is requested (the KOTH bot learned this in 87ce0b1),
 * and sometimes add a sentence around it. Throws SyntaxError when there is no object.
 */
export function parseJsonObject(content: string): unknown {
  let s = content.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/iu);
  if (fence) s = fence[1]!.trim();
  try {
    return JSON.parse(s);
  } catch {
    const start = s.indexOf("{");
    const end = s.lastIndexOf("}");
    if (start !== -1 && end > start) return JSON.parse(s.slice(start, end + 1));
    throw new SyntaxError("reply was not JSON");
  }
}
