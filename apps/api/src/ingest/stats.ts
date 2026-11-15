// Pure computation of the deal-score inputs that come from price history.
// Callers should pass events with grey-market shops already filtered out.
//
// Approximations (deliberate, documented):
//  - Works on price-CHANGE events, not time-weighted. A sale that lasted a day counts the same
//    as one that lasted a month.
//  - "Sale" = price at least 10% below that event's regular price.
//  - typicalSaleCents = median sale price across all trusted shops, vs the REGULAR price,
//    which is what the spec asks for ("typical sale price", not list price).
//  - saleCount12m = most sale episodes seen at any single shop (an episode = a non-sale → sale
//    transition), so simultaneous sales at several shops aren't double counted.

import type { PriceEvent } from "../sources/itad.ts";

const DAY = 86_400_000;

export interface ComputedStats {
  low12mCents: number | null;
  typicalSaleCents: number | null;
  saleCount12m: number;
  regularCents: number | null;
}

function isSale(e: PriceEvent): boolean {
  return e.regularCents !== null && e.regularCents > 0 && e.priceCents <= e.regularCents * 0.9;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round((v[mid - 1] + v[mid]) / 2);
}

export function computeStats(events: PriceEvent[], nowMs: number): ComputedStats {
  const from = nowMs - 365 * DAY;
  const win = events
    .filter((e) => {
      const t = Date.parse(e.changedAt);
      return t >= from && t <= nowMs + DAY; // tolerate small clock skew
    })
    .sort((a, b) => Date.parse(a.changedAt) - Date.parse(b.changedAt));

  if (win.length === 0) {
    return { low12mCents: null, typicalSaleCents: null, saleCount12m: 0, regularCents: null };
  }

  const low12mCents = Math.min(...win.map((e) => e.priceCents));
  const typicalSaleCents = median(win.filter(isSale).map((e) => e.priceCents));

  let regularCents: number | null = null;
  for (const e of win) if (e.regularCents !== null && e.regularCents > 0) regularCents = e.regularCents;

  const byShop = new Map<number, PriceEvent[]>();
  for (const e of win) byShop.set(e.shopId, [...(byShop.get(e.shopId) ?? []), e]);
  let saleCount12m = 0;
  for (const list of byShop.values()) {
    let episodes = 0;
    let inSale = false;
    for (const e of list) {
      const s = isSale(e);
      if (s && !inSale) episodes++;
      inSale = s;
    }
    saleCount12m = Math.max(saleCount12m, episodes);
  }

  return { low12mCents, typicalSaleCents, saleCount12m, regularCents };
}
