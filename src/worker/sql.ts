/**
 * The slice of the D1 API this project uses. D1Database satisfies it; tests
 * provide an adapter over node:sqlite.
 */
export interface SqlStatement {
  bind(...values: unknown[]): SqlStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<{ meta: { changes: number } }>;
}

export interface SqlDb {
  prepare(sql: string): SqlStatement;
}
