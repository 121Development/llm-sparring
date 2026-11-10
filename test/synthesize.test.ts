import { describe, expect, it } from "vitest";
import { GptError } from "../src/core/provider.js";
import { FakeProvider } from "../src/providers/fake.js";
import { connect, recordingLogger, textOf } from "./helpers.js";

const mergeJson = JSON.stringify({
  agreements: ["Both say 42"],
  conflicts: [{ point: "Units", a_says: "metres", b_says: "feet", assessment: "A cites a source", better_supported: "A" }],
  only_in_a: ["A-only point"],
  only_in_b: ["B-only point"],
  merged_answer: "MERGED",
});

function synthProvider(merge: string | Error = mergeJson) {
  return new FakeProvider(["OMEGA-INDEPENDENT-ANSWER", merge]);
}

const call = (client: any, args = { question: "What is the answer?", claude_answer: "ALPHA-ANSWER (Claude here)" }) =>
  client.callTool({ name: "synthesize", arguments: args }) as Promise<any>;

describe("synthesize", () => {
  it("answers blind first, then merges blind", async () => {
    const provider = synthProvider();
    const client = await connect({ provider, random: () => 0.1 });
    const r = await call(client);
    expect(r.isError).toBeFalsy();
    expect(provider.calls).toHaveLength(2);

    const [answerCall, mergeCall] = provider.calls;
    expect(answerCall!.input).toContain("What is the answer?");
    expect(answerCall!.input).not.toContain("ALPHA-ANSWER");
    expect(mergeCall!.input).toContain("OMEGA-INDEPENDENT-ANSWER");
    expect(mergeCall!.input).toContain("ALPHA-ANSWER");
    expect(mergeCall!.input).not.toContain("Claude here");
    expect(mergeCall!.input).toContain("[assistant] here");

    const text = textOf(r);
    expect(text).toContain("OMEGA-INDEPENDENT-ANSWER");
    expect(text).toContain("MERGED");
    expect(r.structuredContent).toMatchObject({ gpt_answer: "OMEGA-INDEPENDENT-ANSWER", merge_parsed: true, merge_failed: false });
  });

  it.each([
    [0.1, "claude"],
    [0.9, "gpt"],
  ] as const)("random=%s shows %s as Answer A and maps labels back", async (rnd, sideA) => {
    const provider = synthProvider();
    const client = await connect({ provider, random: () => rnd });
    const r = await call(client);
    const mergeInput = provider.calls[1]!.input;
    const aBlock = mergeInput.slice(mergeInput.indexOf("<answer_a>"), mergeInput.indexOf("</answer_a>"));
    expect(aBlock).toContain(sideA === "claude" ? "ALPHA-ANSWER" : "OMEGA-INDEPENDENT-ANSWER");
    expect(r.structuredContent.side_a).toBe(sideA);

    const nameA = sideA === "claude" ? "Claude" : "GPT";
    const nameB = sideA === "claude" ? "GPT" : "Claude";
    const text = textOf(r);
    expect(text).toContain(`${nameA}: metres`);
    expect(text).toContain(`${nameB}: feet`);
    expect(text).toContain(`Better supported: ${nameA}.`);
    expect(text).toContain(`Only in ${nameA}'s answer:\n- A-only point`);
  });

  it("keeps GPT's answer when the merge call fails", async () => {
    const client = await connect({ provider: synthProvider(new GptError("plan_limit", "Limit hit.")) });
    const r = await call(client);
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ merge_failed: true, gpt_answer: "OMEGA-INDEPENDENT-ANSWER" });
    expect(textOf(r)).toContain("comparison step failed (plan_limit)");
  });

  it("is a tool error when the first call fails", async () => {
    const client = await connect({ provider: new FakeProvider(new GptError("timeout", "slow")) });
    const r = await call(client);
    expect(r.isError).toBe(true);
  });

  it("returns raw comparison text when it isn't JSON", async () => {
    const client = await connect({ provider: synthProvider("free-form comparison"), random: () => 0.9 });
    const r = await call(client);
    expect(r.structuredContent.merge_parsed).toBe(false);
    expect(textOf(r)).toContain("Answer A = GPT");
    expect(textOf(r)).toContain("free-form comparison");
  });

  it("never logs question or answer text", async () => {
    const { logger, lines } = recordingLogger();
    const client = await connect({ provider: synthProvider(), logger });
    await call(client);
    const dump = JSON.stringify(lines);
    for (const s of ["What is the answer", "ALPHA-ANSWER", "OMEGA-INDEPENDENT", "MERGED"]) expect(dump).not.toContain(s);
  });
});
