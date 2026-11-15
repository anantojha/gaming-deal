import { test } from "node:test";
import assert from "node:assert/strict";
import { SupabaseError, SupabaseRest } from "../src/db/rest.ts";
import { SupabaseRepo, makeReserve } from "../src/db/supabaseRepo.ts";
import type { PricePointWrite } from "../src/ingest/repo.ts";
import worker, { type Env } from "../src/index.ts";

interface Call { url: URL; method: string; headers: Record<string, string>; body: unknown }

function fake(responder: (c: Call) => { status?: number; body?: unknown } | undefined = () => undefined) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const call: Call = {
      url: new URL(url), method: String(init.method),
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = responder(call) ?? {};
    // A 204 response must have a null body; Response("") would throw.
    return r.body === undefined
      ? new Response(null, { status: r.status ?? 204 })
      : new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const rest = (f: ReturnType<typeof fake>, key = "sb_secret_abc") =>
  new SupabaseRest({ url: "https://proj.supabase.co/", key, fetchImpl: f.fetchImpl });

const point: PricePointWrite = {
  listingId: "L1", changedAt: "2026-10-08T19:19:57+02:00", priceCents: 999, regularCents: 999,
  cutPct: 0, source: "itad", validation: "verified", reason: null,
};

test("rest: new-style secret keys go in apikey only; legacy JWT keys also get Bearer", async () => {
  const a = fake(); await rest(a, "sb_secret_abc").select("shop", { select: "id" });
  assert.equal(a.calls[0].headers.apikey, "sb_secret_abc");
  assert.equal(a.calls[0].headers.Authorization, undefined);
  const b = fake(); await rest(b, "eyJhbGciOi.payload.sig").select("shop", { select: "id" });
  assert.equal(b.calls[0].headers.Authorization, "Bearer eyJhbGciOi.payload.sig");
  assert.equal(a.calls[0].url.origin + a.calls[0].url.pathname, "https://proj.supabase.co/rest/v1/shop");
});

test("rest: errors carry status and a short body but never the key", async () => {
  const f = fake(() => ({ status: 401, body: { message: "Invalid API key" } }));
  await assert.rejects(rest(f, "sb_secret_TOPSECRET").select("shop", {}), (e: unknown) =>
    e instanceof SupabaseError && e.status === 401 && !e.message.includes("TOPSECRET"));
});

test("upsert listing: merge-duplicates on the unique key, returns the id", async () => {
  const f = fake(() => ({ body: [{ id: "L9" }] }));
  const id = await new SupabaseRepo(rest(f)).upsertListing({
    productId: "P1", shopId: 61, source: "itad", region: "US", currency: "USD",
    url: "https://itad.link/x/?app=76xfra", priceCents: 749, regularCents: 999, cutPct: 25,
    priceChangedAt: "2026-11-14T18:30:00+00:00", expiresAt: null, lastCheckedAt: "2026-11-14T20:00:00.000Z",
  });
  assert.equal(id, "L9");
  const c = f.calls[0];
  assert.equal(c.method, "POST");
  assert.equal(c.url.searchParams.get("on_conflict"), "product_id,shop_id,source,region");
  assert.equal(c.url.searchParams.get("select"), "id");
  assert.equal(c.headers.Prefer, "resolution=merge-duplicates,return=representation");
  assert.equal((c.body as Array<Record<string, unknown>>)[0].url, "https://itad.link/x/?app=76xfra");
});

test("price point upsert never sends observed_at (first sighting is preserved)", async () => {
  const f = fake();
  await new SupabaseRepo(rest(f)).upsertPricePoint(point);
  const row = (f.calls[0].body as Array<Record<string, unknown>>)[0];
  assert.equal("observed_at" in row, false);
  assert.equal(f.calls[0].url.searchParams.get("on_conflict"), "listing_id,changed_at,price_cents");
  assert.equal(f.calls[0].headers.Prefer, "resolution=merge-duplicates,return=minimal");
});

test("historical points use ignore-duplicates, in chunks, and skip empty input", async () => {
  const f = fake();
  const repo = new SupabaseRepo(rest(f));
  await repo.insertHistoricalPoints([]);
  assert.equal(f.calls.length, 0);
  await repo.insertHistoricalPoints(Array.from({ length: 1001 }, (_, i) => ({ ...point, priceCents: i })));
  assert.equal(f.calls.length, 3); // 500 + 500 + 1
  assert.equal(f.calls[0].headers.Prefer, "resolution=ignore-duplicates,return=minimal");
});

test("shops are registered with ignore-duplicates so curated trust tiers are never overwritten", async () => {
  const f = fake();
  await new SupabaseRepo(rest(f)).ensureShops([{ id: 61, name: "Steam" }]);
  assert.equal(f.calls[0].headers.Prefer, "resolution=ignore-duplicates,return=minimal");
  assert.deepEqual(f.calls[0].body, [{ id: 61, name: "Steam" }]);
});

test("getPricePoint encodes the '+' in timestamp offsets", async () => {
  const f = fake(() => ({ body: [{ observed_at: "2026-11-14T19:00:00Z", validation: "unverified" }] }));
  const r = await new SupabaseRepo(rest(f)).getPricePoint("L1", "2026-10-08T19:19:57+02:00", 999);
  assert.deepEqual(r, { observedAt: "2026-11-14T19:00:00Z", validation: "unverified" });
  assert.ok(f.calls[0].url.search.includes("%2B02%3A00"), f.calls[0].url.search);
  assert.equal(f.calls[0].url.searchParams.get("changed_at"), "eq.2026-10-08T19:19:57+02:00");
});

test("getStats and setCsGameId map columns correctly", async () => {
  const f = fake((c) => c.method === "GET" ? { body: [{
    atl_cents: 99, atl_at: "2019-06-26T00:00:00Z", atl_shop_id: 61, low_12m_cents: 199,
    typical_sale_cents: 299, regular_cents: 999, sale_count_12m: 3, computed_at: "2026-11-14T00:00:00Z" }] } : undefined);
  const repo = new SupabaseRepo(rest(f));
  const s = await repo.getStats("P1", "US");
  assert.equal(s?.low12mCents, 199);
  assert.equal(s?.saleCount12m, 3);
  await repo.setCsGameId("P1", 36);
  const patch = f.calls[1];
  assert.equal(patch.method, "PATCH");
  assert.equal(patch.url.searchParams.get("id"), "eq.P1");
  assert.deepEqual(patch.body, { cheapshark_game_id: 36 });
});

test("listDueItems: dedupes users, skips products without an ITAD id, orders never-checked then oldest, honours the recheck gap", async () => {
  const NOW = Date.parse("2026-11-14T20:00:00Z");
  const f = fake((c) => {
    if (c.url.pathname.endsWith("/watch")) return { body: [
      { product_id: "A", product: { id: "A", itad_id: "ia", steam_appid: 1, cheapshark_game_id: null }, user_profile: { region: "us" } },
      { product_id: "A", product: { id: "A", itad_id: "ia", steam_appid: 1, cheapshark_game_id: null }, user_profile: { region: "US" } }, // second watcher
      { product_id: "B", product: { id: "B", itad_id: "ib", steam_appid: 2, cheapshark_game_id: 7 }, user_profile: { region: "US" } },
      { product_id: "C", product: { id: "C", itad_id: null, steam_appid: 3, cheapshark_game_id: null }, user_profile: { region: "US" } },
      { product_id: "D", product: { id: "D", itad_id: "id", steam_appid: 4, cheapshark_game_id: null }, user_profile: { region: "US" } },
      { product_id: "E", product: { id: "E", itad_id: "ie", steam_appid: 5, cheapshark_game_id: null }, user_profile: { region: "CA" } },
    ] };
    return { body: [
      { product_id: "A", region: "US", last_checked_at: "2026-11-14T19:00:00Z" }, // 60 min ago
      { product_id: "B", region: "US", last_checked_at: "2026-11-14T19:50:00Z" }, // 10 min ago → too recent
      { product_id: "D", region: "US", last_checked_at: "2026-11-13T00:00:00Z" }, // oldest
    ] };
  });
  const items = await new SupabaseRepo(rest(f)).listDueItems(10, NOW);
  assert.deepEqual(items.map((i) => `${i.productId}|${i.region}`), ["E|CA", "D|US", "A|US"]);
  assert.equal(items.find((i) => i.productId === "B"), undefined);
  assert.equal((await new SupabaseRepo(rest(f)).listDueItems(1, NOW)).length, 1);
});

test("reserve: allows up to the cap, then refuses; fails closed on a bad ledger reply", async () => {
  let total = 0;
  const f = fake(() => ({ body: [{ total_requests: ++total, total_cost_micros: 0 }] }));
  const reserve = makeReserve(rest(f), "itad", 2);
  assert.equal(await reserve(), true);
  assert.equal(await reserve(), true);
  assert.equal(await reserve(), false);
  assert.equal(f.calls[0].url.pathname, "/rest/v1/rpc/bump_usage");
  assert.deepEqual(f.calls[0].body, { p_provider: "itad", p_requests: 1 });
  const bad = fake(() => ({ body: [] }));
  assert.equal(await makeReserve(rest(bad), "itad", 100)(), false);
});

// ───────────── worker surface ─────────────
const env: Env = { SUPABASE_URL: "https://p.supabase.co", SUPABASE_SECRET_KEY: "k", ITAD_API_KEY: "i", CONTACT_EMAIL: "a@b.c", ADMIN_TOKEN: "s3cret" };

test("worker: health is open; admin trigger needs the exact bearer token; unknown paths 404", async () => {
  assert.equal((await worker.fetch(new Request("https://w/healthz"), env)).status, 200);
  assert.equal((await worker.fetch(new Request("https://w/admin/run", { method: "POST" }), env)).status, 401);
  assert.equal((await worker.fetch(new Request("https://w/admin/run", { method: "POST", headers: { authorization: "Bearer nope" } }), env)).status, 401);
  assert.equal((await worker.fetch(new Request("https://w/admin/run", { method: "POST", headers: { authorization: "Bearer s3cret" } }), { ...env, ADMIN_TOKEN: undefined })).status, 401);
  assert.equal((await worker.fetch(new Request("https://w/admin/run"), env)).status, 404); // GET not allowed
  assert.equal((await worker.fetch(new Request("https://w/other"), env)).status, 404);
});

test("worker: missing config fails loudly instead of running half-configured", async () => {
  const res = await worker.fetch(
    new Request("https://w/admin/run", { method: "POST", headers: { authorization: "Bearer s3cret" } }),
    { ...env, ITAD_API_KEY: "" },
  );
  assert.equal(res.status, 500);
  assert.match(((await res.json()) as { error: string }).error, /ITAD_API_KEY/);
});
