// Supabase implementation of IngestRepo. Column names match supabase/migrations/0001_init.sql.

import type {
  IngestRepo, ListingRow, ListingWrite, PricePointWrite, StatsRow, TrustTier, Validation, WatchedItem,
} from "../ingest/repo.ts";
import { SupabaseRest } from "./rest.ts";

const CHUNK = 500;

type Row = Record<string, unknown>;
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export interface SupabaseRepoOptions {
  /** Don't re-poll a product checked more recently than this (cache aggressively). */
  minRecheckMs?: number;
}

export class SupabaseRepo implements IngestRepo {
  private db: SupabaseRest;
  private minRecheckMs: number;

  constructor(db: SupabaseRest, o: SupabaseRepoOptions = {}) {
    this.db = db;
    this.minRecheckMs = o.minRecheckMs ?? 30 * 60_000;
  }

  async listDueItems(limit: number, nowMs: number): Promise<WatchedItem[]> {
    const watches = await this.db.select<Row>("watch", {
      select: "product_id,product(id,itad_id,steam_appid,cheapshark_game_id),user_profile(region)",
      status: "eq.active",
      limit: "2000",
    });

    // One entry per (product, region), however many users watch it.
    const wanted = new Map<string, WatchedItem>();
    for (const w of watches) {
      const p = w.product as Row | null;
      const region = str((w.user_profile as Row | null)?.region)?.trim().toUpperCase();
      const itadId = str(p?.itad_id);
      const productId = str(p?.id);
      if (!p || !region || !itadId || !productId) continue;
      wanted.set(`${productId}|${region}`, {
        productId, itadId, region,
        steamAppId: num(p.steam_appid),
        csGameId: num(p.cheapshark_game_id),
      });
    }
    if (wanted.size === 0) return [];

    // Last check time per (product, region), newest listing wins.
    const lastChecked = new Map<string, number>();
    const productIds = [...new Set([...wanted.values()].map((w) => w.productId))];
    for (let i = 0; i < productIds.length; i += 100) {
      const rows = await this.db.select<Row>("listing", {
        select: "product_id,region,last_checked_at",
        product_id: `in.(${productIds.slice(i, i + 100).join(",")})`,
        source: "eq.itad",
      });
      for (const r of rows) {
        const t = Date.parse(str(r.last_checked_at) ?? "");
        const key = `${str(r.product_id)}|${str(r.region)?.trim().toUpperCase()}`;
        if (Number.isFinite(t)) lastChecked.set(key, Math.max(lastChecked.get(key) ?? 0, t));
      }
    }

    return [...wanted.entries()]
      .map(([key, item]) => ({ key, item, t: lastChecked.get(key) ?? -Infinity }))
      .filter((x) => nowMs - x.t >= this.minRecheckMs) // -Infinity (never checked) always passes
      .sort((a, b) => a.t - b.t) // never-checked first, then oldest
      .slice(0, limit)
      .map((x) => x.item);
  }

  async getShopTiers(): Promise<Map<number, TrustTier>> {
    const rows = await this.db.select<Row>("shop", { select: "id,trust_tier" });
    const out = new Map<number, TrustTier>();
    for (const r of rows) {
      const id = num(r.id);
      const tier = str(r.trust_tier) as TrustTier | null;
      if (id !== null && tier) out.set(id, tier);
    }
    return out;
  }

  async ensureShops(shops: { id: number; name: string }[]): Promise<void> {
    for (let i = 0; i < shops.length; i += CHUNK) {
      await this.db.upsert(
        "shop",
        shops.slice(i, i + CHUNK).map((s) => ({ id: s.id, name: s.name })),
        { onConflict: "id", ignoreDuplicates: true }, // never overwrite a curated trust_tier
      );
    }
  }

  async getListing(productId: string, shopId: number, region: string): Promise<ListingRow | null> {
    const rows = await this.db.select<Row>("listing", {
      select: "id,product_id,shop_id,region,price_cents",
      product_id: `eq.${productId}`,
      shop_id: `eq.${shopId}`,
      source: "eq.itad",
      region: `eq.${region}`,
      limit: "1",
    });
    const r = rows[0];
    if (!r) return null;
    return {
      id: String(r.id), productId: String(r.product_id), shopId: Number(r.shop_id),
      region: String(r.region), priceCents: num(r.price_cents),
    };
  }

  async upsertListing(row: ListingWrite): Promise<string> {
    const out = await this.db.upsert<Row>(
      "listing",
      [{
        product_id: row.productId, shop_id: row.shopId, source: row.source, region: row.region,
        currency: row.currency, url: row.url, price_cents: row.priceCents,
        regular_cents: row.regularCents, cut_pct: row.cutPct,
        price_changed_at: row.priceChangedAt, expires_at: row.expiresAt,
        last_checked_at: row.lastCheckedAt,
      }],
      { onConflict: "product_id,shop_id,source,region", returning: "id" },
    );
    const id = str(out[0]?.id);
    if (!id) throw new Error("upsertListing: no id returned");
    return id;
  }

  async getPricePoint(listingId: string, changedAt: string, priceCents: number) {
    const rows = await this.db.select<Row>("price_point", {
      select: "observed_at,validation",
      listing_id: `eq.${listingId}`,
      changed_at: `eq.${changedAt}`,
      price_cents: `eq.${priceCents}`,
      limit: "1",
    });
    const r = rows[0];
    if (!r) return null;
    return { observedAt: String(r.observed_at), validation: String(r.validation) as Validation };
  }

  private pointRow(p: PricePointWrite): Row {
    // observed_at is deliberately omitted: it keeps its default on insert and is never
    // overwritten on conflict, so it always records the FIRST sighting.
    return {
      listing_id: p.listingId, changed_at: p.changedAt, price_cents: p.priceCents,
      regular_cents: p.regularCents, cut_pct: p.cutPct, source: p.source,
      validation: p.validation, reject_reason: p.reason,
    };
  }

  async upsertPricePoint(row: PricePointWrite): Promise<void> {
    await this.db.upsert("price_point", [this.pointRow(row)], { onConflict: "listing_id,changed_at,price_cents" });
  }

  async insertHistoricalPoints(rows: PricePointWrite[]): Promise<void> {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await this.db.upsert("price_point", rows.slice(i, i + CHUNK).map((r) => this.pointRow(r)), {
        onConflict: "listing_id,changed_at,price_cents",
        ignoreDuplicates: true, // must never overwrite a validated point
      });
    }
  }

  async getStats(productId: string, region: string): Promise<StatsRow | null> {
    const rows = await this.db.select<Row>("price_stats", {
      select: "*", product_id: `eq.${productId}`, region: `eq.${region}`, limit: "1",
    });
    const r = rows[0];
    if (!r) return null;
    return {
      productId, region,
      atlCents: num(r.atl_cents), atlAt: str(r.atl_at), atlShopId: num(r.atl_shop_id),
      low12mCents: num(r.low_12m_cents), typicalSaleCents: num(r.typical_sale_cents),
      regularCents: num(r.regular_cents), saleCount12m: num(r.sale_count_12m) ?? 0,
      computedAt: String(r.computed_at),
    };
  }

  async upsertStats(s: StatsRow): Promise<void> {
    await this.db.upsert("price_stats", [{
      product_id: s.productId, region: s.region,
      atl_cents: s.atlCents, atl_at: s.atlAt, atl_shop_id: s.atlShopId,
      low_12m_cents: s.low12mCents, typical_sale_cents: s.typicalSaleCents,
      regular_cents: s.regularCents, sale_count_12m: s.saleCount12m, computed_at: s.computedAt,
    }], { onConflict: "product_id,region" });
  }

  async setCsGameId(productId: string, csGameId: number): Promise<void> {
    await this.db.patch("product", { id: `eq.${productId}` }, { cheapshark_game_id: csGameId });
  }
}

/**
 * Durable daily request guard backed by bump_usage(). Fails CLOSED: if the ledger can't be
 * read, the request is not sent. Counts attempts (including retries) against the cap.
 */
export function makeReserve(db: SupabaseRest, provider: "itad" | "cheapshark", dailyCap: number) {
  return async (): Promise<boolean> => {
    const rows = await db.rpc<Array<{ total_requests?: unknown }>>("bump_usage", {
      p_provider: provider,
      p_requests: 1,
    });
    const total = Array.isArray(rows) ? Number(rows[0]?.total_requests) : NaN;
    return Number.isFinite(total) && total <= dailyCap;
  };
}
