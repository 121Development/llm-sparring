/**
 * PlanTokenProvider: GPT calls billed to the user's own ChatGPT plan via
 * "Sign in with ChatGPT" (SIWC) tokens. DESIGN ONLY (Phase 4): this file
 * defines the interfaces and the pure, testable pieces (request shaping, SSE
 * parsing, error mapping). The network flow is not wired in, because OpenAI
 * has not issued a client ID for this server. See docs/plan-auth.md.
 *
 * All facts below were checked against developers.openai.com/siwc on 2026-11-10.
 */
import { GptError, type GptProvider, type GptRequest } from "../core/provider.js";

// ---------------- OAuth constants (docs: /siwc/token-sharing-open-source/sign-in) ----------------

export const SIWC = {
  issuer: "https://auth.openai.com",
  authorizeUrl: "https://auth.openai.com/api/accounts/authorize",
  tokenUrl: "https://auth.openai.com/api/accounts/oauth/token",
  discoveryUrl: "https://auth.openai.com/.well-known/openid-configuration",
  /** RFC 8707 resource sent on authorize, token and refresh requests. */
  resource: "https://api.openai.com/v1",
  apiBase: "https://api.openai.com/v1",
  /** Identity + plan usage. offline_access is what yields a refresh token. */
  scopes: ["openid", "profile", "email", "offline_access", "resource.invoke", "chatgpt.tokens.use.direct"],
  /** The scope that must be in the *granted* set before any inference. */
  requiredGrantedScope: "chatgpt.tokens.use.direct",
  accessTokenLifetimeS: 3600,
  refreshTokenLifetimeS: 30 * 24 * 3600,
  usageSettingsUrl: "https://chatgpt.com/settings/usage",
} as const;

// ---------------- Token storage and refresh ----------------

/** One user's SIWC grant. Stored encrypted at rest; never logged, never in URLs. */
export interface PlanTokens {
  /** The issued client id (oaiapp_...) these tokens belong to. Never mix registrations. */
  clientId: string;
  accessToken: string;
  /** Epoch ms when the access token expires (issued time + expires_in). */
  accessExpiresAt: number;
  /** Rotates on every refresh; the replacement has a fresh 30-day lifetime. */
  refreshToken: string;
  refreshExpiresAt: number;
  grantedScopes: string[];
  /** OIDC subject, for display ("Using ChatGPT plan as ...") and support. */
  subject?: string;
}

export interface StoredPlanTokens {
  tokens: PlanTokens;
  /** Optimistic-concurrency version, so two refreshes can't both rotate the token. */
  version: number;
}

/**
 * Per-user encrypted token storage (D1 row of AES-GCM ciphertext, key from a
 * Worker secret). Implementations must encrypt; callers only see plaintext in memory.
 */
export interface PlanTokenStore {
  get(userId: string): Promise<StoredPlanTokens | null>;
  /** Write if the stored version equals expectedVersion (0 = insert). False on conflict. */
  put(userId: string, tokens: PlanTokens, expectedVersion: number): Promise<boolean>;
  delete(userId: string): Promise<void>;
}

/**
 * Hands out a currently valid access token for a user, refreshing when it is
 * within the refresh margin of expiry. Refreshes for one user must be
 * serialised (docs: "serialize refreshes for the same session"); on Workers
 * that means a per-user Durable Object or a version-checked write in D1.
 * A terminal refresh error (TERMINAL_REFRESH_ERRORS) clears the tokens and throws
 * GptError("not_logged_in", "...sign in with ChatGPT again...").
 */
export interface PlanAccessTokenSource {
  getAccessToken(userId: string): Promise<string>;
  /** Forget a token that the API rejected (401 subscription_sharing_invalid_user). */
  invalidate(userId: string): Promise<void>;
}

/** Refresh this long before expiry. */
export const REFRESH_MARGIN_MS = 5 * 60_000;

export function needsRefresh(t: PlanTokens, now: number): boolean {
  return t.accessExpiresAt - REFRESH_MARGIN_MS <= now;
}

/** Form body for a refresh. Omitting `scope` keeps the existing grant. */
export function refreshRequestBody(t: PlanTokens): URLSearchParams {
  return new URLSearchParams({
    grant_type: "refresh_token",
    client_id: t.clientId,
    refresh_token: t.refreshToken,
    resource: SIWC.resource,
  });
}

/** Errors from the token endpoint that mean the refresh token is dead: the user must sign in again. */
export const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export function hasPlanScope(t: Pick<PlanTokens, "grantedScopes">): boolean {
  return t.grantedScopes.includes(SIWC.requiredGrantedScope);
}

// ---------------- Responses API request shaping (docs: preview-limitations, models-and-inference) ----------------

/** Parameters the plan route rejects. GptRequest never produces these; listed for the guard below. */
export const UNSUPPORTED_PARAMS = [
  "background",
  "conversation",
  "max_output_tokens",
  "max_tool_calls",
  "metadata",
  "moderation",
  "multi_agent",
  "prompt",
  "prompt_cache_retention",
  "safety_identifier",
  "temperature",
  "top_logprobs",
  "top_p",
  "truncation",
  "user",
  "previous_response_id",
] as const;

/**
 * Body for POST /v1/responses on the plan route:
 * store:false, stream:true, input as an array, system context in `instructions`
 * (explicit system-role items are rejected), full context in every call.
 */
export function buildPlanRequestBody(req: GptRequest, model: string): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model,
    instructions: req.instructions,
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: req.input }] }],
    store: false,
    stream: true,
  };
  for (const p of UNSUPPORTED_PARAMS) {
    if (p in body) throw new Error(`plan route does not accept ${p}`);
  }
  return body;
}

/**
 * Collect the final text from a Responses SSE stream. Success only after
 * `response.completed`; a `response.failed` (which can carry the plan-limit
 * error mid-stream) or a stream that ends early is an error.
 */
export function parseResponseStream(sse: string): string {
  let text = "";
  let completed = false;
  for (const block of sse.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    let ev: any;
    try {
      ev = JSON.parse(data);
    } catch {
      continue;
    }
    switch (ev.type) {
      case "response.output_text.delta":
        if (typeof ev.delta === "string") text += ev.delta;
        break;
      case "response.completed":
        completed = true;
        break;
      case "response.failed":
      case "error":
        throw classifyPlanError(429, ev.response?.error ?? ev.error ?? ev);
      case "response.incomplete":
        throw new GptError("empty_response", `GPT's response was cut off (reason: ${ev.response?.incomplete_details?.reason ?? "unknown"}).`);
    }
  }
  if (!completed) throw new GptError("upstream", "The response stream ended before completion. Try again.");
  if (!text.trim()) throw new GptError("empty_response", "GPT returned an empty response. Try again.");
  return text.trim();
}

// ---------------- Error mapping (docs: errors-and-recovery) ----------------

/**
 * Map a plan-route error to a GptError with a message for Claude.
 * `status` is the HTTP status (or 429 for a mid-stream response.failed whose code decides anyway).
 */
export function classifyPlanError(status: number, err: { code?: string; param?: string; message?: string; detail?: string } | undefined): GptError {
  const code = err?.code ?? "";
  switch (code) {
    case "subscription_sharing_usage_limit_exceeded":
      return new GptError(
        "plan_limit",
        `The user's ChatGPT plan usage limit for this app has been reached. Pause GPT requests and check ${SIWC.usageSettingsUrl}. (An app-specific limit can also cause this; don't assume the whole plan is empty.)`,
      );
    case "subscription_sharing_invalid_user":
      return new GptError("not_logged_in", "ChatGPT sign-in is no longer valid. The user needs to sign in with ChatGPT again.");
    case "subscription_sharing_user_not_eligible":
      return new GptError("upstream", "This ChatGPT account, workspace or region can't use its plan in this app. Signing in again won't help.");
    case "subscription_sharing_unsupported_capability":
      return err?.param === "model"
        ? new GptError("model_unsupported", "The configured model isn't available on this ChatGPT plan.")
        : new GptError("upstream", `The ChatGPT plan route doesn't support part of this request (${err?.param ?? "unknown parameter"}).`);
    case "subscription_sharing_usage_unavailable":
    case "subscription_sharing_user_unavailable":
      return new GptError("upstream", "ChatGPT plan usage is temporarily unavailable. Retry shortly.");
    case "subscription_sharing_route_not_supported":
      return new GptError("upstream", "OpenAI rejected the endpoint for plan usage (server bug: only POST /v1/responses is supported).");
    case "chatpass_v2_scope_not_authorized":
    case "chatpass_v2_invalid_authorization_context":
      return new GptError("not_logged_in", "The ChatGPT sign-in didn't grant plan usage. The user needs to sign in with ChatGPT again and allow it.");
  }
  if (status === 401) return new GptError("not_logged_in", "ChatGPT sign-in was not accepted. The user needs to sign in with ChatGPT again.");
  if (status === 403) return new GptError("upstream", "OpenAI refused plan usage for this account or region.");
  if (status === 503) return new GptError("upstream", "ChatGPT plan usage is temporarily unavailable. Retry shortly.");
  return new GptError("upstream", `OpenAI plan-route error (HTTP ${status}${code ? `, ${code}` : ""}).`);
}

// ---------------- The provider ----------------

export interface PlanTokenProviderOptions {
  userId: string;
  model: string;
  tokens: PlanAccessTokenSource;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/**
 * GptProvider over the user's ChatGPT plan. One instance per request/user.
 * Not yet enabled: complete() is the intended shape, unverified against the live route.
 */
export class PlanTokenProvider implements GptProvider {
  readonly modelLabel: string;

  constructor(private readonly opts: PlanTokenProviderOptions) {
    this.modelLabel = `${opts.model} (ChatGPT plan)`;
  }

  async complete(_req: GptRequest, _callOpts?: { signal?: AbortSignal }): Promise<string> {
    // Intended flow (docs/plan-auth.md, "Request path"):
    //   token = await tokens.getAccessToken(userId)          // refreshes if needed
    //   res   = POST {SIWC.apiBase}/responses, Bearer token, buildPlanRequestBody(req, model)
    //   !res.ok -> classifyPlanError(res.status, json.error ?? json); on 401 -> tokens.invalidate(userId)
    //   ok      -> parseResponseStream(await res.text())    // or incremental SSE reader
    throw new GptError("upstream", "ChatGPT plan sign-in is not enabled on this server yet.");
  }
}
