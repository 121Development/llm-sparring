import type { GptProvider, GptRequest } from "../core/provider.js";

type Responder = string | Error | ((req: GptRequest, callIndex: number) => string | Promise<string>);

/**
 * Deterministic provider for tests and offline development.
 * Records every request so tests can assert on prompt assembly.
 */
export class FakeProvider implements GptProvider {
  readonly modelLabel: string;
  readonly calls: GptRequest[] = [];
  private readonly queue: Responder[];

  constructor(responses: Responder | Responder[] = "{}", modelLabel = "fake-gpt") {
    this.queue = Array.isArray(responses) ? [...responses] : [responses];
    this.modelLabel = modelLabel;
  }

  async complete(req: GptRequest): Promise<string> {
    const idx = this.calls.length;
    this.calls.push(req);
    // Use queued responses in order; repeat the last one when exhausted.
    const r = this.queue[Math.min(idx, this.queue.length - 1)];
    if (r === undefined) return "";
    if (r instanceof Error) throw r;
    return typeof r === "function" ? r(req, idx) : r;
  }
}

/**
 * Canned replies shaped like real GPT output for each tool, keyed off the
 * instructions. For exercising the hosted flow without an OpenAI key.
 */
export function demoProvider(): FakeProvider {
  return new FakeProvider((req, i) => {
    const ins = req.instructions;
    if (ins.includes("rigorous, independent reviewer")) {
      return JSON.stringify({
        summary: "[demo] Canned critique; no model was called.",
        issues: [{ severity: "minor", title: "Demo issue", explanation: "This is placeholder output.", fix: "Configure OPENAI_API_KEY." }],
      });
    }
    if (ins.includes("impartial debate moderator")) {
      return JSON.stringify({
        settled: [{ point: "[demo] placeholder", favours: "both", why: "canned" }],
        unresolved: [{ point: "[demo] everything", what_would_settle_it: "a real model" }],
        stronger_side: "tie",
        reasoning: "Demo verdict; no model was called.",
      });
    }
    if (ins.includes("sharp, honest debater")) {
      return JSON.stringify({ argument: `[demo] Canned rebuttal #${i}.`, disagreements: ["[demo] I dispute your main claim."], concessions: [] });
    }
    if (ins.includes("comparing two independent answers")) {
      return JSON.stringify({ agreements: ["[demo]"], conflicts: [], only_in_a: [], only_in_b: [], merged_answer: "[demo] merged answer" });
    }
    return "[demo] Canned independent answer; no model was called.";
  }, "demo");
}
