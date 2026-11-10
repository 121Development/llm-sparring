/**
 * PBKDF2-SHA256 passphrase hashes, WebCrypto only (runs on Workers and Node).
 * Format: pbkdf2-sha256$<iterations>$<salt base64>$<hash base64>
 * Workers caps PBKDF2 at 100,000 iterations.
 */
export const ITERATIONS = 100_000;

const enc = new TextEncoder();

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

async function derive(passphrase: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", enc.encode(passphrase), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassphrase(passphrase: string, iterations = ITERATIONS): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(passphrase, salt, iterations);
  return `pbkdf2-sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}

/** A well-formed hash nobody knows the passphrase for, to keep timing similar for unknown users. */
const DUMMY = "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export async function verifyPassphrase(passphrase: string, stored: string | undefined): Promise<boolean> {
  const parts = (stored ?? DUMMY).split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2-sha256") return false;
  const iterations = Number(parts[1]);
  if (!Number.isInteger(iterations) || iterations < 10_000 || iterations > ITERATIONS) return false;
  const expected = unb64(parts[3]!);
  const actual = await derive(passphrase, unb64(parts[2]!), iterations);
  return stored !== undefined && timingSafeEqual(actual, expected);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Parse the USERS secret: JSON object of username -> hash. */
export function parseUsers(raw: string | undefined): Map<string, string> {
  if (!raw) return new Map();
  let obj: unknown;
  try {
    obj = JSON.parse(raw);
  } catch {
    throw new Error("USERS secret is not valid JSON");
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw new Error("USERS secret must be a JSON object");
  const users = new Map<string, string>();
  for (const [name, hash] of Object.entries(obj)) {
    if (typeof hash === "string" && USERNAME_RE.test(name)) users.set(name, hash);
  }
  return users;
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{0,31}$/;
