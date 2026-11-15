// Pure price validation, no I/O. Decides whether a price observation may be trusted for alerts.
//
//   rejected   → impossible/inconsistent data. Store it flagged, never alert.
//   unverified → plausible but not yet trustworthy (stale source, or a BIG drop with no second
//                reading). Hold the alert and schedule a recheck.
//   verified   → safe to alert on.
//
// A "second reading" is either (a) an independent source (CheapShark) agreeing at the same
// store, or (b) the same source repeating the identical price after a gap. If CheapShark
// positively DISAGREES, a repeat reading is not enough: the sources must reconcile first.

export type ReasonCode =
  | "invalid_price"
  | "price_above_ceiling"
  | "price_above_regular"
  | "cut_mismatch"
  | "stale_source"
  | "no_corroboration"
  | "cs_disagrees"
  | "corroborated_by_cs"
  | "corroborated_by_repeat";

export interface ValidationInput {
  priceCents: number;
  regularCents: number | null;
  cut: number | null;
  /** Last price we had stored for this listing, if any. */
  previousPriceCents: number | null;
  allTimeLowCents: number | null;
  /** When the source last crawled this shop (ITAD shops `update`), NOT when the price changed. */
  sourceCheckedAt: string | null;
  /** CheapShark's price for the same store, or null if it had none / wasn't queried. */
  csPriceAtShopCents: number | null;
  /** Timestamp of an earlier reading of this exact price from the same source, if any. */
  repeatConfirmedAt: string | null;
}

export interface ValidationOptions {
  maxCents: number; // absolute sanity ceiling
  bigDropPct: number; // drop vs previous price that counts as "big"
  bigCutPct: number; // discount vs regular that counts as "big"
  maxSourceAgeMs: number;
  tolPct: number; // cross-source tolerance, percent of price
  tolMinCents: number; // …or this many cents, whichever is larger
  repeatMinGapMs: number;
  cutToleranceMin: number; // allowed gap between stated and implied discount, percentage points
}

export const DEFAULT_VALIDATION: ValidationOptions = {
  maxCents: 100_000, // $1,000
  bigDropPct: 50,
  bigCutPct: 75,
  maxSourceAgeMs: 12 * 3600_000,
  tolPct: 5,
  tolMinCents: 50,
  repeatMinGapMs: 30 * 60_000,
  cutToleranceMin: 2,
};

export interface ValidationResult {
  status: "verified" | "unverified" | "rejected";
  reasons: ReasonCode[];
  /** True when the scheduler should take another reading later. */
  needsRecheck: boolean;
  /** True when this observation counted as a "big drop" that demands corroboration. */
  isBigDrop: boolean;
}

function reject(reason: ReasonCode): ValidationResult {
  return { status: "rejected", reasons: [reason], needsRecheck: false, isBigDrop: false };
}

export function validatePrice(
  input: ValidationInput,
  nowMs: number = Date.now(),
  overrides: Partial<ValidationOptions> = {},
): ValidationResult {
  const o = { ...DEFAULT_VALIDATION, ...overrides };
  const { priceCents: price, regularCents: regular } = input;

  // ── hard rejects ──
  if (!Number.isInteger(price) || price < 0) return reject("invalid_price");
  if (price > o.maxCents) return reject("price_above_ceiling");

  let impliedCut: number | null = null;
  if (regular !== null && regular > 0) {
    if (price > regular) return reject("price_above_regular");
    impliedCut = Math.round((1 - price / regular) * 100);
    if (input.cut !== null && Math.abs(impliedCut - input.cut) > o.cutToleranceMin) {
      return reject("cut_mismatch");
    }
  }

  const reasons: ReasonCode[] = [];

  // ── staleness (unknown crawl time counts as stale) ──
  const ageMs = input.sourceCheckedAt ? nowMs - Date.parse(input.sourceCheckedAt) : Infinity;
  const stale = !(ageMs <= o.maxSourceAgeMs);
  if (stale) reasons.push("stale_source");

  // ── is this a big drop? ──
  const prev = input.previousPriceCents;
  const dropPct = prev !== null && prev > 0 ? (1 - price / prev) * 100 : 0;
  const cutPct = input.cut ?? impliedCut ?? 0;
  const belowAtl = input.allTimeLowCents !== null && price < input.allTimeLowCents;
  const isBigDrop = price === 0 || dropPct >= o.bigDropPct || cutPct >= o.bigCutPct || belowAtl;

  // ── corroboration, only needed for big drops ──
  let corroborated = false;
  if (isBigDrop) {
    let disagrees = false;
    if (input.csPriceAtShopCents !== null) {
      const tol = Math.max(o.tolMinCents, Math.round((price * o.tolPct) / 100));
      if (Math.abs(input.csPriceAtShopCents - price) <= tol) {
        corroborated = true;
        reasons.push("corroborated_by_cs");
      } else {
        disagrees = true;
        reasons.push("cs_disagrees");
      }
    }
    if (!corroborated && !disagrees && input.repeatConfirmedAt) {
      const gap = nowMs - Date.parse(input.repeatConfirmedAt);
      if (gap >= o.repeatMinGapMs) {
        corroborated = true;
        reasons.push("corroborated_by_repeat");
      }
    }
    if (!corroborated && !disagrees) reasons.push("no_corroboration");
  }

  const unverified = stale || (isBigDrop && !corroborated);
  return {
    status: unverified ? "unverified" : "verified",
    reasons,
    needsRecheck: unverified,
    isBigDrop,
  };
}
