import { test } from "node:test";
import assert from "node:assert/strict";
import { computeStats } from "../src/ingest/stats.ts";
import { runIngestion, type CsPort, type ItadPort } from "../src/ingest/run.ts";
import type { IngestRepo, ListingRow, ListingWrite, PricePointWrite, StatsRow, TrustTier, Validation, WatchedItem } from "../src/ingest/repo.ts";
import type { HistoryLow, ItadShop, Offer, Overview, PriceEvent } from "../src/sources/itad.ts";
import { BudgetExceededError, RateLimitedError } from "../src/sources/http.ts";

// ───────────── stats ─────────────
const NOW = Date.parse("2026-11-14T20:00:00Z");
const ev = (daysAgo: number, price: number, regular = 999, shopId = 61): PriceEvent => ({
  shopId, shopName: "S", changedAt: new Date(NOW - daysAgo * 864e5).toISOString(),
  priceCents: price, regularCents: regular, cut: Math.round((1 - price / regular) * 100),
});

test("stats: low, median sale price (vs regular), episodes", () => {
  const s = computeStats([ev(300, 999), ev(290, 499), ev(280, 999), ev(100, 299), ev(90, 999), ev(7, 199), ev(0, 999)], NOW);
  assert.equal(s.low12mCents, 199);
  assert.equal(s.typicalSaleCents, 299); // sales: 499, 299, 199 → median 299
  assert.equal(s.saleCount12m, 3);
  assert.equal(s.regularCents, 999);
});

test("stats: events outside 12 months are ignored; empty input is all-null", () => {
  assert.equal(computeStats([ev(400, 99)], NOW).low12mCents, null);
  assert.deepEqual(computeStats([], NOW), { low12mCents: null, typicalSaleCents: null, saleCount12m: 0, regularCents: null });
});

test("stats: a 5% discount is not a 'sale'; simultaneous shop sales aren't double counted", () => {
  assert.equal(computeStats([ev(10, 950)], NOW).typicalSaleCents, null);
  const both = computeStats([ev(5, 499, 999, 61), ev(5, 499, 999, 16)], NOW);
  assert.equal(both.saleCount12m, 1);
});

// ───────────── in-memory fakes ─────────────
class FakeRepo implements IngestRepo {
  items: WatchedItem[] = [];
  tiers = new Map<number, TrustTier>([[61, "official"]]);
  shops = new Map<number, string>();
  listings = new Map<string, ListingRow & ListingWrite>();
  points = new Map<string, PricePointWrite & { observedAt: string }>();
  stats = new Map<string, StatsRow>();
  csIds = new Map<string, number>();
  clock = () => NOW;
  private n = 0;

  async listDueItems(limit: number) { return this.items.slice(0, limit); }
  async getShopTiers() { return this.tiers; }
  async ensureShops(s: { id: number; name: string }[]) { for (const x of s) if (!this.shops.has(x.id)) this.shops.set(x.id, x.name); }
  async getListing(productId: string, shopId: number, region: string) {
    return [...this.listings.values()].find((l) => l.productId === productId && l.shopId === shopId && l.region === region) ?? null;
  }
  async upsertListing(row: ListingWrite) {
    const ex = await this.getListing(row.productId, row.shopId, row.region);
    const id = ex?.id ?? `L${++this.n}`;
    this.listings.set(id, { ...row, id });
    return id;
  }
  private key(l: string, c: string, p: number) { return `${l}|${Date.parse(c)}|${p}`; }
  async getPricePoint(l: string, c: string, p: number) {
    const x = this.points.get(this.key(l, c, p));
    return x ? { observedAt: x.observedAt, validation: x.validation } : null;
  }
  async upsertPricePoint(r: PricePointWrite) {
    const k = this.key(r.listingId, r.changedAt, r.priceCents);
    const ex = this.points.get(k);
    this.points.set(k, ex ? { ...ex, validation: r.validation, reason: r.reason } : { ...r, observedAt: new Date(this.clock()).toISOString() });
  }
  async insertHistoricalPoints(rows: PricePointWrite[]) {
    for (const r of rows) {
      const k = this.key(r.listingId, r.changedAt, r.priceCents);
      if (!this.points.has(k)) this.points.set(k, { ...r, observedAt: new Date(this.clock()).toISOString() });
    }
  }
  async getStats(p: string, r: string) { return this.stats.get(`${p}|${r}`) ?? null; }
  async upsertStats(s: StatsRow) { this.stats.set(`${s.productId}|${s.region}`, s); }
  async setCsGameId(p: string, id: number) { this.csIds.set(p, id); }
}

const GID = "018d937f-21e1-728e-86d7-9acb3c59f2bb";
const item = (over: Partial<WatchedItem> = {}): WatchedItem => ({
  productId: "P1", itadId: GID, steamAppId: 620, csGameId: 36, region: "US", ...over,
});
const offer = (price: number, over: Partial<Offer> = {}): Offer => ({
  shopId: 61, shopName: "Steam", priceCents: price, regularCents: 999, currency: "USD",
  cut: Math.round((1 - price / 999) * 100), url: "https://itad.link/x/?app=76xfra",
  changedAt: "2026-11-14T18:30:00+00:00", expiresAt: null, drm: [], platforms: ["Windows"],
  flag: null, hasVoucher: false, ...over,
});

interface ItadStubOpts { price: number; offerOver?: Partial<Offer>; events?: PriceEvent[]; atl?: number; crawled?: string; throwOn?: "overview" | "history" }
function itadStub(o: ItadStubOpts, calls: string[] = []): ItadPort {
  return {
    async shops(): Promise<ItadShop[]> {
      calls.push("shops");
      return [{ id: 61, title: "Steam", deals: 1, games: 1, updatedAt: o.crawled ?? "2026-11-14T19:00:00Z" }];
    },
    async overview(ids: string[]): Promise<Map<string, Overview>> {
      calls.push("overview");
      if (o.throwOn === "overview") throw new RateLimitedError("itad", 60_000);
      return new Map(ids.map((id) => [id, { current: offer(o.price, o.offerOver), lowest: null }]));
    },
    async historyLow(ids: string[]): Promise<Map<string, HistoryLow>> {
      calls.push("historyLow");
      return new Map(ids.map((id) => [id, { shopId: 61, shopName: "Steam", priceCents: o.atl ?? 99, regularCents: 999, cut: 90, at: "2019-06-26T00:00:00Z" }]));
    },
    async history(): Promise<PriceEvent[]> {
      calls.push("history");
      if (o.throwOn === "history") throw new RateLimitedError("itad", 60_000);
      return o.events ?? [ev(60, 999), ev(0, o.price)];
    },
  };
}

function csStub(opts: { priceAtSteam?: number | null; throws?: Error } = {}, calls: string[] = []): CsPort {
  return {
    async stores() { calls.push("cs.stores"); return [{ storeId: 1, name: "Steam", isActive: true }]; },
    async gameBySteamAppId() { calls.push("cs.byAppId"); return { gameId: 36, steamAppId: 620, title: "Portal 2", cheapestCents: 999, cheapestDealId: null }; },
    async gameDetail() {
      calls.push("cs.detail");
      if (opts.throws) throw opts.throws;
      const deals = opts.priceAtSteam == null ? [] : [{ storeId: 1, dealId: "d", priceCents: opts.priceAtSteam, retailCents: 999, savingsPct: 80 }];
      return { title: "Portal 2", steamAppId: 620, cheapestEverCents: 98, deals };
    },
  };
}

const run = (repo: FakeRepo, itad: ItadPort, cs: CsPort = csStub()) =>
  runIngestion({ repo, itadForRegion: () => itad, cs, now: repo.clock });

// ───────────── ingestion ─────────────
test("first sighting of an ordinary price: stored, verified, history backfilled, change reported", async () => {
  const repo = new FakeRepo();
  repo.items = [item()];
  const s = await run(repo, itadStub({ price: 749 }));
  assert.equal(s.processed, 1);
  assert.equal(s.verified, 1);
  assert.equal(s.changes.length, 1);
  assert.equal(s.changes[0].previousPriceCents, null);
  const l = [...repo.listings.values()][0];
  assert.equal(l.priceCents, 749);
  assert.equal(l.url, "https://itad.link/x/?app=76xfra"); // untouched
  assert.ok(repo.shops.has(61)); // FK safety: shop registered
  assert.ok(repo.stats.get("P1|US"));
  assert.ok(repo.points.size >= 2); // current point + backfilled history
});

test("a big drop with no second reading is held, then verified by a repeat reading an hour later", async () => {
  const repo = new FakeRepo();
  repo.items = [item()];
  const first = await run(repo, itadStub({ price: 199 }), csStub({ priceAtSteam: null }));
  assert.equal(first.unverified, 1);
  assert.equal(first.changes[0].validation, "unverified");
  assert.ok(first.changes[0].reasons.includes("no_corroboration"));

  repo.clock = () => NOW + 60 * 60_000;
  const second = await run(repo, itadStub({ price: 199, crawled: "2026-11-14T20:30:00Z" }), csStub({ priceAtSteam: null }));
  assert.equal(second.verified, 1);
  const point = [...repo.points.values()].find((p) => p.priceCents === 199 && p.validation === "verified");
  assert.ok(point);
});

test("a big drop is verified immediately when CheapShark agrees at the same store", async () => {
  const repo = new FakeRepo();
  repo.items = [item()];
  const s = await run(repo, itadStub({ price: 199 }), csStub({ priceAtSteam: 199 }));
  assert.equal(s.verified, 1);
  assert.equal(repo.csIds.size, 0); // csGameId was already known
});

test("CheapShark disagreeing keeps the drop unverified, and a repeat reading cannot override it", async () => {
  const repo = new FakeRepo();
  repo.items = [item()];
  await run(repo, itadStub({ price: 199 }), csStub({ priceAtSteam: 999 }));
  repo.clock = () => NOW + 60 * 60_000;
  const second = await run(repo, itadStub({ price: 199, crawled: "2026-11-14T20:30:00Z" }), csStub({ priceAtSteam: 999 }));
  assert.equal(second.unverified, 1);
  assert.equal(second.verified, 0);
  const held = [...repo.points.values()].find((p) => p.priceCents === 199);
  assert.equal(held?.validation, "unverified");
  assert.ok(held?.reason?.includes("cs_disagrees"));
});

test("CheapShark is never called for non-US regions or ordinary prices", async () => {
  const repo = new FakeRepo();
  const calls: string[] = [];
  repo.items = [item({ region: "CA" })];
  await run(repo, itadStub({ price: 199 }), csStub({ priceAtSteam: 199 }, calls));
  assert.deepEqual(calls, []);
  const repo2 = new FakeRepo();
  repo2.items = [item()];
  await run(repo2, itadStub({ price: 749 }), csStub({}, calls));
  assert.deepEqual(calls, []);
});

test("a CheapShark rate limit disables further CheapShark calls but ingestion continues", async () => {
  const repo = new FakeRepo();
  repo.items = [item(), item({ productId: "P2", itadId: "gid-2" })];
  const calls: string[] = [];
  const s = await run(repo, itadStub({ price: 199 }), csStub({ throws: new RateLimitedError("cheapshark", 60_000) }, calls));
  assert.equal(s.csSkipped, true);
  assert.equal(s.processed, 2);
  assert.equal(s.unverified, 2);
  assert.equal(calls.filter((c) => c === "cs.detail").length, 1); // breaker: second item never tried
});

test("an ITAD rate limit stops the run cleanly instead of throwing", async () => {
  const repo = new FakeRepo();
  repo.items = [item()];
  const s = await run(repo, itadStub({ price: 749, throwOn: "overview" }));
  assert.equal(s.stoppedEarly, "itad_rate_limited");
  assert.equal(s.processed, 0);
  const repo2 = new FakeRepo();
  repo2.items = [item()];
  const s2 = await run(repo2, { ...itadStub({ price: 749 }), history: async () => { throw new BudgetExceededError("itad"); } });
  assert.equal(s2.stoppedEarly, "itad_budget");
});

test("'verified' is sticky: a later stale crawl does not downgrade a confirmed price", async () => {
  const repo = new FakeRepo();
  repo.items = [item()];
  await run(repo, itadStub({ price: 749 }));
  repo.clock = () => NOW + 3600_000;
  const s = await run(repo, itadStub({ price: 749, crawled: "2026-11-10T00:00:00Z" }));
  assert.equal(s.verified, 1);
  assert.equal(s.unverified, 0);
});

test("a stale source holds a new price", async () => {
  const repo = new FakeRepo();
  repo.items = [item()];
  const s = await run(repo, itadStub({ price: 749, crawled: "2026-11-10T00:00:00Z" }));
  assert.equal(s.unverified, 1);
});

test("an impossible price is stored as rejected, never alerted", async () => {
  const repo = new FakeRepo();
  repo.items = [item()];
  const s = await run(repo, itadStub({ price: 1500, offerOver: { regularCents: 999, cut: 0 } }));
  assert.equal(s.rejected, 1);
  assert.equal(s.changes[0].validation, "rejected");
});

test("grey-market shop events are excluded from the 12-month low", async () => {
  const repo = new FakeRepo();
  repo.tiers.set(99, "grey");
  repo.items = [item()];
  await run(repo, itadStub({ price: 749, events: [ev(30, 999), ev(20, 50, 999, 99), ev(0, 749)] }));
  assert.equal(repo.stats.get("P1|US")!.low12mCents, 749);
});

test("a product with no current offer is counted, not an error; one bad item doesn't stop others", async () => {
  const repo = new FakeRepo();
  repo.items = [item({ itadId: "unknown-id" }), item({ productId: "P2" })];
  const base = itadStub({ price: 749 });
  const itad: ItadPort = {
    ...base,
    overview: async (ids) => { const m = await base.overview(ids); m.delete("unknown-id"); return m; },
  };
  const s = await run(repo, itad);
  assert.equal(s.noOffer, 1);
  assert.equal(s.processed, 1);
  assert.deepEqual(s.errors, []);
});

test("stats are not refetched when fresh and the price hasn't moved", async () => {
  const repo = new FakeRepo();
  repo.items = [item()];
  await run(repo, itadStub({ price: 749 }));
  const calls: string[] = [];
  repo.clock = () => NOW + 3600_000;
  await run(repo, itadStub({ price: 749 }, calls));
  assert.ok(!calls.includes("history"));
});
