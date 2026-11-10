/**
 * Metadata-only logging. Callers pass ids, timings, sizes and error codes.
 * Never pass draft, question, rubric or transcript text here.
 * Entry points supply the concrete logger (stderr locally, console on Workers).
 */
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export const silentLogger: Logger = { info() {}, error() {} };

export function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}
