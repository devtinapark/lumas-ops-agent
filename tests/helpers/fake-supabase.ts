/**
 * Minimal stand-in for the supabase-js query builder. Each chain is recorded as a Query;
 * a per-table handler decides what the awaited result is.
 */
export interface Query {
  table: string;
  op: "select" | "insert" | "update" | "upsert" | "delete";
  payload?: unknown;
  columns?: string;
  filters: [string, string, unknown][];
  terminal?: "single" | "maybeSingle";
}

export type Result = { data?: unknown; error?: { message: string; code?: string } | null; count?: number | null };
export type Handler = (q: Query) => Result;

export function fakeSupabase(handlers: Record<string, Handler>) {
  const queries: Query[] = [];

  function builder(q: Query) {
    const run = () => {
      const handler = handlers[q.table];
      const res = handler ? handler(q) : {};
      return Promise.resolve({ data: res.data ?? null, error: res.error ?? null, count: res.count ?? null });
    };
    const b = {
      select(columns?: string) {
        if (q.op === "select") q.columns = columns;
        return b;
      },
      insert(payload: unknown) {
        q.op = "insert";
        q.payload = payload;
        return b;
      },
      update(payload: unknown) {
        q.op = "update";
        q.payload = payload;
        return b;
      },
      upsert(payload: unknown) {
        q.op = "upsert";
        q.payload = payload;
        return b;
      },
      eq(col: string, v: unknown) {
        q.filters.push([col, "eq", v]);
        return b;
      },
      in(col: string, v: unknown) {
        q.filters.push([col, "in", v]);
        return b;
      },
      order() {
        return b;
      },
      limit() {
        return b;
      },
      single() {
        q.terminal = "single";
        return run();
      },
      maybeSingle() {
        q.terminal = "maybeSingle";
        return run();
      },
      then<T>(resolve: (v: Awaited<ReturnType<typeof run>>) => T, reject?: (e: unknown) => T) {
        return run().then(resolve, reject);
      },
    };
    return b;
  }

  const client = {
    from(table: string) {
      const q: Query = { table, op: "select", filters: [] };
      queries.push(q);
      return builder(q);
    },
  };

  return { client, queries, where: (table: string, op: Query["op"]) => queries.filter((q) => q.table === table && q.op === op) };
}
