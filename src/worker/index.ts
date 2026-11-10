import { insufficientScope, type OAuthHelpers, OAuthProvider, type OAuthResourceAuth } from "@cloudflare/workers-oauth-provider";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { Logger, LogFields } from "../core/log.js";
import { GptError, type GptProvider } from "../core/provider.js";
import { createServer } from "../core/server.js";
import { ApiKeyProvider } from "../providers/apiKey.js";
import { demoProvider } from "../providers/fake.js";
import { handleAuthorize, landingPage, SCOPES } from "./consent.js";
import { D1DebateStore } from "./d1Store.js";
import { originAllowed } from "./origin.js";

export interface Env {
  OAUTH_KV: KVNamespace;
  DB: D1Database;
  /** Injected by OAuthProvider for the default handler. */
  OAUTH_PROVIDER: OAuthHelpers;
  /**
   * Public base URL, e.g. https://llm-sparring.example.workers.dev. Optional: defaults to the
   * request's origin. Set it when running behind a tunnel or proxy.
   */
  PUBLIC_URL?: string;
  GPT_MODEL: string;
  GPT_REASONING_EFFORT?: string;
  /** "openai" (default) or "demo" for canned replies without an API key. */
  GPT_PROVIDER?: string;
  /** Comma-separated extra allowed Origins for /mcp. */
  ALLOWED_ORIGINS?: string;
  // Secrets
  OPENAI_API_KEY?: string;
  USERS?: string;
}

interface Props {
  userId: string;
}

/** Workers logs: JSON lines, metadata only. */
const logger: Logger = {
  info: (event, fields) => console.log(line("info", event, fields)),
  error: (event, fields) => console.error(line("error", event, fields)),
};
const line = (level: string, event: string, fields?: LogFields) => JSON.stringify({ level, event, ...fields });

const MCP_PATH = "/mcp";

/** Stands in when the key is missing, so the client can still connect and list tools. */
const missingKeyProvider = (model: string): GptProvider => ({
  modelLabel: model,
  async complete() {
    logger.error("config.error", { reason: "no_openai_key" });
    throw new GptError(
      "upstream",
      "This server has no OpenAI API key configured (OPENAI_API_KEY). The server owner needs to set it; GPT tools can't run until then.",
    );
  },
});

function gptProvider(env: Env): GptProvider {
  if (env.GPT_PROVIDER === "demo") return demoProvider();
  if (!env.OPENAI_API_KEY) return missingKeyProvider(env.GPT_MODEL);
  return new ApiKeyProvider({
    apiKey: env.OPENAI_API_KEY,
    model: env.GPT_MODEL,
    reasoningEffort: env.GPT_REASONING_EFFORT || undefined,
  });
}

const jsonRpcError = (status: number, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });

/** Authenticated MCP endpoint. Stateless: a fresh server and transport per POST. */
const mcpHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { props, auth } = ctx as unknown as { props: Props; auth: OAuthResourceAuth };
    if (!auth.scope.includes("mcp")) return insufficientScope(auth, SCOPES);
    if (request.method !== "POST") return jsonRpcError(405, "Method not allowed. This server is stateless; use POST.", { Allow: "POST" });

    const server = createServer({
      provider: gptProvider(env),
      store: new D1DebateStore(env.DB),
      resolveOwnerId: () => props.userId,
      logger: { info: (e, f) => logger.info(e, { userId: props.userId, ...f }), error: (e, f) => logger.error(e, { userId: props.userId, ...f }) },
    });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};

const defaultHandler = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === "/authorize") return handleAuthorize(request, env, logger);
    if (pathname === "/" && request.method === "GET") return landingPage(env.PUBLIC_URL ?? new URL(request.url).origin);
    return new Response("Not found", { status: 404 });
  },
};

/**
 * Behind a tunnel or proxy the Worker can see http://localhost or a forwarded Host,
 * but OAuth issuer, endpoint and resource URLs must match what the client uses.
 * PUBLIC_URL is the authority, so rebase every request onto its origin.
 */
function canonicalRequest(request: Request, publicUrl: string): Request {
  const url = new URL(request.url);
  const pub = new URL(publicUrl);
  if (url.origin === pub.origin) return request;
  const rebased = new Request(new URL(url.pathname + url.search, pub.origin), request);
  rebased.headers.set("Host", pub.host);
  return rebased;
}

/** One provider per PUBLIC_URL (the canonical resource depends on it). */
const providers = new Map<string, OAuthProvider<Env>>();

function oauthProvider(env: Env): OAuthProvider<Env> {
  const base = (env.PUBLIC_URL ?? "").toLowerCase();
  let p = providers.get(base);
  if (!p) {
    p = new OAuthProvider<Env>({
      apiRoute: MCP_PATH,
      apiHandler: mcpHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      clientIdMetadataDocumentEnabled: true,
      scopesSupported: SCOPES,
      requiredScopes: SCOPES,
      resourceMetadata: {
        resource: `${base}${MCP_PATH}`,
        authorization_servers: [base],
        bearer_methods_supported: ["header"],
        resource_name: "llm-sparring",
      },
      onError: ({ code, status }) => {
        logger.info("oauth.error", { code, status });
      },
    });
    providers.set(base, p);
  }
  return p;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const publicUrl = (env.PUBLIC_URL || new URL(request.url).origin).replace(/\/+$/, "");
    request = canonicalRequest(request, publicUrl);
    env = { ...env, PUBLIC_URL: publicUrl };
    const url = new URL(request.url);

    // MCP spec: validate Origin on the MCP endpoint (DNS rebinding); 403 if present and not allowed.
    if (url.pathname === MCP_PATH || url.pathname.startsWith(`${MCP_PATH}/`)) {
      const origin = request.headers.get("Origin");
      if (origin && !originAllowed(origin, publicUrl, env.ALLOWED_ORIGINS)) {
        logger.info("mcp.origin_rejected", {});
        return jsonRpcError(403, "Forbidden: Origin not allowed.");
      }
    }
    return oauthProvider(env).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
