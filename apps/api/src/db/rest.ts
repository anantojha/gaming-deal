// Tiny PostgREST client over fetch (no SDK: smaller Worker bundle, fewer moving parts).
// Server-side only. The key is a SERVICE/SECRET key and must never reach the extension.

export class SupabaseError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "SupabaseError";
    this.status = status;
  }
}

export interface SupabaseRestOptions {
  url: string;
  key: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface UpsertOptions {
  onConflict: string;
  /** true → ON CONFLICT DO NOTHING; false → update the columns present in the body. */
  ignoreDuplicates?: boolean;
  /** Return the written rows, selecting these columns. */
  returning?: string;
}

export class SupabaseRest {
  private base: string;
  private headers: Record<string, string>;
  private fetchImpl: typeof fetch;
  private timeoutMs: number;

  constructor(o: SupabaseRestOptions) {
    this.base = `${o.url.replace(/\/+$/, "")}/rest/v1`;
    // Legacy service_role keys are JWTs and work as a Bearer token. New sb_secret_ keys are not
    // JWTs and must go in the apikey header only.
    this.headers = { apikey: o.key };
    if (o.key.startsWith("eyJ")) this.headers.Authorization = `Bearer ${o.key}`;
    this.fetchImpl = o.fetchImpl ?? ((...a) => fetch(...a));
    this.timeoutMs = o.timeoutMs ?? 15_000;
  }

  private async send(
    method: "GET" | "POST" | "PATCH",
    path: string,
    query: Record<string, string> | undefined,
    body: unknown,
    prefer?: string,
  ): Promise<unknown> {
    const qs = query ? new URLSearchParams(query).toString() : ""; // encodes '+' as %2B
    const url = `${this.base}/${path}${qs ? `?${qs}` : ""}`;
    const res = await this.fetchImpl(url, {
      method,
      headers: {
        ...this.headers,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) {
      // Path + status + short body only. Never headers (they carry the key).
      throw new SupabaseError(res.status, `Supabase ${method} ${path} -> ${res.status}: ${text.slice(0, 200)}`);
    }
    return text ? JSON.parse(text) : null;
  }

  async select<T = Record<string, unknown>>(table: string, query: Record<string, string>): Promise<T[]> {
    const rows = await this.send("GET", table, query, undefined);
    return Array.isArray(rows) ? (rows as T[]) : [];
  }

  async upsert<T = Record<string, unknown>>(table: string, rows: unknown[], o: UpsertOptions): Promise<T[]> {
    if (rows.length === 0) return [];
    const prefer = [
      o.ignoreDuplicates ? "resolution=ignore-duplicates" : "resolution=merge-duplicates",
      o.returning ? "return=representation" : "return=minimal",
    ].join(",");
    const query: Record<string, string> = { on_conflict: o.onConflict };
    if (o.returning) query.select = o.returning;
    const out = await this.send("POST", table, query, rows, prefer);
    return Array.isArray(out) ? (out as T[]) : [];
  }

  async patch(table: string, query: Record<string, string>, body: unknown): Promise<void> {
    await this.send("PATCH", table, query, body, "return=minimal");
  }

  async rpc<T = unknown>(fn: string, args: Record<string, unknown>): Promise<T> {
    return (await this.send("POST", `rpc/${fn}`, undefined, args)) as T;
  }
}
