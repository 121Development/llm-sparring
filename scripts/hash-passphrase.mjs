#!/usr/bin/env node
// Make a USERS entry for the hosted server.
// Usage: node scripts/hash-passphrase.mjs <username>   (prompts for the passphrase, input hidden)
//    or: printf '%s' "$PASS" | node scripts/hash-passphrase.mjs <username>
// Prints a JSON object to merge into the USERS secret.
import { hashPassphrase, USERNAME_RE } from "../src/worker/passphrase.ts";

const username = (process.argv[2] ?? "").trim().toLowerCase();
if (!USERNAME_RE.test(username)) {
  console.error("Usage: node scripts/hash-passphrase.mjs <username>  (a-z, 0-9, . _ -, max 32 chars)");
  process.exit(1);
}

async function readPassphrase() {
  if (!process.stdin.isTTY) {
    let s = "";
    for await (const chunk of process.stdin) s += chunk;
    return s.replace(/\r?\n$/, "");
  }
  process.stderr.write("Passphrase (hidden): ");
  process.stdin.setRawMode(true);
  process.stdin.setEncoding("utf8");
  let s = "";
  for await (const ch of process.stdin) {
    if (ch === "\r" || ch === "\n") break;
    if (ch === "\u0003") process.exit(130);
    if (ch === "\u007f") s = s.slice(0, -1);
    else s += ch;
  }
  process.stdin.setRawMode(false);
  process.stderr.write("\n");
  return s;
}

const pass = await readPassphrase();
if (pass.length < 12) {
  console.error("Use a passphrase of at least 12 characters.");
  process.exit(1);
}
console.log(JSON.stringify({ [username]: await hashPassphrase(pass) }));
process.exit(0);
