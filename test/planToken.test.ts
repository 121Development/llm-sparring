import { describe, expect, it } from "vitest";
import { GptError } from "../src/core/provider.js";
import {
  buildPlanRequestBody,
  classifyPlanError,
  hasPlanScope,
  needsRefresh,
  parseResponseStream,
  PlanTokenProvider,
  refreshRequestBody,
  SIWC,
  TERMINAL_REFRESH_ERRORS,
  UNSUPPORTED_PARAMS,
  type PlanTokens,
} from "../src/providers/planToken.js";

const tokens: PlanTokens = {
  clientId: "oaiapp_test",
  accessToken: "at",
  accessExpiresAt: 1_000_000,
  refreshToken: "rt",
  refreshExpiresAt: 9_000_000,
  grantedScopes: ["openid", "offline_access", "chatgpt.tokens.use.direct"],
};

const sse = (...events: object[]) => events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join("");

describe("plan request body", () => {
  const body = buildPlanRequestBody({ instructions: "SYS", input: "USER" }, "gpt-6.1-sol");

  it("follows the plan-route rules", () => {
    expect(body).toMatchObject({ model: "gpt-6.1-sol", instructions: "SYS", store: false, stream: true });
    expect(Array.isArray(body.input)).toBe(true);
    expect(JSON.stringify(body.input)).not.toContain('"system"');
    expect(JSON.stringify(body.input)).toContain("USER");
  });

  it("contains no unsupported parameter", () => {
    for (const p of UNSUPPORTED_PARAMS) expect(body).not.toHaveProperty(p);
  });
});

describe("tokens", () => {
  it("refreshes within 5 minutes of expiry", () => {
    expect(needsRefresh(tokens, 1_000_000 - 6 * 60_000)).toBe(false);
    expect(needsRefresh(tokens, 1_000_000 - 4 * 60_000)).toBe(true);
  });

  it("builds the refresh form with client id and resource, no scope", () => {
    const f = refreshRequestBody(tokens);
    expect(Object.fromEntries(f)).toEqual({
      grant_type: "refresh_token",
      client_id: "oaiapp_test",
      refresh_token: "rt",
      resource: "https://api.openai.com/v1",
    });
  });

  it("gates on the granted plan scope", () => {
    expect(hasPlanScope(tokens)).toBe(true);
    expect(hasPlanScope({ grantedScopes: ["openid", "offline_access"] })).toBe(false);
  });

  it("requests offline_access and the plan scope", () => {
    expect(SIWC.scopes).toEqual(expect.arrayContaining(["offline_access", "resource.invoke", "chatgpt.tokens.use.direct"]));
    expect(TERMINAL_REFRESH_ERRORS.has("refresh_token_reused")).toBe(true);
  });
});

describe("parseResponseStream", () => {
  it("joins deltas and requires response.completed", () => {
    const s = sse(
      { type: "response.created" },
      { type: "response.output_text.delta", delta: "Hel" },
      { type: "response.output_text.delta", delta: "lo" },
      { type: "response.completed", response: {} },
    );
    expect(parseResponseStream(s)).toBe("Hello");
  });

  it("treats a stream without completion as an error", () => {
    expect(() => parseResponseStream(sse({ type: "response.output_text.delta", delta: "partial" }))).toThrow(/ended before completion/);
  });

  it("surfaces a mid-stream plan limit as plan_limit", () => {
    try {
      parseResponseStream(
        sse(
          { type: "response.output_text.delta", delta: "x" },
          { type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded" } } },
        ),
      );
      expect.unreachable();
    } catch (e) {
      expect((e as GptError).code).toBe("plan_limit");
      expect((e as GptError).message).toContain("chatgpt.com/settings/usage");
    }
  });
});

describe("classifyPlanError", () => {
  it.each([
    [429, "subscription_sharing_usage_limit_exceeded", undefined, "plan_limit"],
    [401, "subscription_sharing_invalid_user", undefined, "not_logged_in"],
    [403, "chatpass_v2_scope_not_authorized", undefined, "not_logged_in"],
    [403, "subscription_sharing_user_not_eligible", undefined, "upstream"],
    [400, "subscription_sharing_unsupported_capability", "model", "model_unsupported"],
    [400, "subscription_sharing_unsupported_capability", "temperature", "upstream"],
    [503, "subscription_sharing_usage_unavailable", undefined, "upstream"],
    [401, "", undefined, "not_logged_in"],
    [500, "", undefined, "upstream"],
  ])("%s %s (%s) -> %s", (status, code, param, expected) => {
    expect(classifyPlanError(status, { code, param }).code).toBe(expected);
  });

  it("tells Claude the user must sign in again on invalid user", () => {
    expect(classifyPlanError(401, { code: "subscription_sharing_invalid_user" }).message).toMatch(/sign in with ChatGPT again/);
  });
});

describe("PlanTokenProvider", () => {
  it("is not enabled yet and says so", async () => {
    const p = new PlanTokenProvider({
      userId: "u",
      model: "gpt-6.1-sol",
      tokens: { getAccessToken: async () => "t", invalidate: async () => {} },
    });
    expect(p.modelLabel).toBe("gpt-6.1-sol (ChatGPT plan)");
    await expect(p.complete({ instructions: "", input: "" })).rejects.toThrow(/not enabled/);
  });
});
