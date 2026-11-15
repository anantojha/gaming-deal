// Types for the rule-based deal judge. Everything here is plain data: no I/O, no model calls.

export type Verdict = "buy_now" | "good" | "wait" | "skip";
export type Edition = "standard" | "deluxe" | "complete" | "bundle" | "other";
export type ShopTier = "official" | "authorized" | "grey" | "unknown";

export interface JudgeStats {
  atlCents: number | null;
  low12mCents: number | null;
  typicalSaleCents: number | null;
  saleCount12m: number;
}

export interface SaleContext {
  name: string;
  /** Days until the sale starts (0 when already active). */
  startsInDays: number;
  /** Days until it ends (only meaningful when active). */
  endsInDays: number;
  active: boolean;
  /** false = date is an estimate; lowers confidence in any "wait for the sale" advice. */
  confirmed: boolean;
}

export interface JudgeInput {
  priceCents: number;
  regularCents: number | null;
  currency: string;
  cutPct: number | null;
  validation: "verified" | "unverified" | "rejected";
  /** When WE last fetched this price (listing.last_checked_at). */
  priceCheckedAt: string | null;
  shopTier: ShopTier;
  edition: Edition;
  stats: JudgeStats | null;
  nextSale: SaleContext | null;
  /** Subscription services that include this game right now (e.g. "gamepass_pc"). */
  includedIn: string[];
  /** Other editions of the same game, for edition/bundle value. */
  alternatives: { edition: Edition; priceCents: number }[];
  user: {
    targetPriceCents: number | null;
    monthlyBudgetCents: number | null;
    excludeGreyMarket: boolean;
    subscriptions: string[];
  };
}

export interface Evidence {
  /** Stable machine code; the explanation step keys off this. */
  code: string;
  /** Deterministic English sentence built only from our own numbers. */
  text: string;
  /** Numeric facts behind the sentence. Safe to give to a model. */
  data: Record<string, number | string | boolean | null>;
  /** Higher = more important when only a couple of lines fit. */
  priority: number;
}

export interface JudgeResult {
  verdict: Verdict;
  /** 0-100 rule score before overrides and caps. */
  score: number;
  /** 0-1 confidence in the verdict (data sufficiency and verification), not in the game's quality. */
  confidence: number;
  evidence: Evidence[];
  flags: string[];
}
