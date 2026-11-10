# ChatGPT plan auth (Sign in with ChatGPT): design note

Status: **design only.** Interfaces and pure helpers are in
[`src/providers/planToken.ts`](../src/providers/planToken.ts), with tests in `test/planToken.test.ts`. Nothing is
wired into the Worker. Enabling it needs an OpenAI client ID and, for this hosted server, OpenAI's approval (see
[Blockers](#blockers)).

Every fact below was checked against developers.openai.com/siwc on 2026-11-10. Pages:
`/siwc`, `/siwc/quickstart`, `/siwc/request-client-id`, `/siwc/website`, `/siwc/ui-ux-guidelines`,
`/siwc/account-security-notification`, and `/siwc/token-sharing-open-source` with its sub-pages `sign-in`,
`profiles-and-sessions`, `models-and-inference`, `token-reference`, `errors-and-recovery`, `preview-limitations`,
`self-hosted-vms`, `codex-app-server`.

## Goal

Let a user pay for GPT calls with their own ChatGPT plan instead of the server's API key. They sign in with
ChatGPT during the existing MCP OAuth flow, and every tool call for that user goes through `PlanTokenProvider`.

## Checked against the original brief

| Brief said | Docs say | Verdict |
|---|---|---|
| OAuth with PKCE against OpenAI | Authorization code + PKCE (S256) + OpenID Connect | Verified |
| Scope `chatgpt.tokens.use.direct` | Request `openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`; check the *granted* scopes include `chatgpt.tokens.use.direct` before inference. `offline_access` is what returns a refresh token | **Corrected**: more scopes needed |
| 1-hour access tokens | "Access tokens are valid for one hour (`expires_in: 3600`)" | Verified |
| 30-day rotating refresh tokens | 30 days; "each successful refresh returns a replacement refresh token with a fresh 30-day lifetime". Invalidation of the old one isn't stated, but `refresh_token_reused` exists and the docs say to serialize refreshes | Verified, with the reuse caveat |
| Stored encrypted per user | Docs: keep tokens in protected storage, never in browser storage, logs, URLs or source control | Design below |
| Failed refresh means "sign in again" | Terminal refresh errors: `invalid_grant`, `invalid_refresh_token`, `token_expired`, `refresh_token_expired`, `refresh_token_invalidated`, `refresh_token_reused`. Action: clear tokens and repeat OAuth | Verified |
| 429 `subscription_sharing_usage_limit_exceeded` | HTTP 429. Can also arrive mid-stream as `response.failed`. "Do not assume the entire plan is empty or infer a reset time" (an app-specific limit can apply). Link users to ChatGPT Settings → Usage | Verified; no retry/reset headers documented |
| `store: false`, `stream: true` | "Set `store` to `false` and `stream` to `true` on each HTTP inference request" | Verified |
| `input` as an array | "Send `input` as an array" | Verified |
| System context in `instructions` | `instructions` or developer messages; explicit `role: "system"` items are rejected | Verified |
| Full history resent each call, no `previous_response_id` | "Omit `previous_response_id` over HTTP and send the required history in `input`" | Verified |
| No `temperature`, `max_output_tokens`, `background` | All three are unsupported. The full unsupported list also has `conversation`, `max_tool_calls`, `metadata`, `moderation`, `multi_agent`, `prompt`, `prompt_cache_retention`, `safety_identifier`, `top_logprobs`, `top_p`, `truncation`, `user` | Verified, list extended |

Not documented either way: `text.format` (structured output), `reasoning.effort`, `include`, `service_tier`. The
current tools don't use structured output (they ask for JSON in the prompt and parse leniently), so that's fine.
`reasoning.effort` stays off until confirmed.

## Endpoints

| What | URL |
|---|---|
| Discovery | `https://auth.openai.com/.well-known/openid-configuration` |
| Authorize | `https://auth.openai.com/api/accounts/authorize` |
| Token / refresh | `https://auth.openai.com/api/accounts/oauth/token` (form-encoded) |
| Revocation | `revocation_endpoint` from discovery |
| Inference | `POST https://api.openai.com/v1/responses`, `Authorization: Bearer <access token>` |
| Models for this user | `GET https://api.openai.com/v1/models` with the same token, filtered to `visibility == "list"` |

`resource=https://api.openai.com/v1` goes on the authorize, code-exchange and refresh requests. Don't call
ChatGPT's `backend-api` endpoints.

## Flow on this Worker

The MCP server stays the authorization server for Claude. ChatGPT becomes an *upstream* sign-in, using the
`beginUpstream()` / `finishUpstream()` helpers from `@cloudflare/workers-oauth-provider`
(`docs/upstream-sign-in.md` in the package), which handle state binding and confused-deputy protections.

```
Claude ──/authorize──▶ consent page (llm-sparring)
                         │  [Continue with ChatGPT]   ← approveConsent(), then beginUpstream({ data: { verifier, nonce } })
                         ▼
               auth.openai.com/api/accounts/authorize
                 ?client_id=oaiapp_…&response_type=code&redirect_uri=<our callback>
                 &scope=openid profile email offline_access resource.invoke chatgpt.tokens.use.direct
                 &resource=https://api.openai.com/v1&state&nonce&code_challenge&code_challenge_method=S256
                         │  user signs in and consents at OpenAI
                         ▼
               /oauth/openai/callback (llm-sparring)
                 finishUpstream() → exchange code (+ code_verifier, same redirect_uri and resource)
                 verify ID token (JWKS, iss, aud, nonce) → subject
                 require granted scope chatgpt.tokens.use.direct, else show "plan usage not granted"
                 completeAuthorization({ userId: "chatgpt:<sub>", props: { auth: "chatgpt", plan: <tokens> } })
                         ▼
               302 back to Claude with our code; Claude exchanges it for our MCP tokens
```

The user id is `chatgpt:<sub>`, kept separate from passphrase users, so debates are scoped per ChatGPT account.
Passphrase users keep using the server's API key. ChatGPT users never fall back to it.

### Token storage: inside the grant (recommended)

Store the ChatGPT tokens in the grant's `props`. The library encrypts props with AES-GCM using key material
wrapped by the MCP token itself, so the stored data can't be read from KV alone, and there's no separate
encryption key to manage. That gives "encrypted per user" for free.

Refresh rides on Claude's own refresh cycle through `tokenExchangeCallback`:

- On `authorization_code`: return `accessTokenProps` with the ChatGPT access token, `newProps` with the refresh
  token, and `accessTokenTTL = expires_in − 300`. Our MCP token then expires before the ChatGPT token does, so
  Claude refreshes first (Claude refreshes proactively up to 5 minutes before expiry, and on any 401).
- On `refresh_token`: refresh at OpenAI (`refreshRequestBody()`), store the rotated refresh token in `newProps`, and
  set `refreshTokenIdleTTL` to the new refresh token's lifetime (30 days).
- Terminal refresh error (`TERMINAL_REFRESH_ERRORS`): throw `OAuthError('invalid_grant')`. The library revokes
  the grant and Claude re-runs sign-in, which is the "sign in again" behaviour.
- Transient refresh error (5xx, network): throw `OAuthError('temporarily_unavailable')` so the grant survives.

In this design `PlanAccessTokenSource` simply reads `ctx.props`. `invalidate()` is a no-op that returns 401 to
Claude, which triggers a refresh.

Refresh races: the docs say to serialize refreshes. Claude refreshes one connection at a time, but the library keeps
the old MCP refresh token valid until the new one is used, so two near-simultaneous refreshes could both send the
same ChatGPT refresh token and one would get `refresh_token_reused`, which ends the grant. If that shows up in
practice, put the upstream refresh behind a per-grant Durable Object lock. The `version` field in `PlanTokenStore`
covers the same need for the alternative below.

### Alternative: a separate token store

`PlanTokenStore` (D1 row per user, AES-GCM ciphertext, key in a Worker secret `PLAN_TOKEN_KEY`, version-checked
writes) is the fallback if one ChatGPT sign-in should be shared across several MCP grants, for example claude.ai and
Claude Code for the same person. It costs a key to rotate and a lock to manage, so it isn't the default.

## Request path (`PlanTokenProvider.complete`)

1. Get the access token (from `ctx.props`).
2. `POST /v1/responses` with `buildPlanRequestBody()`: `store: false`, `stream: true`, `instructions`, and `input`
   as a one-item array holding the full prompt. Every tool already sends complete context per call; debates resend
   the whole transcript, so nothing depends on `previous_response_id`.
3. Before the stream, a non-2xx response is classified by `classifyPlanError(status, body.error ?? body)`. Admission
   errors may be `{"detail": "..."}`, which is diagnostic text, not a stable code.
4. Read the SSE stream: accumulate `response.output_text.delta`, succeed only on `response.completed`, and treat
   `response.failed` (including the mid-stream plan limit) and a truncated stream as errors (`parseResponseStream()`).
   Production code should read the stream incrementally and honour the tool-call abort signal.
5. Never retry a plan-limit error automatically.

## Errors shown to Claude

| Code (HTTP) | GptError code | Message gist |
|---|---|---|
| `subscription_sharing_usage_limit_exceeded` (429, or mid-stream) | `plan_limit` | Plan usage limit for this app reached; check chatgpt.com/settings/usage; don't assume the whole plan is empty |
| `subscription_sharing_invalid_user` (401) | `not_logged_in` | Sign in with ChatGPT again |
| `chatpass_v2_scope_not_authorized`, `chatpass_v2_invalid_authorization_context` (403) | `not_logged_in` | Sign in again and allow plan usage |
| `subscription_sharing_user_not_eligible` (403) | `upstream` | This account, workspace or region can't use its plan here; signing in again won't help |
| `subscription_sharing_unsupported_capability` (400) | `model_unsupported` when `param` is `model`, else `upstream` | Names the rejected parameter |
| `subscription_sharing_usage_unavailable`, `subscription_sharing_user_unavailable` (503) | `upstream` | Temporarily unavailable; retry with backoff |
| `subscription_sharing_route_not_supported` (403) | `upstream` | Server bug: only `POST /v1/responses` is supported |
| Terminal refresh error | grant revoked | Claude re-runs sign-in |

## UI requirements (from `/siwc/ui-ux-guidelines`)

- The sign-in button reads **Continue with ChatGPT**, using OpenAI's approved branding.
- Show a one-time welcome notice the first time plan usage is enabled.
- Show a "Using ChatGPT plan" indicator with a **Manage usage** link to `https://chatgpt.com/settings/usage`. Here
  the consent page carries it, and plan-backed tool results say "via your ChatGPT plan" in the quoted-output
  preamble (`modelLabel` is `"<model> (ChatGPT plan)"`).
- Usage-limit messages link to the same settings page.

## Plans and limits

- "Eligible ChatGPT Plus and Pro users" can use their plan. Eligibility of Free, Team, Enterprise and Edu isn't
  documented; `subscription_sharing_user_not_eligible` covers the rest.
- Plus has a five-hour usage limit shared across every app using the plan. Pro doesn't have that limit.
- Models: query `/v1/models` with the user's token. `GPT_MODEL` must be one the user's plan lists; otherwise fall
  back to the first listed model and say so in the tool output.

## Blockers

1. **Hosted use needs OpenAI's approval.** The developer docs "explain ChatGPT plan usage for open-source and
   locally hosted apps. If you're interested in offering it in a paid or remotely hosted app, complete the interest
   form." This Worker is remotely hosted and serves several users, so it falls outside the self-serve path.
2. **Client ID.** The website flow needs an issued `oaiapp_…` client ID with an exact registered callback URL
   (for example `https://llm-sparring.<your-subdomain>.workers.dev/oauth/openai/callback`). "Sign in with ChatGPT is currently
   offered to a select group of commercial partners": waitlist via `/siwc/request-client-id`. The open-source
   flow's dynamic registration (`client_id=dynamic_agent_client`) requires a loopback `127.0.0.1` redirect, so it
   can't serve a hosted callback.

A local-only variant (the stdio server signing in through a loopback redirect, like Codex does) is within the
self-serve docs, but it duplicates what `CodexCliProvider` already gives you through `codex login`.

## Open questions for OpenAI

- Is `ext_agent_host_id` (required in the open-source flow, "distinct for each host") needed in the website flow,
  and what should a multi-user server send?
- What does `resource.invoke` grant beyond `chatgpt.tokens.use.direct`?
- Are `text.format` (JSON schema) and `reasoning.effort` accepted on the plan route?
- What is the exact error JSON for `response.failed` and for pre-stream errors, and are there any retry or reset
  headers?
- Is the old refresh token invalidated on rotation, and is there a grace window?
- Are back-channel logout notifications (`/siwc/account-security-notification`) available to website clients? The
  docs also say OpenAI does not currently notify apps when a user disconnects in ChatGPT settings.

## To enable later

1. Get approval and a client ID; register the callback URL.
2. Add `OPENAI_CLIENT_ID` (and a client secret if registered as confidential) as Worker secrets.
3. Add the **Continue with ChatGPT** button and `/oauth/openai/callback` to `src/worker/consent.ts`, using
   `beginUpstream()` and `finishUpstream()`.
4. Add `tokenExchangeCallback` to the `OAuthProvider` options in `src/worker/index.ts`.
5. Implement `PlanTokenProvider.complete()` along the request path above, and select it in `gptProvider()` when
   `ctx.props.auth === "chatgpt"`.
6. Test against the live route: the plan limit, a terminal refresh, and an unsupported model.
