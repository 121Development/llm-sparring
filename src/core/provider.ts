/**
 * The only way the core talks to GPT. Implementations live in src/providers.
 */
export interface GptRequest {
  /** System-level instructions (role, rules, output format). */
  instructions: string;
  /** The user-turn content: delimited data the model should work on. */
  input: string;
}

export interface GptProvider {
  /** Human-readable label for the model, shown to Claude, e.g. "gpt-5.5" or "Codex default". */
  readonly modelLabel: string;
  complete(req: GptRequest, opts?: { signal?: AbortSignal }): Promise<string>;
}

export type GptErrorCode =
  | "not_installed"
  | "not_logged_in"
  | "timeout"
  | "plan_limit"
  | "model_unsupported"
  | "cancelled"
  | "empty_response"
  | "upstream";

/**
 * A provider failure with a message written for Claude (and the user) to read.
 * Messages must never contain prompt or draft text.
 */
export class GptError extends Error {
  constructor(
    readonly code: GptErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "GptError";
  }
}
