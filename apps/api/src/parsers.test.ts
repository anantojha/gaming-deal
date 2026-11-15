import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { formatSince, parseHistory, parseHistoryLow, parseLookup, parseOffer, parseOverview, parseShops } from "../src/sources/itad.ts";
import { mapStoresByName, parseGameDetail, parseGameSummary, parseStores, redirectUrl } from "../src/sources/cheapshark.ts";
import { toCents, toPct, unixSecondsToIso } from "../src/ingest/normalize.ts";

// Hand-assembled from the real responses pasted during step 1 (Portal 2).
const GID = "018d937f-21e1-728e-86d7-9acb3c59f2bb";

const lookup = { found: true, game: { id: GID, slug: "portal-2", title: "Portal 2", type: "game", mature: false, assets: {} } };

const steamOffer = {
  shop: { id: 61, name: "Steam" },
  price: { amount: 9.99, amountInt: 999, currency: "USD" },
  regular: { amount: 9.99, amountInt: 999, currency: "USD" },
  cut: 0, voucher: null, flag: null, drm: [],
  platforms: [{ id: 1, name: "Windows" }, { id: 3, name: "Linux" }],
  timestamp: "2026-10-08T19:19:57+02:00", expiry: null,
  url: "https://itad.link/018d9386-b04c-7082-93ee-cf4eb9246544/?app=76xfra",
};

const historyLow = [{ id: GID, low: {
  shop: { id: 61, name: "Steam" },
  price: { amount: 0.99, amountInt: 99, currency: "USD" },
  regular: { amount: 9.99, amountInt: 999, currency: "USD" },
  cut: 90, timestamp: "2019-06-26T06:04:36+02:00" } }];

// ITAD returns newest first
const history = [
  { timestamp: "2026-10-08T19:19:57+02:00", shop: { id: 61, name: "Steam" }, deal: { price: { amountInt: 999 }, regular: { amountInt: 999 }, cut: 0 } },
  { timestamp: "2026-10-01T19:36:16+02:00", shop: { id: 61, name: "Steam" }, deal: { price: { amountInt: 199 }, regular: { amountInt: 999 }, cut: 80 } },
  { timestamp: "2026-07-09T19:17:16+02:00", shop: { id: 61, name: "Steam" }, deal: { price: { amountInt: 999 }, regular: { amountInt: 999 }, cut: 0 } },
];

test("itad: lookup", () => {
  assert.deepEqual(parseLookup(lookup)?.id, GID);
  assert.equal(parseLookup({ found: false }), null);
  assert.equal(parseLookup("nonsense"), null);
});

test("itad: offer uses integer cents, keeps url unmodified, flags nothing it can't see", () => {
  const o = parseOffer(steamOffer)!;
  assert.equal(o.shopId, 61);
  assert.equal(o.priceCents, 999);
  assert.equal(o.url, steamOffer.url);
  assert.deepEqual(o.platforms, ["Windows", "Linux"]);
  assert.equal(o.hasVoucher, false);
  assert.equal(parseOffer({ shop: { id: 61 } }), null); // no price → skipped, not a crash
});

test("itad: overview tolerates a missing/odd `lowest` block", () => {
  const m = parseOverview({ prices: [{ id: GID, current: steamOffer, lowest: { weird: true } }, { nope: 1 }] });
  assert.equal(m.size, 1);
  assert.equal(m.get(GID)!.current!.priceCents, 999);
  assert.equal(m.get(GID)!.lowest, null);
});

test("itad: history low", () => {
  const low = parseHistoryLow(historyLow).get(GID)!;
  assert.equal(low.priceCents, 99);
  assert.equal(low.cut, 90);
  assert.equal(parseHistoryLow([{ id: GID, low: null }]).size, 0);
});

test("itad: history is sorted oldest-first and drops malformed rows", () => {
  const ev = parseHistory([...history, { timestamp: "garbage", shop: { id: 61 }, deal: {} }]);
  assert.equal(ev.length, 3);
  assert.deepEqual(ev.map((e) => e.priceCents), [999, 199, 999]);
});

test("itad: since is formatted without milliseconds and with an encodable offset", () => {
  const s = formatSince(new Date("2025-11-14T19:45:12.545Z"));
  assert.equal(s, "2025-11-14T19:45:12+00:00");
  assert.equal(new URLSearchParams({ since: s }).toString(), "since=2025-11-14T19%3A45%3A12%2B00%3A00");
});

test("itad: shops", () => {
  const s = parseShops([{ id: 2, title: "AllYouPlay", deals: 468, games: 5936, update: "2026-11-14T20:42:03+01:00" }, { id: "x" }]);
  assert.equal(s.length, 1);
  assert.equal(s[0].updatedAt, "2026-11-14T20:42:03+01:00");
});

test("cheapshark: game summary converts strings to cents", () => {
  const g = parseGameSummary([{ gameID: "36", steamAppID: "620", cheapest: "9.99", cheapestDealID: "rwQ2%2BmM6b2VE%3D", external: "Portal 2" }])!;
  assert.equal(g.gameId, 36);
  assert.equal(g.steamAppId, 620);
  assert.equal(g.cheapestCents, 999);
  assert.equal(parseGameSummary([]), null);
});

test("cheapshark: game detail (shape unverified, so must degrade gracefully)", () => {
  const d = parseGameDetail({
    info: { title: "Portal 2", steamAppID: "620" },
    cheapestPriceEver: { price: "0.98", date: 1561000000 },
    deals: [{ storeID: "1", dealID: "abc%3D", price: "9.99", retailPrice: "9.99", savings: "0.000000" }, { storeID: "x" }],
  })!;
  assert.equal(d.deals.length, 1);
  assert.equal(d.deals[0].priceCents, 999);
  assert.equal(d.cheapestEverCents, 98);
  assert.equal(parseGameDetail("nope"), null);
  assert.deepEqual(parseGameDetail({})!.deals, []);
});

test("cheapshark: redirect link keeps the already-encoded dealID untouched", () => {
  assert.equal(redirectUrl("abc%2Bdef%3D"), "https://www.cheapshark.com/redirect?dealID=abc%2Bdef%3D");
});

test("cheapshark: store ↔ ITAD shop mapping by name", () => {
  const cs = parseStores([
    { storeID: "1", storeName: "Steam", isActive: 1 },
    { storeID: "3", storeName: "GreenManGaming", isActive: 1 },
    { storeID: "99", storeName: "Unknown Store", isActive: 0 },
  ]);
  const map = mapStoresByName(cs, [{ id: 61, title: "Steam" }, { id: 24, title: "Green Man Gaming" }]);
  assert.equal(map.get(1), 61);
  assert.equal(map.get(3), 24);
  assert.equal(map.has(99), false);
});

test("normalize: money, pct, unix time", () => {
  assert.equal(toCents("27.98"), 2798);
  assert.equal(toCents("1.38"), 138);
  assert.equal(toCents("-1"), null);
  assert.equal(toCents("abc"), null);
  assert.equal(toCents(null), null);
  assert.equal(toPct("95.067906"), 95);
  assert.equal(unixSecondsToIso(1794522446), new Date(1794522446 * 1000).toISOString());
});

// Contract test: runs against YOUR real recorded responses if they exist in ../../fixtures.
const fx = (name: string) => new URL(`../../../fixtures/${name}`, import.meta.url);
for (const [file, check] of [
  ["620-itad-lookup-by-steam-appid.json", (b: unknown) => assert.ok(parseLookup(b))],
  ["620-itad-price-overview.json", (b: unknown) => assert.ok(parseOverview(b).size > 0)],
  ["620-itad-history-low-all-time.json", (b: unknown) => assert.ok(parseHistoryLow(b).size > 0)],
  ["620-itad-shops-list.json", (b: unknown) => assert.ok(parseShops(b).length > 10)],
  ["620-cheapshark-game-by-steam-appid.json", (b: unknown) => assert.ok(parseGameSummary(b))],
  ["620-cheapshark-stores.json", (b: unknown) => assert.ok(parseStores(b).length > 5)],
] as const) {
  const url = fx(file);
  test(`contract: ${file}`, { skip: !existsSync(url) && "fixture not recorded yet" }, () => {
    check(JSON.parse(readFileSync(url, "utf8")).body);
  });
}
