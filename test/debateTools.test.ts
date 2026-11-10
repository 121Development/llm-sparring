import { describe, expect, it } from "vitest";
import { InMemoryDebateStore } from "../src/core/debateStore.js";
import { GptError } from "../src/core/provider.js";
import { FakeProvider } from "../src/providers/fake.js";
import { connect, debaterJson, fakeClock, recordingLogger, textOf, verdictJson } from "./helpers.js";

const HOUR = 3600_000;

/** Debater replies for every call, then a verdict when the moderator is asked. */
function debateProvider(verdict = verdictJson("A")) {
  return new FakeProvider((req, i) => (req.instructions.includes("moderator") ? verdict : debaterJson(`OMEGA-ARG-${i}`)));
}

async function open(client: any, rounds = 3) {
  const r: any = await client.callTool({
    name: "debate_open",
    arguments: { question: "Monolith or microservices?", claude_position: "ALPHA-POS: monolith", rounds },
  });
  expect(r.isError).toBeFalsy();
  return r;
}

const turn = (client: any, debate_id: string, rebuttal = "ALPHA-REB") =>
  client.callTool({ name: "debate_turn", arguments: { debate_id, rebuttal } }) as Promise<any>;
const verdict = (client: any, debate_id: string) =>
  client.callTool({ name: "debate_verdict", arguments: { debate_id } }) as Promise<any>;

describe("tool listing", () => {
  it("lists all five tools with titles and the agreed readOnlyHint values", async () => {
    const client = await connect({ provider: new FakeProvider() });
    const { tools } = await client.listTools();
    const hints = Object.fromEntries(tools.map((t) => [t.name, t.annotations?.readOnlyHint]));
    expect(hints).toEqual({
      gpt_critique: true,
      debate_open: false,
      debate_turn: false,
      debate_verdict: false,
      synthesize: true,
    });
    for (const t of tools) {
      expect(t.title).toBeTruthy();
      expect(t.annotations?.destructiveHint).toBe(false);
      expect(t.description).toMatch(/Call this/);
    }
  });
});

describe("debate flow and round counting", () => {
  it("runs a full three-round debate", async () => {
    const provider = debateProvider();
    const client = await connect({ provider, random: () => 0.1 });

    const o = await open(client, 3);
    const id = o.structuredContent.debate_id;
    expect(id).toMatch(/^dbt_/);
    expect(o.structuredContent).toMatchObject({ rounds_completed: 0, max_rounds: 3, rounds_remaining: 3, status: "open" });
    expect(textOf(o)).toContain("OMEGA-ARG-0");
    expect(textOf(o)).toContain("Disagreements:");
    expect(textOf(o)).toMatch(/<external_model_output[^>]*tool="debate_open"/);
    expect(textOf(o)).toContain("call debate_turn");

    for (let round = 1; round <= 3; round++) {
      const r = await turn(client, id, `ALPHA-REB-${round}`);
      expect(r.isError).toBeFalsy();
      expect(r.structuredContent).toMatchObject({ rounds_completed: round, rounds_remaining: 3 - round });
      expect(r.structuredContent.status).toBe(round === 3 ? "rounds_complete" : "open");
      expect(textOf(r)).toContain(`Round ${round} of 3 complete`);
    }
    expect(textOf(await verdict(client, id))).toContain("Settled:");

    // GPT saw the whole history each turn.
    const lastDebaterCall = provider.calls[3]!;
    for (const s of ["ALPHA-POS", "OMEGA-ARG-0", "ALPHA-REB-1", "OMEGA-ARG-1", "ALPHA-REB-2", "OMEGA-ARG-2", "ALPHA-REB-3"]) {
      expect(lastDebaterCall.input).toContain(s);
    }
    expect(provider.calls).toHaveLength(5);
  });

  it("rejects a turn after the last round and points to debate_verdict", async () => {
    const client = await connect({ provider: debateProvider() });
    const id = (await open(client, 1)).structuredContent.debate_id;
    expect((await turn(client, id)).isError).toBeFalsy();
    const r = await turn(client, id);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("rounds_complete");
    expect(textOf(r)).toContain("debate_verdict");
  });

  it("validates rounds between 1 and 5", async () => {
    const client = await connect({ provider: debateProvider() });
    for (const rounds of [0, 6, 2.5]) {
      const r: any = await client.callTool({ name: "debate_open", arguments: { question: "q", claude_position: "p", rounds } });
      expect(r.isError).toBe(true);
    }
  });

  it("defaults to 3 rounds", async () => {
    const client = await connect({ provider: debateProvider() });
    const r: any = await client.callTool({ name: "debate_open", arguments: { question: "q", claude_position: "p" } });
    expect(r.structuredContent.max_rounds).toBe(3);
  });

  it("does not advance the round when GPT fails, so the turn can be retried", async () => {
    let fail = false;
    const provider = new FakeProvider((req, i) => {
      if (fail) throw new GptError("timeout", "slow");
      return debaterJson(`ARG-${i}`);
    });
    const client = await connect({ provider });
    const id = (await open(client, 2)).structuredContent.debate_id;
    fail = true;
    const bad = await turn(client, id);
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("timeout");
    fail = false;
    const ok = await turn(client, id, "RETRY");
    expect(ok.structuredContent.rounds_completed).toBe(1);
  });

  it("warns when GPT names no disagreement", async () => {
    const client = await connect({ provider: new FakeProvider(debaterJson("arg", [])) });
    expect(textOf(await open(client))).toContain("named no explicit disagreement");
  });

  it("allows an early verdict and closes the debate", async () => {
    const provider = debateProvider();
    const client = await connect({ provider });
    const id = (await open(client, 3)).structuredContent.debate_id;
    const v = await verdict(client, id);
    expect(v.isError).toBeFalsy();
    expect(v.structuredContent.rounds_completed).toBe(0);
    const r = await turn(client, id);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("debate_closed");
  });

  it("returns the same verdict on repeat calls without calling GPT again", async () => {
    const provider = debateProvider();
    const client = await connect({ provider, random: () => 0.9 });
    const id = (await open(client)).structuredContent.debate_id;
    const v1 = await verdict(client, id);
    const calls = provider.calls.length;
    const v2 = await verdict(client, id);
    expect(provider.calls.length).toBe(calls);
    expect(v2.structuredContent).toEqual(v1.structuredContent);
    expect(textOf(v2)).toContain("previously issued");
  });

  it("does not close the debate when the verdict can't be parsed", async () => {
    const provider = new FakeProvider((req) => (req.instructions.includes("moderator") ? "rambling" : debaterJson("a")));
    const client = await connect({ provider });
    const id = (await open(client)).structuredContent.debate_id;
    const v = await verdict(client, id);
    expect(v.structuredContent.parsed).toBe(false);
    expect(textOf(v)).toContain("rambling");
    expect((await turn(client, id)).isError).toBeFalsy();
  });
});

describe("verdict A/B randomisation", () => {
  it.each([
    [0.1, "claude"],
    [0.9, "gpt"],
  ] as const)("random=%s puts %s on side A and maps results back", async (rnd, sideA) => {
    const provider = debateProvider(verdictJson("A"));
    const client = await connect({ provider, random: () => rnd });
    const id = (await open(client)).structuredContent.debate_id;
    const v = await verdict(client, id);
    const s = v.structuredContent;
    const sideB = sideA === "claude" ? "gpt" : "claude";

    expect(s.side_a).toBe(sideA);
    expect(s.stronger_side).toBe(sideA);
    expect(s.settled.map((x: any) => x.favours)).toEqual([sideA, sideB, "both"]);
    expect(s.unresolved).toEqual([{ point: "Cost", what_would_settle_it: "real data" }]);

    const judgeInput = provider.calls.at(-1)!.input;
    const claudeLabel = sideA === "claude" ? "A" : "B";
    expect(judgeInput).toContain(`<turn side="${claudeLabel}" stage="opening">\nALPHA-POS`);
    expect(judgeInput).not.toMatch(/claude|gpt|proponent|opponent/i);
    expect(textOf(v)).toContain("Caveat: the moderator is also GPT");
  });

  it("the moderator is a fresh call with its own instructions", async () => {
    const provider = debateProvider();
    const client = await connect({ provider });
    const id = (await open(client)).structuredContent.debate_id;
    await verdict(client, id);
    const call = provider.calls.at(-1)!;
    expect(call.instructions).toMatch(/impartial debate moderator/);
    expect(call.instructions).not.toMatch(/OPPOSING/);
  });
});

describe("unknown, expired and foreign debate ids", () => {
  it("reports an unknown id for turn and verdict", async () => {
    const client = await connect({ provider: debateProvider() });
    for (const r of [await turn(client, "dbt_nope"), await verdict(client, "dbt_nope")]) {
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("unknown_debate");
      expect(textOf(r)).toContain("debate_open");
    }
  });

  it("expires a debate after the TTL of inactivity", async () => {
    const clock = fakeClock();
    const client = await connect({ provider: debateProvider(), now: clock.now, debateTtlMs: 24 * HOUR });
    const id = (await open(client)).structuredContent.debate_id;

    clock.advance(23 * HOUR);
    expect((await turn(client, id)).isError).toBeFalsy(); // activity extends the TTL

    clock.advance(23 * HOUR);
    expect((await turn(client, id)).isError).toBeFalsy();

    clock.advance(25 * HOUR);
    const r = await turn(client, id);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("debate_expired");
    expect(textOf((await verdict(client, id)))).toContain("debate_expired");
  });

  it("reports unknown once an expired debate has been purged", async () => {
    const clock = fakeClock();
    const store = new InMemoryDebateStore({ now: clock.now, graceMs: HOUR });
    const client = await connect({ provider: debateProvider(), now: clock.now, store, debateTtlMs: HOUR });
    const id = (await open(client)).structuredContent.debate_id;
    clock.advance(3 * HOUR);
    await open(client); // creating a debate triggers the sweep
    expect(textOf(await turn(client, id))).toContain("unknown_debate");
  });

  it("scopes debates per user", async () => {
    let user = "alice";
    const client = await connect({ provider: debateProvider(), resolveOwnerId: () => user });
    const id = (await open(client)).structuredContent.debate_id;
    user = "bob";
    expect(textOf(await turn(client, id))).toContain("unknown_debate");
    user = "alice";
    expect((await turn(client, id)).isError).toBeFalsy();
  });

  it("discards a turn that raced another turn on the same debate", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let n = 0;
    const provider = new FakeProvider(async () => {
      n++;
      if (n === 2) await gate; // first debate_turn waits
      return debaterJson(`ARG-${n}`);
    });
    const client = await connect({ provider });
    const id = (await open(client)).structuredContent.debate_id;
    const slow = turn(client, id, "SLOW");
    await new Promise((r) => setTimeout(r, 20));
    const fast = await turn(client, id, "FAST");
    release();
    const slowRes = await slow;
    expect(fast.isError).toBeFalsy();
    expect(slowRes.isError).toBe(true);
    expect(textOf(slowRes)).toContain("concurrent_update");
  });
});

describe("debate logging", () => {
  it("logs ids and sizes, never debate text", async () => {
    const { logger, lines } = recordingLogger();
    const client = await connect({ provider: debateProvider(), logger });
    const id = (await open(client)).structuredContent.debate_id;
    await turn(client, id, "SECRET-REBUTTAL");
    await verdict(client, id);
    const dump = JSON.stringify(lines);
    for (const s of ["Monolith", "ALPHA-POS", "SECRET-REBUTTAL", "OMEGA-ARG", "Point favouring"]) expect(dump).not.toContain(s);
    expect(dump).toContain(id);
    expect(lines.find((l) => l.fields?.tool === "debate_turn" && l.event === "tool.ok")?.fields).toMatchObject({ round: 1 });
  });
});
