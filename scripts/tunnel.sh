#!/usr/bin/env bash
# Expose the local Worker through a Cloudflare quick tunnel so claude.ai can reach it.
# Starts cloudflared, waits for its https://*.trycloudflare.com URL, then runs
# `wrangler dev` with PUBLIC_URL set to that URL. Ctrl-C stops both.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v cloudflared >/dev/null || { echo "cloudflared not found. Install it, e.g.: mise use -g cloudflared" >&2; exit 1; }
PORT="${PORT:-8787}"
LOG="$(mktemp)"
cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${PORT}" >"$LOG" 2>&1 &
TPID=$!
trap 'kill "$TPID" 2>/dev/null || true; rm -f "$LOG"' EXIT

URL=""
for _ in $(seq 1 120); do
  URL="$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' "$LOG" | head -1 || true)"
  [ -n "$URL" ] && break
  kill -0 "$TPID" 2>/dev/null || { cat "$LOG" >&2; exit 1; }
  sleep 0.5
done
[ -n "$URL" ] || { echo "Timed out waiting for the tunnel URL" >&2; cat "$LOG" >&2; exit 1; }

echo
echo "Tunnel ready. Add this URL as a custom connector in claude.ai:"
echo "  ${URL}/mcp"
echo
node_modules/.bin/wrangler dev --port "$PORT" --ip 127.0.0.1 --var "PUBLIC_URL:${URL}"
