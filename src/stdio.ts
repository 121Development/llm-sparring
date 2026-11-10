#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { Logger, LogFields } from "./core/log.js";
import { createServer } from "./core/server.js";
import { CodexCliProvider } from "./providers/codexCli.js";

/** JSON lines on stderr; stdout belongs to the MCP transport. Metadata only. */
const logger: Logger = {
  info: (event, fields) => write("info", event, fields),
  error: (event, fields) => write("error", event, fields),
};
function write(level: string, event: string, fields?: LogFields) {
  process.stderr.write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }) + "\n");
}

function intEnv(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
  return n;
}

const provider = new CodexCliProvider({
  bin: process.env.CODEX_BIN || undefined,
  model: process.env.GPT_MODEL || undefined,
  reasoningEffort: process.env.GPT_REASONING_EFFORT || undefined,
  timeoutMs: intEnv("CODEX_TIMEOUT_MS"),
});

const server = createServer({ provider, logger });

const shutdown = async () => {
  provider.dispose();
  await server.close().catch(() => {});
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.stdin.on("close", shutdown);

await server.connect(new StdioServerTransport());
logger.info("server.start", { transport: "stdio", provider: "codex-cli", model: provider.modelLabel });
