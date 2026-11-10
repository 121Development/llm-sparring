import { describe, expect, it } from "vitest";
import { GptError } from "../src/core/provider.js";
import { ApiKeyProvider, extractText } from "../src/providers/apiKey.js";

type Call = { url: string; init: RequestInit };

function mockFetch(responses: (Response | Error | (() => Response | Promise<Response>))[]) {
  const calls: Call[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r() : r.clone();
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

const okBody = (text: string) => ({
  status: "completed",
  output: [
    { type: "reasoning", summary: [] },
    { type: "message", role: "assistant", content: [{ type: "output_text", text }] },
  ],
});

const provider = (fetchFn: typeof fetch, extra = {}) =>
  new ApiKeyProvider({ apiKey: "sk-test-123456", model: "gpt-test", fetch: fetchFn, retryDelayMs: 1, ...extra });

async function codeOf(p: Promise<unknown>) {
  try {
    await p;
    return "no error";
  } catch (e) {
    expect(e).toBeInstanceOf(GptError);
    return (e as GptError).code;
  }
}

const req = { instructions: "SYS", input: "USER-INPUT" };

describe("ApiKeyProvider request", () => {
  it("posts instructions, array input and store:false to /v1/responses", async () => {
    const m = mockFetch([json(200, okBody("hello"))]);
    expect(await provider(m.fn, { reasoningEffort: "high" }).complete(req)).toBe("hello");
    const { url, init } = m.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-123456");
    expect(JSON.parse(init.body as string)).toEqual({
      model: "gpt-test",
      instructions: "SYS",
      input: [{ role: "user", content: "USER-INPUT" }],
      store: false,
      reasoning: { effort: "high" },
    });
  });

  it("omits reasoning when not configured", async () => {
    const m = mockFetch([json(200, okBody("x"))]);
    await provider(m.fn).complete(req);
    expect(JSON.parse(m.calls[0]!.init.body as string).reasoning).toBeUndefined();
  });
});

describe("ApiKeyProvider errors", () => {
  it("maps 401 to not_logged_in and masks the key", async () => {
    const m = mockFetch([json(401, { error: { message: "Incorrect API key provided: sk-test-12****3456." } })]);
    try {
      await provider(m.fn).complete(req);
      expect.unreachable();
    } catch (e) {
      expect((e as GptError).code).toBe("not_logged_in");
      expect((e as GptError).message).not.toMatch(/sk-test/);
    }
  });

  it("maps quota 429 to plan_limit without retrying", async () => {
    const m = mockFetch([json(429, { error: { type: "insufficient_quota", code: "credit_balance_exhausted", message: "No credits" } })]);
    expect(await codeOf(provider(m.fn).complete(req))).toBe("plan_limit");
    expect(m.calls).toHaveLength(1);
  });

  it("retries a rate-limit 429 once, then succeeds", async () => {
    const m = mockFetch([json(429, { error: { message: "Rate limit reached" } }, { "retry-after": "0" }), json(200, okBody("after retry"))]);
    expect(await provider(m.fn).complete(req)).toBe("after retry");
    expect(m.calls).toHaveLength(2);
  });

  it("gives up after a second rate-limit 429", async () => {
    const m = mockFetch([json(429, { error: { message: "Rate limit" } })]);
    expect(await codeOf(provider(m.fn).complete(req))).toBe("plan_limit");
    expect(m.calls).toHaveLength(2);
  });

  it("retries a 5xx once", async () => {
    const m = mockFetch([json(503, { error: { code: "server_is_overloaded" } }), json(200, okBody("ok"))]);
    expect(await provider(m.fn).complete(req)).toBe("ok");
  });

  it("maps model errors to model_unsupported", async () => {
    const m = mockFetch([json(404, { error: { code: "model_not_found", message: "The model does not exist" } })]);
    expect(await codeOf(provider(m.fn).complete(req))).toBe("model_unsupported");
  });

  it("maps other 4xx to upstream", async () => {
    const m = mockFetch([json(400, { error: { code: "invalid_value", param: "input" } })]);
    expect(await codeOf(provider(m.fn).complete(req))).toBe("upstream");
  });

  it("retries one network error", async () => {
    const m = mockFetch([new TypeError("fetch failed"), json(200, okBody("ok"))]);
    expect(await provider(m.fn).complete(req)).toBe("ok");
  });

  it("times out", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    expect(await codeOf(provider(hang, { timeoutMs: 50 }).complete(req))).toBe("timeout");
  });

  it("honours cancellation", async () => {
    const hang = ((_u: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))))) as unknown as typeof fetch;
    const ac = new AbortController();
    const p = provider(hang).complete(req, { signal: ac.signal });
    setTimeout(() => ac.abort(), 20);
    expect(await codeOf(p)).toBe("cancelled");
  });
});

describe("extractText", () => {
  it("joins output_text parts across messages", () => {
    expect(extractText({ output: [{ type: "message", content: [{ type: "output_text", text: "a" }, { type: "output_text", text: "b" }] }] })).toBe("ab");
  });
  it("reports refusals, incomplete and failed responses", () => {
    expect(() => extractText({ output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] })).toThrow(/refused/);
    expect(() => extractText({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [] })).toThrow(/max_output_tokens/);
    expect(() => extractText({ status: "failed", error: { message: "boom" } })).toThrow(/boom/);
    expect(() => extractText({ output: [] })).toThrow(/empty/);
  });
});
