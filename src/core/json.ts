/**
 * Lenient JSON extraction from model output: bare JSON, a ```json fence,
 * or the outermost {...} inside prose. Returns the first candidate that parses.
 */
export function extractJson(text: string): unknown {
  for (const candidate of candidates(text)) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try next
    }
  }
  return undefined;
}

function* candidates(text: string): Generator<string> {
  const trimmed = text.trim();
  yield trimmed;
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) yield fence[1].trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) yield trimmed.slice(first, last + 1);
}

export const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
export const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((s) => s.length > 0) : [];
