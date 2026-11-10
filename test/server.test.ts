import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { LogFields, Logger } from "../src/core/log.js";
import { GptError } from "../src/core/provider.js";
import { createServer } from "../src/core/server.js";
import { FakeProvider } from "../src/providers/fake.js";

async function connect(provider: FakeProvider, logger?: Logger) {
  const server = createServer({ provider, logger });
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

function recordingLogger() {
  const lines: { event: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    info: (event, fields) => lines.push({ event, fields }),
    error: (event, fields) => lines.push({ event, fields }),
  };
  return { logger, lines };
}

const goodReply = JSON.stringify({
  summary: "Has a bug.",
  issues: [
    { severity: "minor", title: "Naming", explanation: "Unclear name", fix: "Rename" },
    { severity: "critical", title: "Crash", explanation: "Null deref", quote: "x.y", fix: "Check x" },
  ],
});

const textOf = (r: any) => (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

describe("gpt_critique tool", () => {
  it("is listed with a title, description and annotations", async () => {
    const client = await connect(new FakeProvider(goodReply));
    const { tools } = await client.listTools();
    const t = tools.find((x) => x.name === "gpt_critique")!;
    expect(t.title).toBe("Critique with GPT");
    expect(t.annotations?.readOnlyHint).toBe(true);
    expect(t.annotations?.destructiveHint).toBe(false);
    expect(t.description).toMatch(/Call this when/);
    expect(t.inputSchema.required).toEqual(["draft"]);
    expect(t.outputSchema).toBeDefined();
  });

  it("returns ranked issues as delimited external output plus structured content", async () => {
    const provider = new FakeProvider(goodReply, "gpt-test");
    const client = await connect(provider);
    const r: any = await client.callTool({ name: "gpt_critique", arguments: { draft: "code here", rubric: "be safe" } });

    expect(r.isError).toBeFalsy();
    expect(r.structuredContent.parsed).toBe(true);
    expect(r.structuredContent.model).toBe("gpt-test");
    expect(r.structuredContent.issues.map((i: any) => i.severity)).toEqual(["critical", "minor"]);

    const text = textOf(r);
    expect(text).toMatch(/^Quoted output from an external model \(OpenAI GPT, model: gpt-test/);
    expect(text).toContain('<external_model_output source="gpt" model="gpt-test" tool="gpt_critique">');
    expect(text.indexOf("[CRITICAL] Crash")).toBeLessThan(text.indexOf("[MINOR] Naming"));

    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0]!.input).toContain("<draft>\ncode here\n</draft>");
    expect(provider.calls[0]!.input).toContain("<rubric>\nbe safe\n</rubric>");
  });

  it("falls back to raw text when GPT does not return JSON", async () => {
    const client = await connect(new FakeProvider("The draft is fine, honestly."));
    const r: any = await client.callTool({ name: "gpt_critique", arguments: { draft: "d" } });
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toMatchObject({ parsed: false, issues: [] });
    expect(textOf(r)).toContain("The draft is fine, honestly.");
  });

  it("turns provider errors into a clear tool error", async () => {
    const client = await connect(new FakeProvider(new GptError("plan_limit", "Usage limit reached. Wait and retry.")));
    const r: any = await client.callTool({ name: "gpt_critique", arguments: { draft: "d" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/gpt_critique failed \(plan_limit, call [0-9a-f-]+\): Usage limit reached/);
  });

  it("hides unexpected internal error messages", async () => {
    const client = await connect(new FakeProvider(new Error("secret internals")));
    const r: any = await client.callTool({ name: "gpt_critique", arguments: { draft: "d" } });
    expect(r.isError).toBe(true);
    expect(textOf(r)).not.toContain("secret internals");
    expect(textOf(r)).toContain("internal");
  });

  it("rejects an empty draft", async () => {
    const client = await connect(new FakeProvider(goodReply));
    const r: any = await client.callTool({ name: "gpt_critique", arguments: { draft: "" } });
    expect(r.isError).toBe(true);
  });

  it("never logs draft, rubric or GPT output text", async () => {
    const { logger, lines } = recordingLogger();
    const draft = "TOP-SECRET-DRAFT-CONTENT";
    const rubric = "PRIVATE-RUBRIC";
    const client = await connect(new FakeProvider(goodReply), logger);
    await client.callTool({ name: "gpt_critique", arguments: { draft, rubric } });
    const dump = JSON.stringify(lines);
    expect(lines.map((l) => l.event)).toEqual(["tool.start", "tool.ok"]);
    expect(dump).not.toContain(draft);
    expect(dump).not.toContain(rubric);
    expect(dump).not.toContain("Null deref");
    expect(lines[0]!.fields).toMatchObject({ draftBytes: draft.length, rubricBytes: rubric.length });
  });
});
