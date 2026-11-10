import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GptError, type GptProvider, type GptRequest } from "../core/provider.js";

export interface CodexCliOptions {
  /** Path or name of the codex binary. Default: "codex" on PATH. */
  bin?: string;
  /** Model passed with -m. Undefined uses Codex's default for the account. */
  model?: string;
  /** Optional reasoning effort (e.g. "low", "medium", "high"). */
  reasoningEffort?: string;
  /** Per-call timeout. Default 180s. */
  timeoutMs?: number;
  /** Extra env for the child (tests). Merged over process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Codex features that give the agent tools. We want plain text completions,
 * so everything that could run commands, read files, browse or spawn agents is off.
 * Verified against codex-cli 0.166 (`codex features list`).
 */
const DISABLED_FEATURES = [
  "shell_tool",
  "unified_exec",
  "code_mode_host",
  "multi_agent",
  "apps",
  "plugins",
  "hooks",
  "goals",
  "image_generation",
  "view_image",
  "browser_use",
  "in_app_browser",
  "computer_use",
  "tool_suggest",
  "skill_search",
  "sleep_tool",
  "shell_snapshot",
];

const LOGIN_CACHE_MS = 10 * 60_000;

/**
 * Runs `codex exec` non-interactively using the user's existing `codex login`
 * (ChatGPT) session. Codex reads its own credentials from CODEX_HOME; this
 * process never touches them.
 *
 * Isolation: read-only sandbox, ephemeral (no session files), user config
 * ignored (no user MCP servers or profiles), agent tools disabled, and the
 * working directory is an empty temp dir. Prompt text goes over stdin so it
 * never appears in the process list.
 */
export class CodexCliProvider implements GptProvider {
  readonly modelLabel: string;
  private readonly bin: string;
  private readonly timeoutMs: number;
  private loginCheckedAt = 0;
  private workDir: string | undefined;

  constructor(private readonly opts: CodexCliOptions = {}) {
    this.bin = opts.bin ?? "codex";
    this.timeoutMs = opts.timeoutMs ?? 180_000;
    this.modelLabel = opts.model ?? "codex-default";
  }

  async complete(req: GptRequest, callOpts: { signal?: AbortSignal } = {}): Promise<string> {
    await this.ensureLoggedIn();
    try {
      const result = await this.run(this.execArgs(req.instructions), req.input, this.timeoutMs, callOpts.signal);
      return parseExecOutput(result);
    } catch (err) {
      if (err instanceof GptError && err.code === "not_logged_in") this.loginCheckedAt = 0;
      throw err;
    }
  }

  /** Remove the temp working dir. Safe to call more than once. */
  dispose(): void {
    if (this.workDir) {
      rmSync(this.workDir, { recursive: true, force: true });
      this.workDir = undefined;
    }
  }

  execArgs(instructions: string): string[] {
    const args = [
      "exec",
      "--json",
      "--ephemeral",
      "--skip-git-repo-check",
      "--ignore-user-config",
      "--sandbox",
      "read-only",
      "--color",
      "never",
      "-C",
      this.getWorkDir(),
      // JSON string syntax is a valid TOML basic string.
      "-c",
      `developer_instructions=${JSON.stringify(instructions)}`,
      "-c",
      'web_search="disabled"',
    ];
    for (const f of DISABLED_FEATURES) args.push("--disable", f);
    if (this.opts.model) args.push("-m", this.opts.model);
    if (this.opts.reasoningEffort) args.push("-c", `model_reasoning_effort=${JSON.stringify(this.opts.reasoningEffort)}`);
    args.push("-"); // read prompt from stdin
    return args;
  }

  private getWorkDir(): string {
    this.workDir ??= mkdtempSync(join(tmpdir(), "llm-sparring-"));
    return this.workDir;
  }

  private async ensureLoggedIn(): Promise<void> {
    if (Date.now() - this.loginCheckedAt < LOGIN_CACHE_MS) return;
    const r = await this.run(["login", "status"], "", 20_000);
    const out = `${r.stdout}\n${r.stderr}`;
    if (r.code !== 0 || /not logged in/i.test(out)) {
      throw new GptError(
        "not_logged_in",
        "Codex CLI is not logged in. Ask the user to run `codex login` in a terminal (choose 'Sign in with ChatGPT'), then retry.",
      );
    }
    this.loginCheckedAt = Date.now();
  }

  private run(args: string[], stdin: string, timeoutMs: number, signal?: AbortSignal): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      if (signal?.aborted) return reject(new GptError("cancelled", "The request was cancelled."));
      const child = spawn(this.bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...this.opts.env, NO_COLOR: "1" },
        detached: process.platform !== "win32", // own process group so we can kill the whole tree
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      let killReason: "timeout" | "cancelled" | undefined;

      const kill = () => {
        try {
          if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGTERM");
          else child.kill("SIGTERM");
        } catch {
          // already gone
        }
        setTimeout(() => {
          try {
            if (child.pid && process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            // already gone
          }
        }, 2_000).unref();
      };

      const timer = setTimeout(() => {
        killReason = "timeout";
        kill();
      }, timeoutMs);
      const onAbort = () => {
        killReason = "cancelled";
        kill();
      };
      signal?.addEventListener("abort", onAbort, { once: true });

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };

      child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", (err: NodeJS.ErrnoException) =>
        finish(() =>
          reject(
            err.code === "ENOENT"
              ? new GptError(
                  "not_installed",
                  `Codex CLI not found (tried "${this.bin}"). Install it (e.g. \`npm i -g @openai/codex\`), run \`codex login\`, or set CODEX_BIN to its full path in the MCP server config.`,
                )
              : new GptError("upstream", `Could not start Codex CLI: ${err.code ?? err.message}`),
          ),
        ),
      );
      child.on("close", (code) =>
        finish(() => {
          if (killReason === "timeout") {
            reject(
              new GptError(
                "timeout",
                `GPT did not answer within ${Math.round(timeoutMs / 1000)}s. Try a shorter input, or raise CODEX_TIMEOUT_MS in the server config.`,
              ),
            );
          } else if (killReason === "cancelled") {
            reject(new GptError("cancelled", "The request was cancelled."));
          } else {
            resolve({ code, stdout, stderr });
          }
        }),
      );
      child.stdin.on("error", () => {}); // EPIPE if the child exits early; handled via close
      child.stdin.end(stdin);
    });
  }
}

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Parse `codex exec --json` JSONL output into the final agent message or a GptError. */
export function parseExecOutput(r: RunResult): string {
  const messages: string[] = [];
  let failure: string | undefined;
  let lastError: string | undefined;

  for (const line of r.stdout.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let ev: any;
    try {
      ev = JSON.parse(t);
    } catch {
      continue;
    }
    if (ev.type === "item.completed" && ev.item?.type === "agent_message" && typeof ev.item.text === "string") {
      messages.push(ev.item.text);
    } else if (ev.type === "turn.failed") {
      failure = String(ev.error?.message ?? "unknown error");
    } else if (ev.type === "error" && typeof ev.message === "string") {
      lastError = ev.message;
    }
  }

  const problem = failure ?? (r.code !== 0 ? (lastError ?? lastStderrLine(r.stderr)) : undefined);
  if (problem !== undefined) throw classifyCodexError(problem);

  const final = messages.at(-1)?.trim();
  if (!final) throw new GptError("empty_response", "GPT returned an empty response. Try again.");
  return final;
}

export function classifyCodexError(message: string): GptError {
  const m = message.toLowerCase();
  const short = sanitise(message);
  if (/usage limit|usage_limit|rate limit|rate_limit|too many requests|\b429\b|quota|purchase more credits/.test(m)) {
    return new GptError(
      "plan_limit",
      `The ChatGPT plan's Codex usage limit has been reached. Wait for the limit to reset (or upgrade the plan), then retry. Details: ${short}`,
    );
  }
  if (/\b401\b|unauthori[sz]ed|not logged in|missing bearer|token.*(expired|invalid)|refresh token|log ?in again/.test(m)) {
    return new GptError(
      "not_logged_in",
      `Codex is not authenticated. Ask the user to run \`codex login\` in a terminal, then retry. Details: ${short}`,
    );
  }
  if (/model.*(not supported|not found|does not exist|unknown)|model_not_found/.test(m)) {
    return new GptError(
      "model_unsupported",
      `The model set in GPT_MODEL is not available for this account via Codex. Change or unset GPT_MODEL. Details: ${short}`,
    );
  }
  return new GptError("upstream", `Codex/OpenAI returned an error: ${short}`);
}

/** Error text from Codex is shown to Claude, never logged. Collapse whitespace and cap length. */
function sanitise(s: string): string {
  return s.replace(/\s+/g, " ").trim().slice(0, 400);
}

function lastStderrLine(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("WARNING"));
  return lines.at(-1) ?? "Codex exited with an error and no message.";
}
