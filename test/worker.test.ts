import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { DebateRecord } from "../src/core/debateStore.js";
import { D1DebateStore } from "../src/worker/d1Store.js";
import { LoginLimiter } from "../src/worker/loginLimiter.js";
import { originAllowed } from "../src/worker/origin.js";
import { hashPassphrase, parseUsers, verifyPassphrase } from "../src/worker/passphrase.js";
import type { SqlDb, SqlStatement } from "../src/worker/sql.js";
import { FakeProvider } from "../src/providers/fake.js";
import { connect, debaterJson, fakeClock, textOf, verdictJson } from "./helpers.js";

/** D1-shaped adapter over node:sqlite, with the real migration applied. */
function sqliteDb(): SqlDb {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(resolve(__dirname, "../migrations/0001_init.sql"), "utf8"));
  const stmt = (sql: string, params: unknown[] = []): SqlStatement => ({
    bind: (...values) => stmt(sql, values),
    first: async <T>() => (db.prepare(sql).get(...(params as any[])) as T) ?? null,
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...(params as any[])).changes) } }),
  });
  return { prepare: (sql) => stmt(sql) };
}

const rec = (over: Partial<DebateRecord> = {}): DebateRecord => ({
  id: "dbt_1",
  ownerId: "alice",
  question: "q",
  maxRounds: 2,
  roundsCompleted: 0,
  status: "open",
  turns: [{ speaker: "claude", round: 0, text: "hi" }],
  createdAt: 0,
  updatedAt: 0,
  expiresAt: 1e15,
  version: 1,
  ...over,
});

describe("D1DebateStore", () => {
  it("round-trips a record and scopes by owner", async () => {
    const s = new D1DebateStore(sqliteDb());
    await s.create(rec());
    expect(await s.get("alice", "dbt_1")).toEqual(rec());
    expect(await s.get("bob", "dbt_1")).toBeNull();
    expect(await s.get("alice", "dbt_nope")).toBeNull();
  });

  it("updates only on the expected version and owner", async () => {
    const s = new D1DebateStore(sqliteDb());
    await s.create(rec());
    expect(await s.update(rec({ version: 2, roundsCompleted: 1 }), 1)).toBe(true);
    expect(await s.update(rec({ version: 3 }), 1)).toBe(false); // stale
    expect(await s.update(rec({ ownerId: "bob", version: 3 }), 2)).toBe(false); // wrong owner
    expect((await s.get("alice", "dbt_1"))!.roundsCompleted).toBe(1);
  });

  it("purges long-expired debates when creating", async () => {
    let t = 0;
    const s = new D1DebateStore(sqliteDb(), { now: () => t, graceMs: 100 });
    await s.create(rec({ id: "old", expiresAt: 10 }));
    t = 500;
    await s.create(rec({ id: "new", expiresAt: 1e15 }));
    expect(await s.get("alice", "old")).toBeNull();
    expect(await s.get("alice", "new")).not.toBeNull();
  });

  it("backs a full debate through the MCP tools, per user", async () => {
    const clock = fakeClock();
    const store = new D1DebateStore(sqliteDb(), { now: clock.now });
    let user = "alice";
    const provider = new FakeProvider((req, i) => (req.instructions.includes("moderator") ? verdictJson() : debaterJson(`ARG-${i}`)));
    const client = await connect({ provider, store, resolveOwnerId: () => user, now: clock.now });
    const o: any = await client.callTool({ name: "debate_open", arguments: { question: "q", claude_position: "p", rounds: 1 } });
    const id = o.structuredContent.debate_id;
    user = "bob";
    expect(textOf(await client.callTool({ name: "debate_turn", arguments: { debate_id: id, rebuttal: "r" } }))).toContain("unknown_debate");
    user = "alice";
    const t: any = await client.callTool({ name: "debate_turn", arguments: { debate_id: id, rebuttal: "r" } });
    expect(t.structuredContent.status).toBe("rounds_complete");
    const v: any = await client.callTool({ name: "debate_verdict", arguments: { debate_id: id } });
    expect(v.isError).toBeFalsy();
    expect((await store.get("alice", id))!.status).toBe("closed");
  });
});

describe("LoginLimiter", () => {
  it("locks a key after max failures within the window, then unlocks", async () => {
    const clock = fakeClock();
    const l = new LoginLimiter(sqliteDb(), { maxFailures: 3, windowMs: 1000, now: clock.now });
    for (let i = 0; i < 2; i++) await l.recordFailure(["user:a", "ip:1"]);
    expect(await l.isLocked(["user:a"])).toBe(false);
    await l.recordFailure(["user:a", "ip:1"]);
    expect(await l.isLocked(["user:a"])).toBe(true);
    expect(await l.isLocked(["user:b", "ip:1"])).toBe(true); // same IP, other user
    expect(await l.isLocked(["user:b", "ip:2"])).toBe(false);
    clock.advance(1001);
    expect(await l.isLocked(["user:a"])).toBe(false);
    await l.recordFailure(["user:a"]); // new window starts at 1
    expect(await l.isLocked(["user:a"])).toBe(false);
  });

  it("clear removes a key", async () => {
    const l = new LoginLimiter(sqliteDb(), { maxFailures: 1 });
    await l.recordFailure(["user:a"]);
    expect(await l.isLocked(["user:a"])).toBe(true);
    await l.clear("user:a");
    expect(await l.isLocked(["user:a"])).toBe(false);
  });
});

describe("passphrases", () => {
  it("verifies the right passphrase and rejects others", async () => {
    const h = await hashPassphrase("correct horse battery", 10_000);
    expect(h).toMatch(/^pbkdf2-sha256\$10000\$/);
    expect(await verifyPassphrase("correct horse battery", h)).toBe(true);
    expect(await verifyPassphrase("wrong", h)).toBe(false);
  });

  it("rejects unknown users and malformed hashes", async () => {
    expect(await verifyPassphrase("x", undefined)).toBe(false);
    expect(await verifyPassphrase("x", "plaintext")).toBe(false);
    expect(await verifyPassphrase("x", "pbkdf2-sha256$999999999$AA==$AA==")).toBe(false);
  });

  it("uses a fresh salt each time", async () => {
    expect(await hashPassphrase("same", 10_000)).not.toBe(await hashPassphrase("same", 10_000));
  });

  it("parses the USERS secret and drops invalid names", () => {
    const u = parseUsers(JSON.stringify({ alice: "h1", "Bad Name": "h2", bob: 5 }));
    expect([...u.keys()]).toEqual(["alice"]);
    expect(parseUsers(undefined).size).toBe(0);
    expect(() => parseUsers("not json")).toThrow();
    expect(() => parseUsers("[]")).toThrow();
  });
});

describe("originAllowed", () => {
  const prod = "https://llm-sparring.x.workers.dev";
  it.each([
    ["https://claude.ai", prod, undefined, true],
    ["https://claude.com", prod, undefined, true],
    ["https://llm-sparring.x.workers.dev", prod, undefined, true],
    ["https://evil.example", prod, undefined, false],
    ["https://claude.ai.evil.example", prod, undefined, false],
    ["http://localhost:6274", prod, undefined, false],
    ["http://localhost:6274", "http://localhost:8787", undefined, true],
    ["http://127.0.0.1:5173", "http://localhost:8787", undefined, true],
    ["https://inspector.example", prod, "https://inspector.example/", true],
    ["null", prod, undefined, false],
    ["not a url", prod, undefined, false],
  ])("%s against %s (extra %s) -> %s", (origin, pub, extra, expected) => {
    expect(originAllowed(origin, pub, extra)).toBe(expected);
  });
});
