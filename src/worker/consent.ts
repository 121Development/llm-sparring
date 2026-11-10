import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import type { Logger } from "../core/log.js";
import { LoginLimiter } from "./loginLimiter.js";
import { parseUsers, USERNAME_RE, verifyPassphrase } from "./passphrase.js";
import type { SqlDb } from "./sql.js";

export const SCOPES = ["mcp"];

export interface ConsentEnv {
  OAUTH_PROVIDER: OAuthHelpers;
  DB: SqlDb;
  USERS?: string;
}

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Security headers for every HTML page. No framing, no scripts, no external loads. */
function pageHeaders(base?: Headers): Headers {
  const h = new Headers(base);
  h.set("Content-Type", "text/html; charset=utf-8");
  h.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'");
  h.set("X-Frame-Options", "DENY");
  h.set("X-Content-Type-Options", "nosniff");
  h.set("Referrer-Policy", "no-referrer");
  h.set("Cache-Control", "no-store");
  return h;
}

function layout(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title>
<style>
  :root { --bg:#f6f5f2; --card:#fff; --fg:#1d1d1b; --muted:#6b6a65; --border:#dedcd5; --accent:#1d1d1b; --accent-fg:#fff; --warn-bg:#fff4e0; --warn-fg:#7a4b00; --err-bg:#fde8e6; --err-fg:#8a1f12; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161615; --card:#21211f; --fg:#ecebe6; --muted:#a3a29c; --border:#3a3936; --accent:#ecebe6; --accent-fg:#161615; --warn-bg:#3a2d12; --warn-fg:#f3cf8a; --err-bg:#3d1d19; --err-fg:#f5b3a9; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; display:flex; min-height:100vh; align-items:center; justify-content:center; padding:16px; }
  main { width:100%; max-width:420px; background:var(--card); border:1px solid var(--border); border-radius:12px; padding:28px; }
  h1 { font-size:20px; margin:0 0 12px; line-height:1.3; }
  p { margin:0 0 12px; color:var(--muted); }
  strong { color:var(--fg); }
  label { display:block; font-size:14px; font-weight:600; margin:14px 0 6px; }
  input[type=text], input[type=password] { width:100%; padding:10px 12px; font:inherit; color:var(--fg); background:var(--bg); border:1px solid var(--border); border-radius:8px; }
  .row { display:flex; gap:10px; margin-top:20px; }
  .row.reverse { flex-direction:row-reverse; }
  button { flex:1; padding:10px 14px; font:inherit; font-weight:600; border-radius:8px; border:1px solid var(--border); background:transparent; color:var(--fg); cursor:pointer; }
  button.primary { background:var(--accent); color:var(--accent-fg); border-color:var(--accent); }
  .note { padding:10px 12px; border-radius:8px; font-size:14px; margin:12px 0; }
  .warn { background:var(--warn-bg); color:var(--warn-fg); }
  .err { background:var(--err-bg); color:var(--err-fg); }
  code { font-size:14px; }
</style></head><body><main>${body}</main></body></html>`;
}

function consentPage(d: ConsentDescription, handle: string): string {
  const name = escape(d.clientName);
  const origin = d.clientDomain
    ? `Published by <strong>${escape(d.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  return layout(
    `Sign in to llm-sparring`,
    `<h1>Allow ${name} to use llm-sparring?</h1>
<p>${origin} Access will be sent to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? '<div class="note warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started signing in from it.</div>' : ""}
<p>It will be able to send text to GPT on this server's OpenAI account and keep debates under your username.</p>
<form method="post" autocomplete="on">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <label for="u">Username</label>
  <input id="u" type="text" name="username" autocomplete="username" autocapitalize="none" spellcheck="false" required maxlength="32">
  <label for="p">Passphrase</label>
  <input id="p" type="password" name="passphrase" autocomplete="current-password" required maxlength="256">
  <!-- Approve comes first in the markup so pressing Enter submits it (browsers use the
       first submit button); row-reverse still shows Deny on the left. -->
  <div class="row reverse">
    <button type="submit" name="decision" value="approve" class="primary">Sign in and allow</button>
    <button type="submit" name="decision" value="deny" formnovalidate>Deny</button>
  </div>
</form>`,
  );
}

function messagePage(status: number, title: string, message: string, extra = ""): Response {
  return new Response(layout(title, `<h1>${escape(title)}</h1><div class="note err">${escape(message)}</div>${extra}`), {
    status,
    headers: pageHeaders(),
  });
}

const BACK = '<p>Use your browser\'s Back button to try again, or restart the connection from Claude.</p>';

export async function handleAuthorize(request: Request, env: ConsentEnv, logger: Logger): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") {
      const authRequest = await oauth.parseAuthRequest(request);
      const details = await oauth.describeConsent(authRequest);
      const consent = await oauth.beginConsent(authRequest);
      return new Response(consentPage(details, consent.handle), { headers: pageHeaders(consent.headers) });
    }

    if (request.method !== "POST") return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });

    const form = await request.formData();
    const handle = String(form.get("handle") ?? "");

    if (form.get("decision") !== "approve") {
      const denied = await oauth.denyConsent(request, handle);
      logger.info("auth.denied", {});
      return new Response(null, { status: 302, headers: denied.headers });
    }

    const username = String(form.get("username") ?? "").trim().toLowerCase();
    const passphrase = String(form.get("passphrase") ?? "");
    const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
    const limiter = new LoginLimiter(env.DB);
    const keys = [`user:${username}`, `ip:${ip}`];

    if (await limiter.isLocked(keys)) {
      logger.info("auth.locked", {});
      return messagePage(429, "Too many attempts", `Sign-in is locked for ${limiter.windowMs / 60_000} minutes after repeated failures.`);
    }

    let users: Map<string, string>;
    try {
      users = parseUsers(env.USERS);
    } catch {
      logger.error("auth.config_error", { reason: "users_secret_invalid" });
      return messagePage(500, "Server not configured", "The USERS secret is invalid. The server owner needs to fix it.");
    }
    if (users.size === 0) {
      logger.error("auth.config_error", { reason: "no_users" });
      return messagePage(500, "Server not configured", "No users are configured. The server owner needs to set the USERS secret.");
    }

    const ok = USERNAME_RE.test(username) && (await verifyPassphrase(passphrase, users.get(username)));
    if (!ok) {
      await limiter.recordFailure(keys);
      logger.info("auth.failure", {});
      return messagePage(401, "Sign-in failed", "Wrong username or passphrase.", BACK);
    }
    await limiter.clear(`user:${username}`);

    const approved = await oauth.approveConsent(request, handle, { scope: SCOPES });
    const { redirectTo } = await oauth.completeAuthorization({
      request: approved.request,
      userId: username,
      metadata: {},
      scope: approved.request.scope,
      props: { userId: username },
    });
    logger.info("auth.success", { userId: username });
    approved.headers.set("Location", redirectTo);
    return new Response(null, { status: 302, headers: approved.headers });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) {
      return Response.redirect(error.redirectTo, 302);
    }
    if (error instanceof AuthorizationError) {
      logger.info("auth.request_error", { code: error.code });
      return messagePage(400, "Can't continue", error.description, BACK);
    }
    if (error instanceof CimdFetchError) {
      logger.info("auth.cimd_error", { reason: error.reason });
      return messagePage(400, "Can't verify this app", "This app's client metadata could not be fetched.");
    }
    throw error;
  }
}

export function landingPage(publicUrl: string): Response {
  const url = `${publicUrl.replace(/\/+$/, "")}/mcp`;
  return new Response(
    layout(
      "llm-sparring",
      `<h1>llm-sparring</h1><p>An MCP server that lets Claude consult GPT as a critic, debate opponent and second answerer.</p>
<p>To use it, add this URL as a custom connector in Claude:</p><p><code>${escape(url)}</code></p>`,
    ),
    { headers: pageHeaders() },
  );
}
