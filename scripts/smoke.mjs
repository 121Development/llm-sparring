#!/usr/bin/env node
// Live smoke test against the built stdio server and real Codex/GPT.
// Usage: pnpm build && node scripts/smoke.mjs [critique|debate|synthesize|all]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const which = process.argv[2] ?? "all";
const transport = new StdioClientTransport({ command: process.execPath, args: ["dist/stdio.js"], stderr: "inherit" });
const client = new Client({ name: "smoke", version: "0" });
await client.connect(transport);

const call = async (name, args) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600_000 });
  console.log(`\n===== ${name} (${Date.now() - t0}ms)${r.isError ? " ERROR" : ""} =====`);
  for (const c of r.content) console.log(c.text);
  if (r.isError) process.exit(1);
  return r;
};

if (which === "critique" || which === "all") {
  await call("gpt_critique", {
    draft: "function avg(xs) { let s = 0; for (let i = 1; i <= xs.length; i++) s += xs[i]; return s / xs.length; }",
    rubric: "JavaScript; must handle empty arrays",
  });
}

if (which === "debate" || which === "all") {
  const o = await call("debate_open", {
    question: "Should a 5-person startup build its first product as microservices?",
    claude_position: "No. A modular monolith is the better default: one deploy, simple debugging, and module boundaries can be split out later once real scaling or team pressures appear.",
    rounds: 3,
  });
  const id = o.structuredContent.debate_id;
  const rebuttals = [
    "Independent scaling rarely matters at this size; a monolith scales horizontally fine. The operational cost of service discovery, distributed tracing and network failure handling is paid from day one.",
    "Clean boundaries come from discipline and module structure, not network hops. Microservices often produce a distributed monolith when the domain isn't understood yet, which is exactly the situation of a new startup.",
    "Closing: the reversible choice is the monolith. Extracting a service later is routine; merging premature services back is painful. Optimise for learning speed now.",
  ];
  for (const rebuttal of rebuttals) await call("debate_turn", { debate_id: id, rebuttal });
  await call("debate_verdict", { debate_id: id });
}

if (which === "synthesize" || which === "all") {
  await call("synthesize", {
    question: "Roughly how much energy (kWh) does a typical modern electric car use per 100 km, and what most affects it?",
    claude_answer: "About 15-20 kWh per 100 km for a typical mid-size EV. Biggest factors: speed (aerodynamic drag rises with the square of speed), cold weather (cabin and battery heating, can add 20-40%), vehicle size and weight, and tyres.",
  });
}

await client.close();
