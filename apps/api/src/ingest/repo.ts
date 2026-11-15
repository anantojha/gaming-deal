// The storage contract the ingestion job depends on. The job never touches Supabase directly,
// so it can be tested with an in-memory fake and the Supabase adapter can be swapped or fixed
// without touching business logic.

export type TrustTier = "official" | "authorized" | "grey" | "unknown";
export type Validation = "unverified" | "verified" | "rejected";

/** One watched product in one region (region = the watcher's profile region). */
export interface WatchedItem {
  productId: string;
  itadId: string;
  steamAppId: number | null;
  csGameId: number | null;
  region: string;
}

export interface ListingRow {
  id: string;
  productId: string;
  shopId: number;
  region: string;
  priceCents: number | null;
}

export interface ListingWrite {
  productId: string;
  shopId: number;
  source: "itad";
  region: string;
  currency: string;
  url: string | null; // exactly as the source gave it
  priceCents: number;
  regularCents: number;
  cutPct: number;
  priceChangedAt: string | null;
  expiresAt: string | null;
  lastCheckedAt: string;
}

export interface StatsRow {
  productId: string;
  region: string;
  atlCents: number | null;
  atlAt: string | null;
  atlShopId: number | null;
  low12mCents: number | null;
  typicalSaleCents: number | null;
  regularCents: number | null;
  saleCount12m: number;
  computedAt: string;
}

export interface PricePointWrite {
  listingId: string;
  changedAt: string;
  priceCents: number;
  regularCents: number | null;
  cutPct: number | null;
  source: "itad";
  validation: Validation;
  reason: string | null; // comma-separated reason codes when not verified
}

export interface IngestRepo {
  /** Active-watched products, least-recently-checked first, at most `limit`. */
  listDueItems(limit: number, nowMs: number): Promise<WatchedItem[]>;
  getShopTiers(): Promise<Map<number, TrustTier>>;
  /** Insert shops that don't exist yet (tier 'unknown'); never overwrite existing rows. */
  ensureShops(shops: { id: number; name: string }[]): Promise<void>;
  getListing(productId: string, shopId: number, region: string): Promise<ListingRow | null>;
  /** Insert or update by (product, shop, source, region). Returns the listing id. */
  upsertListing(row: ListingWrite): Promise<string>;
  getPricePoint(
    listingId: string,
    changedAt: string,
    priceCents: number,
  ): Promise<{ observedAt: string; validation: Validation } | null>;
  /** Insert; on conflict update ONLY validation + reason (observed_at keeps the first sighting). */
  upsertPricePoint(row: PricePointWrite): Promise<void>;
  /** Insert history rows; on conflict do NOTHING (must never overwrite a validated point). */
  insertHistoricalPoints(rows: PricePointWrite[]): Promise<void>;
  getStats(productId: string, region: string): Promise<StatsRow | null>;
  upsertStats(row: StatsRow): Promise<void>;
  setCsGameId(productId: string, csGameId: number): Promise<void>;
}
