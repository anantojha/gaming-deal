import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { judge, fmt } from "../src/judge/score.ts";
import { buildSaleContext, type SaleEventRow } from "../src/judge/sales.ts";
import { fallbackExplanation } from "../src/judge/explain.ts";
import type { JudgeInput } from "../src/judge/types.ts";
import { computeStats } from "../src/ingest/stats.ts";
import { parseHistory, type PriceEvent } from "../src/sources/itad.ts";

const NOW = Date.parse("2026-11-14T20:00:00Z");
const HOUR = 3_600_000;

const stats = { atlCents: 99, low12mCents: 199, typicalSaleCents: 249, saleCount12m: 3 };

function input(over: Partial<JudgeInput> = {}, user: Partial<JudgeInput["user"]> = {}): JudgeInput {
  return {
    priceCents: 199, regularCents: 999, currency: "USD", cutPct: 80, validation: "verified",
    priceCheckedAt: new Date(NOW - 2 * HOUR).toISOString(), shopTier: "official", edition: "standard",
    stats, nextSale: null, includedIn: [], alternatives: [],
    user: { targetPriceCents: null, monthlyBudgetCents: null, excludeGreyMarket: true, subscriptions: [], ...user },
    ...over,
  };
}
const cutOf = (price: number) => Math.round((1 - price / 999) * 100);
const at = (price: number, over: Partial<JudgeInput> = {}, user: Partial<JudgeInput["user"]> = {}) =>
  judge(input({ priceCents: price, cutPct: cutOf(price), ...over }, user), NOW);

// ───────────── core verdicts ─────────────
test("a price at the 12-month low and below the typical sale is Buy now, with high confidence", () => {
  const r = at(199);
  assert.equal(r.verdict, "buy_now");
  assert.ok(r.confidence >= 0.9, String(r.confidence));
  assert.ok(r.evidence.some((e) => e.code === "at_12m_low"));
});

test("full price for a game that goes on sale is Wait, not Skip", () => {
  const r = at(999);
  assert.equal(r.verdict, "wait");
  assert.ok(r.score < 30);
});

test("a mediocre sale price is Wait; a near-typical sale price is Good", () => {
  assert.equal(at(329).verdict, "wait");
  const good = at(259);
  assert.equal(good.verdict, "good");
  assert.ok(good.score >= 60 && good.score < 80, String(good.score));
});

test("a game that has never been discounted, at list price, is Good but never Buy now", () => {
  const r = judge(input({
    priceCents: 999, cutPct: 0,
    stats: { atlCents: 999, low12mCents: 999, typicalSaleCents: null, saleCount12m: 0 },
  }), NOW);
  assert.equal(r.verdict, "good");
});

test("no history at all: confidence is low and the verdict stays between Wait and Good", () => {
  const sale = judge(input({ stats: null }), NOW);
  assert.equal(sale.verdict, "good");
  assert.ok(sale.confidence <= 0.35);
  assert.ok(sale.evidence.some((e) => e.code === "limited_history"));
  const full = judge(input({ stats: null, priceCents: 999, cutPct: 0 }), NOW);
  assert.equal(full.verdict, "wait"); // never Skip purely for lack of data
});

// ───────────── user inputs ─────────────
test("target price: floors the verdict at Good and lowers the Buy-now bar", () => {
  assert.equal(at(329).verdict, "wait");
  const hit = at(329, {}, { targetPriceCents: 350 });
  assert.equal(hit.verdict, "good");
  assert.ok(hit.flags.includes("target_hit"));
  assert.equal(at(259).verdict, "good");
  assert.equal(at(259, {}, { targetPriceCents: 300 }).verdict, "buy_now"); // score ~72 clears the lowered bar
});

test("budget: a price over budget is capped at Wait", () => {
  const r = at(199, {}, { monthlyBudgetCents: 150 });
  assert.equal(r.verdict, "wait");
  assert.ok(r.flags.includes("over_budget"));
});

// ───────────── seller legitimacy ─────────────
test("grey-market is excluded by default; if allowed it can never be Buy now", () => {
  const excluded = at(199, { shopTier: "grey" });
  assert.equal(excluded.verdict, "skip");
  assert.ok(excluded.flags.includes("grey_market"));
  const allowed = at(199, { shopTier: "grey" }, { excludeGreyMarket: false });
  assert.equal(allowed.verdict, "good");
  assert.ok(allowed.flags.includes("grey_market"));
});

test("an unknown seller is flagged and slightly less certain, but not capped", () => {
  const known = at(199);
  const unknown = at(199, { shopTier: "unknown" });
  assert.equal(unknown.verdict, "buy_now");
  assert.ok(unknown.flags.includes("unknown_seller"));
  assert.ok(unknown.confidence <= known.confidence);
});

// ───────────── price trust ─────────────
test("rejected prices produce Skip; unverified prices are capped at Good with low confidence", () => {
  assert.equal(at(199, { validation: "rejected" }).verdict, "skip");
  const u = at(199, { validation: "unverified" });
  assert.equal(u.verdict, "good");
  assert.ok(u.confidence <= 0.4);
  assert.ok(u.flags.includes("unverified_price"));
});

test("a stale price lowers confidence and is flagged", () => {
  const fresh = at(199);
  const stale = at(199, { priceCheckedAt: new Date(NOW - 30 * HOUR).toISOString() });
  assert.ok(stale.confidence < fresh.confidence || fresh.confidence === 0.95);
  assert.ok(stale.flags.includes("stale_price"));
});

// ───────────── subscriptions ─────────────
test("already in a subscription you have → Skip; available in one you don't have → small penalty only", () => {
  const owned = at(199, { includedIn: ["gamepass_pc"] }, { subscriptions: ["gamepass_pc"] });
  assert.equal(owned.verdict, "skip");
  assert.ok(owned.flags.includes("in_subscription"));
  const notOwned = at(199, { includedIn: ["gamepass_pc"] });
  assert.equal(notOwned.verdict, "buy_now");
  assert.ok(notOwned.flags.includes("available_in_subscription"));
  assert.ok(notOwned.score < at(199).score);
});

// ───────────── sale proximity ─────────────
const winter: SaleEventRow = { name: "Steam Winter Sale 2026", scope: "steam", startsOn: "2026-12-17", endsOn: "2027-01-04", isConfirmed: true };

test("a storewide sale coming up lowers the score of a not-yet-good price and flags it", () => {
  const ns = buildSaleContext([winter], NOW, 61);
  assert.equal(ns?.startsInDays, 33);
  const without = at(329);
  const withSale = at(329, { nextSale: ns });
  assert.ok(withSale.score < without.score);
  assert.ok(withSale.flags.includes("sale_soon"));
  assert.ok(withSale.evidence.some((e) => e.code === "sale_soon"));
});

test("a sale starting within a week bites harder than one a month out", () => {
  const near = at(329, { nextSale: { name: "S", startsInDays: 5, endsInDays: 12, active: false, confirmed: true } });
  const far = at(329, { nextSale: { name: "S", startsInDays: 28, endsInDays: 40, active: false, confirmed: true } });
  assert.ok(near.score < far.score);
});

test("an upcoming sale does not penalise a price that is already a good sale price", () => {
  const ns = buildSaleContext([winter], NOW, 61);
  assert.equal(at(199, { nextSale: ns }).score, at(199).score);
});

test("an estimated (unconfirmed) sale date lowers confidence in sale-based advice", () => {
  const est = at(329, { nextSale: { name: "S", startsInDays: 10, endsInDays: 17, active: false, confirmed: false } });
  const conf = at(329, { nextSale: { name: "S", startsInDays: 10, endsInDays: 17, active: false, confirmed: true } });
  assert.ok(est.confidence <= conf.confidence);
});

test("sale context: active, scope by shop, nearest wins, horizon, publisher events ignored", () => {
  const spring: SaleEventRow = { name: "Spring", scope: "steam", startsOn: "2027-03-18", endsOn: "2027-03-25", isConfirmed: false };
  assert.equal(buildSaleContext([winter], Date.parse("2026-12-20T12:00:00Z"), 61)?.active, true);
  assert.equal(buildSaleContext([winter], Date.parse("2026-12-20T12:00:00Z"), 61)?.endsInDays, 15);
  assert.equal(buildSaleContext([winter], NOW, 16), null); // Steam sale doesn't apply to Epic
  assert.equal(buildSaleContext([spring, winter], NOW, 61)?.name, winter.name);
  assert.equal(buildSaleContext([spring], NOW, 61), null); // beyond the 60-day horizon
  assert.equal(buildSaleContext([{ ...winter, scope: "publisher" }], NOW, 61), null);
  assert.equal(buildSaleContext([{ ...winter, scope: "all" }], NOW, 16)?.startsInDays, 33);
  assert.equal(buildSaleContext([{ ...winter, startsOn: "garbage" }], NOW, 61), null);
});

// ───────────── edition value ─────────────
test("edition value: a richer edition for a little more is flagged; an overpriced deluxe is penalised", () => {
  const std = at(199, { alternatives: [{ edition: "complete", priceCents: 239 }] });
  assert.ok(std.flags.includes("edition_better_value"));
  assert.ok(std.score < at(199).score);
  const farther = at(199, { alternatives: [{ edition: "complete", priceCents: 499 }] });
  assert.ok(!farther.flags.includes("edition_better_value"));

  const deluxe = at(399, { edition: "deluxe", alternatives: [{ edition: "standard", priceCents: 199 }] });
  assert.ok(deluxe.flags.includes("edition_overpay"));
});

// ───────────── output contract ─────────────
test("evidence is sorted by priority, results are deterministic, and flags are unique", () => {
  const a = at(329, { nextSale: buildSaleContext([winter], NOW, 61) }, { targetPriceCents: 350 });
  const b = at(329, { nextSale: buildSaleContext([winter], NOW, 61) }, { targetPriceCents: 350 });
  assert.deepEqual(a, b);
  const pri = a.evidence.map((e) => e.priority);
  assert.deepEqual(pri, [...pri].sort((x, y) => y - x));
  assert.equal(new Set(a.flags).size, a.flags.length);
  assert.ok(a.confidence >= 0.1 && a.confidence <= 0.95);
  assert.ok(Number.isInteger(a.score) && a.score >= 0 && a.score <= 100);
});

test("evidence text is built only from our numbers (no input strings are echoed)", () => {
  const r = at(199, { shopTier: "unknown" });
  for (const e of r.evidence) for (const v of Object.values(e.data)) assert.ok(typeof v !== "string" || v.length < 40);
});

test("fallback explanation is exactly two lines and starts with the verdict", () => {
  const lines = fallbackExplanation(at(199)).split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /^Buy now: /);
  const none = fallbackExplanation({ verdict: "wait", score: 10, confidence: 0.5, evidence: [], flags: [] }).split("\n");
  assert.equal(none.length, 2);
  assert.ok(none[1].length > 0);
});

test("money formatting tolerates a bad currency code", () => {
  assert.equal(fmt(199, "USD"), "$1.99");
  assert.equal(fmt(199, "nonsense"), "$1.99");
});

// ───────────── historical replay ─────────────
// Replays a price history: at every point, judge using only what was known at that moment.
// Properties that must hold once at least one earlier sale has been seen:
//   - a full-price point is "Wait" (a sale has happened before and may again)
//   - a deep sale priced at/below every earlier price is "Buy now"
//   - no point is ever "Skip"
function replay(events: PriceEvent[], atl: number) {
  const steam = events.filter((e) => e.shopId === 61).sort((a, b) => Date.parse(a.changedAt) - Date.parse(b.changedAt));
  const out: Array<{ e: PriceEvent; verdict: string; checked: boolean }> = [];
  for (let i = 0; i < steam.length; i++) {
    const e = steam[i];
    const t = Date.parse(e.changedAt);
    const known = steam.slice(0, i + 1);
    const prior = steam.slice(0, i);
    const priorSale = prior.some((p) => p.regularCents && p.priceCents <= p.regularCents * 0.9);
    const c = computeStats(known, t);
    const cut = e.regularCents ? Math.round((1 - e.priceCents / e.regularCents) * 100) : 0;
    const r = judge(input({
      priceCents: e.priceCents, regularCents: e.regularCents, cutPct: cut, priceCheckedAt: new Date(t).toISOString(),
      stats: { atlCents: Math.min(atl, ...known.map((k) => k.priceCents)), low12mCents: c.low12mCents, typicalSaleCents: c.typicalSaleCents, saleCount12m: c.saleCount12m },
    }), t);
    out.push({ e, verdict: r.verdict, checked: priorSale });
    assert.notEqual(r.verdict, "skip");
    if (priorSale && cut < 5) assert.equal(r.verdict, "wait", `full price at ${e.changedAt}`);
    if (priorSale && cut >= 25 && e.priceCents <= Math.min(...prior.map((p) => p.priceCents))) {
      assert.equal(r.verdict, "buy_now", `new low at ${e.changedAt}`);
    }
  }
  return out;
}

test("replay (synthetic Portal-2-like year): the rules behave sensibly at every point", () => {
  const day = (n: number) => new Date(NOW - (365 - n) * 864e5).toISOString();
  const ev = (n: number, price: number): PriceEvent => ({ shopId: 61, shopName: "Steam", changedAt: day(n), priceCents: price, regularCents: 999, cut: cutOf(price) });
  const events = [ev(0, 999), ev(60, 499), ev(67, 999), ev(150, 249), ev(157, 999), ev(240, 199), ev(247, 999), ev(300, 199), ev(307, 999)];
  const out = replay(events, 99);
  assert.ok(out.filter((o) => o.checked).length >= 5); // the properties were actually exercised
});

const realHistory = new URL("../../../fixtures/620-itad-history-log-12-months.json", import.meta.url);
test("replay (your real recorded Portal 2 history)", { skip: !existsSync(realHistory) && "fixture not recorded yet" }, () => {
  const events = parseHistory(JSON.parse(readFileSync(realHistory, "utf8")).body);
  assert.ok(events.length > 0);
  replay(events, 99);
});
