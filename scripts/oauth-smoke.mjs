#!/usr/bin/env node
// End-to-end check of the hosted server: DCR, PKCE authorize with the consent
// form, token exchange, refresh, then MCP tool calls over Streamable HTTP.
// Usage: node scripts/oauth-smoke.mjs <base-url> <username>   (passphrase on stdin)
//   e.g. printf '%s' "$PASS" | node scripts/oauth-smoke.mjs http://localhost:8787 devuser
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const base = (process.argv[2] ?? "http://localhost:8787").replace(/\/+$/, "");
const username = process.argv[3] ?? "devuser";
let passphrase = "";
for await (const c of process.stdin) passphrase += c;
passphrase = passphrase.replace(/\r?\n$/, "");
const which = process.argv[4] ?? "debate";

const REDIRECT = "http://127.0.0.1:9999/callback";
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`FAIL: ${msg}`);
    process.exit(1);
  }
  console.log(`ok   ${msg}`);
};

// 1. Dynamic client registration
const reg = await fetch(`${base}/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ client_name: "oauth-smoke", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
});
const client = await reg.json();
ok(reg.status === 201 && client.client_id, `DCR registered client (${reg.status})`);

async function authorize(user, pass) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const state = b64url(crypto.getRandomValues(new Uint8Array(8)));
  const q = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: REDIRECT,
    scope: "mcp",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: `${base}/mcp`,
  });
  const page = await fetch(`${base}/authorize?${q}`);
  const html = await page.text();
  const cookies = page.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const handle = html.match(/name="handle" value="([^"]+)"/)?.[1];
  const res = await fetch(`${base}/authorize?${q}`, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookies },
    body: new URLSearchParams({ handle: handle ?? "", decision: "approve", username: user, passphrase: pass }),
  });
  return { page, html, handle, res, verifier, state };
}

// 2. Wrong passphrase is refused
{
  const { page, html, handle, res } = await authorize(username, "definitely-wrong-passphrase");
  ok(page.status === 200 && handle, "consent page served with a handle");
  ok(page.headers.get("x-frame-options") === "DENY", "consent page forbids framing");
  ok(html.includes("oauth-smoke") && html.includes("127.0.0.1"), "consent page shows client name and redirect host");
  ok(html.match(/name="decision" value="(\w+)"/)?.[1] === "approve", "Enter submits approve (first submit button)");
  ok(res.status === 401, `wrong passphrase rejected (${res.status})`);
}

// 3. Correct passphrase -> code -> tokens
const { res, verifier, state } = await authorize(username, passphrase);
ok(res.status === 302, `correct passphrase redirects (${res.status})`);
const cb = new URL(res.headers.get("location"));
ok(cb.origin + cb.pathname === REDIRECT && cb.searchParams.get("state") === state, "redirect goes to client with state");
const code = cb.searchParams.get("code");
ok(code, "authorization code issued");

const tokenRes = await fetch(`${base}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    client_id: client.client_id,
    code_verifier: verifier,
    resource: `${base}/mcp`,
  }),
});
const tokens = await tokenRes.json();
ok(tokenRes.status === 200 && tokens.access_token && tokens.refresh_token, `token exchange (${tokenRes.status}, expires_in=${tokens.expires_in})`);

// 4. Refresh rotates the refresh token
const refreshRes = await fetch(`${base}/token`, {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: client.client_id }),
});
const refreshed = await refreshRes.json();
ok(refreshRes.status === 200 && refreshed.refresh_token && refreshed.refresh_token !== tokens.refresh_token, "refresh rotates token");

// 5. MCP over Streamable HTTP with the bearer token
const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
  requestInit: { headers: { Authorization: `Bearer ${refreshed.access_token}` } },
});
const mcp = new Client({ name: "oauth-smoke", version: "0" });
await mcp.connect(transport);
const { tools } = await mcp.listTools();
ok(tools.length === 5, `tools/list returns ${tools.map((t) => t.name).join(", ")}`);

const call = async (name, args) => {
  const t0 = Date.now();
  const r = await mcp.callTool({ name, arguments: args }, undefined, { timeout: 240_000 });
  ok(!r.isError, `${name} (${Date.now() - t0}ms)`);
  if (process.env.VERBOSE) for (const c of r.content) console.log(c.text);
  return r;
};

if (which === "critique" || which === "all") {
  await call("gpt_critique", { draft: "function avg(xs) { return xs.reduce((a, b) => a + b) / xs.length }", rubric: "handle empty arrays" });
}
if (which === "debate" || which === "all") {
  const o = await call("debate_open", { question: "Tabs or spaces?", claude_position: "Spaces: consistent rendering everywhere.", rounds: 2 });
  const id = o.structuredContent.debate_id;
  await call("debate_turn", { debate_id: id, rebuttal: "Rendering consistency matters more than personal width preference." });
  await call("debate_turn", { debate_id: id, rebuttal: "Closing: tooling has made spaces free to type." });
  const extra = await mcp.callTool({ name: "debate_turn", arguments: { debate_id: id, rebuttal: "one too many" } });
  ok(extra.isError && extra.content[0].text.includes("rounds_complete"), "turn after last round rejected");
  await call("debate_verdict", { debate_id: id });
  console.log(`debate_id=${id}`);
}
if (which === "synthesize" || which === "all") {
  await call("synthesize", { question: "What is the boiling point of water at sea level in Fahrenheit?", claude_answer: "212°F." });
}
await mcp.close();

// 6. A bad token is refused
const bad = await fetch(`${base}/mcp`, {
  method: "POST",
  headers: { Authorization: "Bearer nope", "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
});
ok(bad.status === 401, `invalid token rejected (${bad.status})`);
console.log("\nAll checks passed.");
