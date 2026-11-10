/**
 * Origin allowlist for the MCP endpoint. A request without Origin (server-to-server,
 * which is how claude.ai connects) is allowed; a browser request must come from:
 * - this server's own origin,
 * - claude.ai / claude.com,
 * - any origin listed in ALLOWED_ORIGINS,
 * - or, when PUBLIC_URL is a loopback address (wrangler dev), any loopback origin.
 */
const DEFAULT_ORIGINS = ["https://claude.ai", "https://claude.com"];

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function originAllowed(origin: string, publicUrl: string, extra?: string): boolean {
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  if (origin === "null") return false;
  const normalised = o.origin.toLowerCase();
  const allowed = new Set([
    new URL(publicUrl).origin.toLowerCase(),
    ...DEFAULT_ORIGINS,
    ...(extra ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, "").toLowerCase())
      .filter(Boolean),
  ]);
  if (allowed.has(normalised)) return true;
  const self = new URL(publicUrl);
  return LOOPBACK.has(self.hostname) && LOOPBACK.has(o.hostname) && (o.protocol === "http:" || o.protocol === "https:");
}
