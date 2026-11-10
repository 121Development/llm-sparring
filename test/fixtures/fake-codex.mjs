#!/usr/bin/env node
// Stand-in for the codex binary. Behaviour is selected with FAKE_CODEX_MODE.
// Records argv and stdin to FAKE_CODEX_RECORD (if set) so tests can inspect them.
import { writeFileSync } from "node:fs";

const mode = process.env.FAKE_CODEX_MODE ?? "ok";
const args = process.argv.slice(2);
const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");

if (args[0] === "login" && args[1] === "status") {
  if (mode === "logged_out") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stdout.write("Logged in using ChatGPT\n");
  process.exit(0);
}

let stdin = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => (stdin += d));
process.stdin.on("end", () => {
  if (process.env.FAKE_CODEX_RECORD) {
    writeFileSync(process.env.FAKE_CODEX_RECORD, JSON.stringify({ args, stdin }));
  }
  out({ type: "thread.started", thread_id: "t1" });
  out({ type: "turn.started" });
  switch (mode) {
    case "ok":
      out({ type: "item.completed", item: { id: "i0", type: "agent_message", text: "thinking out loud" } });
      out({ type: "item.completed", item: { id: "i1", type: "agent_message", text: process.env.FAKE_CODEX_REPLY ?? "FINAL" } });
      out({ type: "turn.completed", usage: {} });
      process.exit(0);
    case "hang":
      setInterval(() => {}, 1000);
      return;
    case "plan_limit":
      fail("You've hit your usage limit. Upgrade to Pro or try again in 3 hours.");
    case "unauthorized":
      fail("unexpected status 401 Unauthorized: Missing bearer or basic authentication in header");
    case "bad_model":
      fail("The 'nope' model is not supported when using Codex with a ChatGPT account.");
    case "empty":
      out({ type: "turn.completed", usage: {} });
      process.exit(0);
  }
});

function fail(message) {
  out({ type: "error", message });
  out({ type: "turn.failed", error: { message } });
  process.exit(1);
}
