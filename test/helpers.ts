import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { LogFields, Logger } from "../src/core/log.js";
import { type CoreDeps, createServer } from "../src/core/server.js";

export async function connect(deps: CoreDeps) {
  const server = createServer(deps);
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

export function recordingLogger() {
  const lines: { event: string; fields?: LogFields }[] = [];
  const logger: Logger = {
    info: (event, fields) => lines.push({ event, fields }),
    error: (event, fields) => lines.push({ event, fields }),
  };
  return { logger, lines };
}

export const textOf = (r: any): string => (r.content as { type: string; text: string }[]).map((c) => c.text).join("\n");

/** A controllable clock. */
export function fakeClock(start = 1_700_000_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

export const debaterJson = (argument: string, disagreements = ["You are wrong about X because Y."], concessions: string[] = []) =>
  JSON.stringify({ argument, disagreements, concessions });

export const verdictJson = (stronger: "A" | "B" | "tie" = "A") =>
  JSON.stringify({
    settled: [
      { point: "Point favouring A", favours: "A", why: "A had evidence" },
      { point: "Point favouring B", favours: "B", why: "B rebutted" },
      { point: "Common ground", favours: "both", why: "" },
    ],
    unresolved: [{ point: "Cost", what_would_settle_it: "real data" }],
    stronger_side: stronger,
    reasoning: "Because.",
  });
