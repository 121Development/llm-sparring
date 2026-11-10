import { GptError, type GptProvider, type GptRequest } from "../core/provider.js";

export interface ApiKeyProviderOptions {
  apiKey: string;
  model: string;
  reasoningEffort?: string;
  /** Default https://api.openai.com/v1 */
  baseUrl?: string;
  /** Per-call timeout. Default 180s (Claude's tool limit is 240s). */
  timeoutMs?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
  /** Wait before the single retry on transient errors. Default 1500ms. */
  retryDelayMs?: number;
}

/**
 * OpenAI Responses API with an API key. Plain fetch, so it runs on Workers and Node.
 * `store: false` so OpenAI doesn't keep the conversation for later retrieval.
 */
export class ApiKeyProvider implements GptProvider {
  readonly modelLabel: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;
  private readonly retryDelayMs: number;

  constructor(private readonly opts: ApiKeyProviderOptions) {
    if (!opts.apiKey) throw new Error("ApiKeyProvider: apiKey is required");
    if (!opts.model) throw new Error("ApiKeyProvider: model is required");
    this.modelLabel = opts.model;
    this.baseUrl = (opts.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.fetchFn = opts.fetch ?? ((...args) => fetch(...args));
    this.retryDelayMs = opts.retryDelayMs ?? 1_500;
  }

  async complete(req: GptRequest, callOpts: { signal?: AbortSignal } = {}): Promise<string> {
    const body: Record<string, unknown> = {
      model: this.opts.model,
      instructions: req.instructions,
      input: [{ role: "user", content: req.input }],
      store: false,
    };
    if (this.opts.reasoningEffort) body.reasoning = { effort: this.opts.reasoningEffort };

    const deadline = AbortSignal.timeout(this.timeoutMs);
    const signal = callOpts.signal ? AbortSignal.any([callOpts.signal, deadline]) : deadline;

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchFn(`${this.baseUrl}/responses`, {
          method: "POST",
          headers: { Authorization: `Bearer ${this.opts.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal,
        });
      } catch (err) {
        if (deadline.aborted) {
          throw new GptError("timeout", `GPT did not answer within ${Math.round(this.timeoutMs / 1000)}s. Try a shorter input.`);
        }
        if (callOpts.signal?.aborted) throw new GptError("cancelled", "The request was cancelled.");
        if (attempt === 0) {
          await sleep(this.retryDelayMs);
          continue;
        }
        throw new GptError("upstream", "Could not reach the OpenAI API (network error).");
      }

      if (res.ok) return extractText(await res.json());

      const err = await classifyHttpError(res);
      if (err.retry && attempt === 0) {
        await sleep(Math.min(err.retryAfterMs ?? this.retryDelayMs, 5_000));
        continue;
      }
      throw err.error;
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pull the assistant text out of a Responses API result. */
export function extractText(data: any): string {
  if (data?.status === "failed") {
    throw new GptError("upstream", `OpenAI reported a failed response: ${short(data?.error?.message ?? "no details")}`);
  }
  const parts: string[] = [];
  let refusal: string | undefined;
  for (const item of Array.isArray(data?.output) ? data.output : []) {
    if (item?.type !== "message") continue;
    for (const c of Array.isArray(item.content) ? item.content : []) {
      if (c?.type === "output_text" && typeof c.text === "string") parts.push(c.text);
      if (c?.type === "refusal" && typeof c.refusal === "string") refusal = c.refusal;
    }
  }
  const text = parts.join("").trim();
  if (text) return text;
  if (refusal) throw new GptError("upstream", `GPT refused: ${short(refusal)}`);
  if (data?.status === "incomplete") {
    const reason = data?.incomplete_details?.reason ?? "unknown";
    throw new GptError("empty_response", `GPT's response was cut off before any text (reason: ${reason}). Try a shorter input.`);
  }
  throw new GptError("empty_response", "GPT returned an empty response. Try again.");
}

interface Classified {
  error: GptError;
  retry: boolean;
  retryAfterMs?: number;
}

const QUOTA_CODES = new Set([
  "insufficient_quota",
  "credit_balance_exhausted",
  "organization_spend_limit_exceeded",
  "project_spend_limit_exceeded",
  "organization_usage_limit_exceeded",
  "billing_hard_limit_reached",
]);

export async function classifyHttpError(res: Response): Promise<Classified> {
  let e: { message?: string; type?: string; code?: string; param?: string } = {};
  try {
    e = ((await res.json()) as any)?.error ?? {};
  } catch {
    // non-JSON body
  }
  const msg = short(e.message ?? res.statusText ?? "");
  const retryAfter = Number(res.headers.get("retry-after"));
  const retryAfterMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined;

  if (res.status === 401 || res.status === 403) {
    return {
      retry: false,
      error: new GptError(
        "not_logged_in",
        `OpenAI rejected the server's API key (HTTP ${res.status}). The server owner needs to check OPENAI_API_KEY. ${msg}`,
      ),
    };
  }
  if (res.status === 429) {
    if (QUOTA_CODES.has(e.code ?? "") || e.type === "insufficient_quota") {
      return {
        retry: false,
        error: new GptError("plan_limit", `The OpenAI account behind this server is out of quota or over its spend limit. ${msg}`),
      };
    }
    return {
      retry: true,
      retryAfterMs,
      error: new GptError("plan_limit", `OpenAI rate limit reached. Wait a bit and retry. ${msg}`),
    };
  }
  if (res.status === 404 || e.code === "model_not_found" || (res.status === 400 && e.param === "model")) {
    return {
      retry: false,
      error: new GptError("model_unsupported", `The model set in GPT_MODEL is not available to this API key. ${msg}`),
    };
  }
  if (res.status >= 500) {
    return { retry: true, retryAfterMs, error: new GptError("upstream", `OpenAI server error (HTTP ${res.status}). Try again. ${msg}`) };
  }
  return { retry: false, error: new GptError("upstream", `OpenAI API error (HTTP ${res.status}${e.code ? `, ${e.code}` : ""}). ${msg}`) };
}

/** Collapse whitespace, cap length, and mask anything that looks like an API key. */
function short(s: string): string {
  return s
    .replace(/sk-[A-Za-z0-9_*\-]{4,}/g, "sk-[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}
