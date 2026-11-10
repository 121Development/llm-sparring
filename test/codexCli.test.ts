import { chmodSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GptError } from "../src/core/provider.js";
import { classifyCodexError, CodexCliProvider } from "../src/providers/codexCli.js";

const FAKE = resolve(__dirname, "fixtures/fake-codex.mjs");
let dir: string;

beforeAll(() => {
  chmodSync(FAKE, 0o755);
  dir = mkdtempSync(join(tmpdir(), "llm-sparring-test-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function provider(mode: string, extra: Partial<ConstructorParameters<typeof CodexCliProvider>[0]> = {}) {
  return new CodexCliProvider({ bin: FAKE, env: { FAKE_CODEX_MODE: mode }, ...extra });
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "no error";
  } catch (e) {
    expect(e).toBeInstanceOf(GptError);
    return (e as GptError).code;
  }
}

const req = { instructions: "You are a critic.\nLine 2 with \"quotes\"", input: "the draft" };

describe("CodexCliProvider", () => {
  it("returns the last agent message", async () => {
    const p = provider("ok", { env: { FAKE_CODEX_MODE: "ok", FAKE_CODEX_REPLY: "the answer" } });
    expect(await p.complete(req)).toBe("the answer");
    p.dispose();
  });

  it("sends input on stdin and uses safe, non-interactive flags", async () => {
    const record = join(dir, "rec.json");
    const p = provider("ok", { model: "gpt-x", env: { FAKE_CODEX_MODE: "ok", FAKE_CODEX_RECORD: record } });
    await p.complete(req);
    const { args, stdin } = JSON.parse(readFileSync(record, "utf8"));
    p.dispose();

    expect(stdin).toBe("the draft");
    expect(args.join(" ")).not.toContain("the draft");
    expect(args[0]).toBe("exec");
    for (const flag of ["--json", "--ephemeral", "--ignore-user-config", "--skip-git-repo-check"]) {
      expect(args).toContain(flag);
    }
    expect(args[args.indexOf("--sandbox") + 1]).toBe("read-only");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-x");
    for (const f of ["shell_tool", "unified_exec", "code_mode_host"]) {
      expect(args).toContain(f);
    }
    expect(args.at(-1)).toBe("-");
    // instructions passed as a TOML/JSON string that round-trips exactly
    const di = args.find((a: string) => a.startsWith("developer_instructions="));
    expect(JSON.parse(di.slice("developer_instructions=".length))).toBe(req.instructions);
  });

  it("omits -m when no model is configured", async () => {
    const p = provider("ok");
    expect(p.execArgs("x")).not.toContain("-m");
    expect(p.modelLabel).toBe("codex-default");
    p.dispose();
  });

  it("reports a missing binary", async () => {
    const p = new CodexCliProvider({ bin: join(dir, "does-not-exist") });
    expect(await codeOf(p.complete(req))).toBe("not_installed");
  });

  it("reports not logged in (from login status)", async () => {
    expect(await codeOf(provider("logged_out").complete(req))).toBe("not_logged_in");
  });

  it("reports not logged in (from a 401 during exec)", async () => {
    expect(await codeOf(provider("unauthorized").complete(req))).toBe("not_logged_in");
  });

  it("reports the plan limit", async () => {
    expect(await codeOf(provider("plan_limit").complete(req))).toBe("plan_limit");
  });

  it("reports an unsupported model", async () => {
    expect(await codeOf(provider("bad_model").complete(req))).toBe("model_unsupported");
  });

  it("reports an empty response", async () => {
    expect(await codeOf(provider("empty").complete(req))).toBe("empty_response");
  });

  it("times out and kills the child", async () => {
    const started = Date.now();
    expect(await codeOf(provider("hang", { timeoutMs: 500 }).complete(req))).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("honours cancellation", async () => {
    const ac = new AbortController();
    const p = provider("hang").complete(req, { signal: ac.signal });
    setTimeout(() => ac.abort(), 200);
    expect(await codeOf(p)).toBe("cancelled");
  });
});

describe("classifyCodexError", () => {
  it.each([
    ["You've hit your usage limit. Try again later.", "plan_limit"],
    ["unexpected status 429 Too Many Requests", "plan_limit"],
    ["unexpected status 401 Unauthorized", "not_logged_in"],
    ["Your refresh token has expired, please log in again", "not_logged_in"],
    ["The 'x' model is not supported when using Codex with a ChatGPT account.", "model_unsupported"],
    ["stream disconnected before completion", "upstream"],
  ])("%s → %s", (msg, code) => {
    expect(classifyCodexError(msg).code).toBe(code);
  });
});
