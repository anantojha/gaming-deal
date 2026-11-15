// Rule-based deal judge. Pure and deterministic: same input, same output. No I/O, no model.
// The model (step 5) only EXPLAINS the result; it never changes the verdict.
//
// Shape of the calculation:
//   1. Hard overrides (bad data, grey-market, already in your subscription) → Skip.
//   2. Score 0-100 from two components, each judged against the REGULAR price scale:
//        proximity (55%)  how close to the 12-month low and the all-time low
//        typical   (45%)  price vs the TYPICAL SALE price (not vs list price)
//      then adjustments: sale-soon, subscription availability, edition value.
//   3. Verdict from score, then caps (unverified price, over budget, grey-market allowed) and
//      the target-price floor.
//
// Skip is almost entirely override-driven. A mediocre price is "Wait" (a better price is
// plausible), not "Skip". All tunable numbers live in WEIGHTS / THRESHOLDS / the band tables.

import type { Evidence, JudgeInput, JudgeResult, Verdict } from "./types.ts";

export const WEIGHTS = { proximity: 0.55, typical: 0.45, low12mInProximity: 0.65 } as const;
export const THRESHOLDS = { buyNow: 80, buyNowWithTarget: 70, good: 60, wait: 30, minCutForBuyNow: 10 } as const;

const HOUR = 3_600_000;
const RANK: Record<Verdict, number> = { skip: 0, wait: 1, good: 2, buy_now: 3 };
const capAt = (v: Verdict, max: Verdict): Verdict => (RANK[v] <= RANK[max] ? v : max);
const floorAt = (v: Verdict, min: Verdict): Verdict => (RANK[v] >= RANK[min] ? v : min);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function fmt(cents: number, currency: string): string {
  const cur = /^[A-Z]{3}$/.test(currency) ? currency : "USD";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(cents / 100);
}

/** Closeness to a reference low, as a fraction of the regular price. */
function gapScore(price: number, ref: number, regular: number | null): number {
  if (price <= ref) return 100;
  const g = (price - ref) / (regular && regular > 0 ? regular : price);
  if (g <= 0.02) return 100;
  if (g <= 0.05) return 92;
  if (g <= 0.1) return 82;
  if (g <= 0.15) return 68;
  if (g <= 0.25) return 48;
  if (g <= 0.4) return 28;
  return 8;
}

function typicalScore(price: number, typical: number, regular: number | null): number {
  if (regular && regular > 0 && price >= regular * 0.95) return 5; // not actually on sale
  if (typical <= 0) return price <= 0 ? 100 : 5;
  const r = price / typical;
  if (r <= 0.85) return 100;
  if (r <= 0.95) return 92;
  if (r <= 1.05) return 75;
  if (r <= 1.15) return 55;
  if (r <= 1.3) return 35;
  if (r <= 1.6) return 18;
  return 5;
}

function override(verdict: Verdict, confidence: number, ev: Evidence, flag: string): JudgeResult {
  return { verdict, score: 0, confidence, evidence: [ev], flags: [flag] };
}

export function judge(input: JudgeInput, nowMs: number = Date.now()): JudgeResult {
  const { priceCents: price, regularCents: regular, currency, stats, user } = input;
  const $ = (c: number) => fmt(c, currency);
  const evidence: Evidence[] = [];
  const flags: string[] = [];

  // ── 1. hard overrides ──
  if (input.validation === "rejected" || !Number.isInteger(price) || price < 0) {
    return override("skip", 0.8, {
      code: "price_data_invalid", priority: 100,
      text: "The price data looks wrong, so no verdict can be given.", data: {},
    }, "price_data_invalid");
  }
  if (input.shopTier === "grey" && user.excludeGreyMarket) {
    return override("skip", 0.9, {
      code: "grey_market_excluded", priority: 100,
      text: "This is from a grey-market key seller, which you've excluded.", data: {},
    }, "grey_market");
  }
  const owned = input.includedIn.filter((s) => user.subscriptions.includes(s));
  if (owned.length > 0) {
    return override("skip", 0.9, {
      code: "in_your_subscription", priority: 100,
      text: "It's already included in a subscription you have.", data: { service: owned[0] },
    }, "in_subscription");
  }

  // ── 2. components ──
  const cut = input.cutPct ?? (regular && regular > 0 ? Math.round((1 - price / regular) * 100) : 0);
  const hasStats = stats !== null;

  let proximity: number | null = null;
  if (hasStats) {
    const s12 = stats.low12mCents !== null ? gapScore(price, stats.low12mCents, regular) : null;
    const sAtl = stats.atlCents !== null ? gapScore(price, stats.atlCents, regular) : null;
    proximity =
      s12 !== null && sAtl !== null
        ? WEIGHTS.low12mInProximity * s12 + (1 - WEIGHTS.low12mInProximity) * sAtl
        : s12 ?? sAtl;

    if (stats.atlCents !== null) {
      evidence.push(price <= stats.atlCents
        ? { code: "at_all_time_low", priority: 70, text: `${$(price)} matches or beats the all-time low of ${$(stats.atlCents)}.`, data: { priceCents: price, atlCents: stats.atlCents } }
        : { code: "vs_all_time_low", priority: 55, text: `${$(price)} is ${$(price - stats.atlCents)} above the all-time low of ${$(stats.atlCents)}.`, data: { priceCents: price, atlCents: stats.atlCents, gapCents: price - stats.atlCents } });
    }
    if (stats.low12mCents !== null) {
      evidence.push(price <= stats.low12mCents
        ? { code: "at_12m_low", priority: 72, text: `${$(price)} is the lowest price in 12 months.`, data: { priceCents: price, low12mCents: stats.low12mCents } }
        : { code: "vs_12m_low", priority: 62, text: `${$(price)} is ${$(price - stats.low12mCents)} above the 12-month low of ${$(stats.low12mCents)}.`, data: { priceCents: price, low12mCents: stats.low12mCents, gapCents: price - stats.low12mCents } });
    }
  }

  let typical: number | null = null;
  if (hasStats && stats.typicalSaleCents !== null) {
    typical = typicalScore(price, stats.typicalSaleCents, regular);
    const pct = Math.round((1 - price / Math.max(stats.typicalSaleCents, 1)) * 100);
    const rel = pct >= 5 ? `${pct}% below` : pct <= -5 ? `${-pct}% above` : "in line with";
    evidence.push({
      code: "vs_typical_sale", priority: 78,
      text: `${$(price)} is ${rel} the typical sale price of ${$(stats.typicalSaleCents)}.`,
      data: { priceCents: price, typicalSaleCents: stats.typicalSaleCents, pctBelowTypical: pct },
    });
  }
  if (cut > 0) {
    evidence.push({ code: "discount", priority: 30, text: `${cut}% off the regular price.`, data: { cutPct: cut } });
  }

  const parts: Array<[number, number]> = [];
  if (proximity !== null) parts.push([proximity, WEIGHTS.proximity]);
  if (typical !== null) parts.push([typical, WEIGHTS.typical]);

  let base: number;
  let limitedHistory = false;
  if (parts.length === 0) {
    limitedHistory = true;
    base = Math.min(60, cut); // no history: judge by the discount alone, and never above "Good"
    evidence.push({
      code: "limited_history", priority: 60,
      text: "There isn't enough price history yet to compare against past sales.", data: {},
    });
  } else {
    const wsum = parts.reduce((a, [, w]) => a + w, 0);
    base = parts.reduce((a, [s, w]) => a + s * w, 0) / wsum;
  }

  // ── adjustments ──
  let adj = 0;
  let timingUsed = false;

  const ns = input.nextSale;
  const betterPriceHistory = hasStats && (stats.typicalSaleCents !== null || stats.saleCount12m >= 1);
  const notAlreadyGood = stats?.typicalSaleCents != null ? price > stats.typicalSaleCents * 1.05 : cut < 20;
  if (ns && !ns.active && betterPriceHistory && notAlreadyGood) {
    const d = ns.startsInDays;
    const penalty = d <= 7 ? 22 : d <= 14 ? 18 : d <= 30 ? 10 : d <= 45 ? 6 : 0;
    if (penalty > 0) {
      adj -= penalty;
      timingUsed = true;
      flags.push("sale_soon");
      evidence.push({
        code: "sale_soon", priority: 75,
        text: `${ns.name} starts in about ${d} day${d === 1 ? "" : "s"}${ns.confirmed ? "" : " (estimated)"}.`,
        data: { saleName: ns.name, startsInDays: d, confirmed: ns.confirmed },
      });
    }
  } else if (ns && ns.active) {
    evidence.push({
      code: "sale_active", priority: 35,
      text: `${ns.name} is on now (ends in about ${ns.endsInDays} day${ns.endsInDays === 1 ? "" : "s"}).`,
      data: { saleName: ns.name, endsInDays: ns.endsInDays },
    });
  }

  if (input.includedIn.length > 0) {
    adj -= 8;
    flags.push("available_in_subscription");
    evidence.push({
      code: "available_in_subscription", priority: 66,
      text: "It's also available through a subscription service.", data: { service: input.includedIn[0] },
    });
  }

  if (input.edition === "standard") {
    const richer = input.alternatives
      .filter((a) => ["deluxe", "complete", "bundle"].includes(a.edition) && a.priceCents > price && a.priceCents <= price * 1.25)
      .sort((a, b) => a.priceCents - b.priceCents)[0];
    if (richer) {
      adj -= 5;
      flags.push("edition_better_value");
      evidence.push({
        code: "edition_better_value", priority: 45,
        text: `The ${richer.edition} edition costs only ${$(richer.priceCents - price)} more.`,
        data: { edition: richer.edition, extraCents: richer.priceCents - price },
      });
    }
  } else {
    const std = input.alternatives.find((a) => a.edition === "standard");
    if (std && std.priceCents > 0 && price > std.priceCents * 1.6) {
      adj -= 10;
      flags.push("edition_overpay");
      evidence.push({
        code: "edition_overpay", priority: 68,
        text: `This edition costs ${Math.round((price / std.priceCents - 1) * 100)}% more than Standard (${$(std.priceCents)}).`,
        data: { standardCents: std.priceCents, premiumPct: Math.round((price / std.priceCents - 1) * 100) },
      });
    }
  }

  const score = Math.round(clamp(base + adj, 0, 100));

  // ── 3. verdict ──
  const target = user.targetPriceCents;
  const targetHit = target !== null && price <= target;
  const bar = targetHit ? THRESHOLDS.buyNowWithTarget : THRESHOLDS.buyNow;

  let verdict: Verdict;
  if (score >= bar && (targetHit || cut >= THRESHOLDS.minCutForBuyNow)) verdict = "buy_now";
  else if (score >= THRESHOLDS.good) verdict = "good";
  else if (score >= THRESHOLDS.wait) verdict = "wait";
  else {
    const betterPriceLikely =
      betterPriceHistory || (stats?.atlCents != null && stats.atlCents <= price * 0.8) || (ns !== null && !ns.active);
    verdict = betterPriceLikely ? "wait" : "skip";
  }
  // With no history we can neither praise nor condemn the price: stay between Wait and Good.
  if (limitedHistory) verdict = floorAt(capAt(verdict, "good"), "wait");

  if (targetHit) {
    verdict = floorAt(verdict, "good");
    flags.push("target_hit");
    evidence.push({
      code: "target_hit", priority: 90,
      text: `${$(price)} is at or below your target of ${$(target as number)}.`,
      data: { priceCents: price, targetCents: target as number },
    });
  }

  // ── caps ──
  if (input.validation === "unverified") {
    verdict = capAt(verdict, "good");
    flags.push("unverified_price");
    evidence.push({
      code: "unverified_price", priority: 80,
      text: "This price hasn't been confirmed by a second reading yet.", data: {},
    });
  }
  const budget = user.monthlyBudgetCents;
  if (budget !== null && price > budget) {
    verdict = capAt(verdict, "wait");
    flags.push("over_budget");
    evidence.push({
      code: "over_budget", priority: 85,
      text: `${$(price)} is over your budget of ${$(budget)}.`, data: { priceCents: price, budgetCents: budget },
    });
  }
  if (input.shopTier === "grey") {
    verdict = capAt(verdict, "good");
    flags.push("grey_market");
    evidence.push({
      code: "grey_market", priority: 95,
      text: "This seller is a grey-market key reseller; keys can be revoked.", data: {},
    });
  }
  if (input.shopTier === "unknown") flags.push("unknown_seller");

  // ── confidence ──
  let conf = 0.45;
  if (stats?.low12mCents != null) conf += 0.15;
  if (stats?.atlCents != null) conf += 0.1;
  if (stats?.typicalSaleCents != null) conf += 0.15;
  if ((stats?.saleCount12m ?? 0) >= 2) conf += 0.05;
  if (input.validation === "verified") conf += 0.1;

  const age = input.priceCheckedAt ? nowMs - Date.parse(input.priceCheckedAt) : NaN;
  if (!Number.isFinite(age)) conf -= 0.05;
  else if (age > 24 * HOUR) {
    conf -= 0.1;
    flags.push("stale_price");
    evidence.push({
      code: "stale_price", priority: 50,
      text: `The price was last checked ${Math.round(age / HOUR)} hours ago.`, data: { ageHours: Math.round(age / HOUR) },
    });
  }
  if (timingUsed && ns && !ns.confirmed) conf -= 0.05;
  if (input.shopTier === "unknown") conf -= 0.05;
  if (input.validation === "unverified") conf = Math.min(conf, 0.4);
  if (limitedHistory) conf = Math.min(conf, 0.35);
  const confidence = Math.round(clamp(conf, 0.1, 0.95) * 100) / 100;

  evidence.sort((a, b) => b.priority - a.priority);
  return { verdict, score, confidence, evidence, flags: [...new Set(flags)] };
}
