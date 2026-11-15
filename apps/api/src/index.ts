// Worker entry. Phase 1 surface: a cron-triggered ingestion pass, a health check, and a
// token-protected manual trigger for testing. User-facing routes (watches, verdicts) come later.
//
// Secrets (never in git, never in the extension):  wrangler secret put <NAME>
//   SUPABASE_SECRET_KEY, ITAD_API_KEY, ADMIN_TOKEN
// Plain vars live in wrangler.toml [vars]:  SUPABASE_URL, CONTACT_EMAIL, MAX_ITEMS, caps.

import { SupabaseRest } from "./db/rest.ts";
import { SupabaseRepo, makeReserve } from "./db/supabaseRepo.ts";
import { runIngestion, type IngestSummary } from "./ingest/run.ts";
import { CheapSharkClient } from "./sources/cheapshark.ts";
import { HttpClient } from "./sources/http.ts";
import { ItadClient } from "./sources/itad.ts";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SECRET_KEY: string;
  ITAD_API_KEY: string;
  CONTACT_EMAIL: string;
  ADMIN_TOKEN?: string;
  MAX_ITEMS?: string;
  ITAD_DAILY_CAP?: string;
  CHEAPSHARK_DAILY_CAP?: string;
}

interface ExecutionContextLite {
  waitUntil(p: Promise<unknown>): void;
}
interface ScheduledEventLite {
  cron: string;
  scheduledTime: number;
}

function intVar(v: string | undefined, fallback: number): number {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

export async function runPass(env: Env): Promise<IngestSummary> {
  for (const k of ["SUPABASE_URL", "SUPABASE_SECRET_KEY", "ITAD_API_KEY", "CONTACT_EMAIL"] as const) {
    if (!env[k]) throw new Error(`missing config: ${k}`);
  }
  const db = new SupabaseRest({ url: env.SUPABASE_URL, key: env.SUPABASE_SECRET_KEY });
  const ua = `GamingDealAgent/0.1 (contact: ${env.CONTACT_EMAIL})`;

  const itadHttp = new HttpClient({
    provider: "itad", userAgent: ua, minIntervalMs: 500,
    reserve: makeReserve(db, "itad", intVar(env.ITAD_DAILY_CAP, 2000)),
  });
  const csHttp = new HttpClient({
    provider: "cheapshark", userAgent: ua, minIntervalMs: 1000,
    reserve: makeReserve(db, "cheapshark", intVar(env.CHEAPSHARK_DAILY_CAP, 300)),
  });

  return runIngestion(
    {
      repo: new SupabaseRepo(db),
      itadForRegion: (region) => new ItadClient(itadHttp, env.ITAD_API_KEY, region),
      cs: new CheapSharkClient(csHttp),
    },
    // Free-plan Workers allow few subrequests per invocation (every DB call counts), so keep
    // passes small and frequent. Raise MAX_ITEMS if you are on a paid plan.
    { maxItems: intVar(env.MAX_ITEMS, 3) },
  );
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export default {
  async scheduled(_event: ScheduledEventLite, env: Env, ctx: ExecutionContextLite): Promise<void> {
    ctx.waitUntil(
      runPass(env)
        .then((s) => console.log(JSON.stringify({ ...s, changes: s.changes.length })))
        .catch((e) => console.error("ingestion failed:", e instanceof Error ? e.message : String(e))),
    );
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");

    if (url.pathname === "/admin/run" && req.method === "POST") {
      const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
      if (!env.ADMIN_TOKEN || !safeEqual(token, env.ADMIN_TOKEN)) return new Response("unauthorized", { status: 401 });
      try {
        return Response.json(await runPass(env));
      } catch (e) {
        return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
      }
    }
    return new Response("not found", { status: 404 });
  },
};
