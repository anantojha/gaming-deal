// Sale proximity. Sale dates come from the hand-maintained sale_event table.
// Dates are whole UTC days; real Steam sales start 10:00 Pacific, so treat results as ±1 day.

import type { SaleContext } from "./types.ts";

const DAY = 86_400_000;
const STEAM_SHOP_ID = 61;

export interface SaleEventRow {
  name: string;
  scope: "steam" | "all" | "publisher";
  startsOn: string; // YYYY-MM-DD
  endsOn: string;
  isConfirmed: boolean;
}

function dayNumber(isoDate: string): number {
  const t = Date.parse(`${isoDate}T00:00:00Z`);
  return Number.isFinite(t) ? Math.floor(t / DAY) : NaN;
}

/** Storewide-sale context for ONE shop. Steam sales only apply to Steam offers. */
export function buildSaleContext(
  events: SaleEventRow[],
  nowMs: number,
  shopId: number,
  horizonDays = 60,
): SaleContext | null {
  const today = Math.floor(nowMs / DAY);
  let best: SaleContext | null = null;

  for (const e of events) {
    if (e.scope === "publisher") continue;
    if (e.scope === "steam" && shopId !== STEAM_SHOP_ID) continue;
    const start = dayNumber(e.startsOn);
    const end = dayNumber(e.endsOn);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue;

    if (today >= start && today <= end) {
      return { name: e.name, startsInDays: 0, endsInDays: end - today, active: true, confirmed: e.isConfirmed };
    }
    const startsIn = start - today;
    if (startsIn > 0 && startsIn <= horizonDays && (!best || startsIn < best.startsInDays)) {
      best = { name: e.name, startsInDays: startsIn, endsInDays: end - today, active: false, confirmed: e.isConfirmed };
    }
  }
  return best;
}
