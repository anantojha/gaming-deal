// One ingestion pass. Watch-driven: it only touches products somebody is watching (never a
// catalog crawl). ITAD calls are batched per region. CheapShark is called ONLY to corroborate
// a big drop, and only for US prices (CheapShark is USD).
//
// This module decides nothing about alerts. It stores validated prices and reports `changes`;
// the alert step consumes those (verified only).

import { BudgetExceededError, RateLimitedError } from "../sources/http.ts";
import { mapStoresByName } from "../sources/cheapshark.ts";
import type { CsGameDetail, CsGameSummary, CsStore } from "../sources/cheapshark.ts";
import type { HistoryLow, ItadShop, Overview, PriceEvent } from "../sources/itad.ts";
import type { IngestRepo, PricePointWrite, StatsRow, Validation, WatchedItem } from "./repo.ts";
import { computeStats } from "./stats.ts";
import { validatePrice, type ReasonCode, type ValidationInput } from "./validate.ts";

const DAY = 86_400_000;

export interface ItadPort {
  shops(): Promise<ItadShop[]>;
  overview(ids: string[]): Promise<Map<string, Overview>>;
  historyLow(ids: string[]): Promise<Map<string, HistoryLow>>;
  history(id: string, since: Date): Promise<PriceEvent[]>;
}

export interface CsPort {
  stores(): Promise<CsStore[]>;
  gameBySteamAppId(appid: number): Promise<CsGameSummary | null>;
  gameDetail(gameId: number): Promise<CsGameDetail | null>;
}

export interface IngestDeps {
  repo: IngestRepo;
  itadForRegion: (region: string) => ItadPort;
  cs: CsPort;
  now?: () => number;
}

export interface IngestOptions {
  /** Max watched items per pass; keep small enough for the Worker's subrequest limit. */
  maxItems: number;
  /** Recompute history stats at most this often unless the price moved. */
  statsMaxAgeMs: number;
}

export const DEFAULT_INGEST: IngestOptions = { maxItems: 20, statsMaxAgeMs: 24 * 3600_000 };

export interface PriceChange {
  productId: string;
  listingId: string;
  region: string;
  shopId: number;
  priceCents: number;
  previousPriceCents: number | null;
  validation: Validation;
  isBigDrop: boolean;
  reasons: ReasonCode[];
}

export interface IngestSummary {
  due: number;
  processed: number;
  noOffer: number;
  verified: number;
  unverified: number;
  rejected: number;
  errors: string[];
  stoppedEarly: null | "itad_rate_limited" | "itad_budget";
  csSkipped: boolean;
  changes: PriceChange[];
}

const isStop = (e: unknown) => e instanceof RateLimitedError || e instanceof BudgetExceededError;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

export async function runIngestion(
  deps: IngestDeps,
  overrides: Partial<IngestOptions> = {},
): Promise<IngestSummary> {
  const o = { ...DEFAULT_INGEST, ...overrides };
  const now = deps.now ?? (() => Date.now());
  const { repo } = deps;

  const items = await repo.listDueItems(o.maxItems, now());
  const summary: IngestSummary = {
    due: items.length, processed: 0, noOffer: 0, verified: 0, unverified: 0, rejected: 0,
    errors: [], stoppedEarly: null, csSkipped: false, changes: [],
  };
  if (items.length === 0) return summary;

  const tiers = await repo.getShopTiers();
  const byRegion = new Map<string, WatchedItem[]>();
  for (const it of items) byRegion.set(it.region, [...(byRegion.get(it.region) ?? []), it]);

  const cs = { disabled: false, storeMap: null as Map<number, number> | null };

  for (const [region, group] of byRegion) {
    const itad = deps.itadForRegion(region);
    try {
      const shops = await itad.shops();
      await repo.ensureShops(shops.map((s) => ({ id: s.id, name: s.title })));
      const crawledAt = new Map(shops.map((s) => [s.id, s.updatedAt]));
      const ids = group.map((g) => g.itadId);
      const overview = await itad.overview(ids);
      const lows = await itad.historyLow(ids);

      for (const item of group) {
        try {
          await processItem(item, shops, crawledAt, overview, lows, itad);
        } catch (e) {
          if (isStop(e)) throw e;
          summary.errors.push(`${item.productId}: ${msg(e)}`);
        }
      }
    } catch (e) {
      if (e instanceof RateLimitedError) { summary.stoppedEarly = "itad_rate_limited"; break; }
      if (e instanceof BudgetExceededError) { summary.stoppedEarly = "itad_budget"; break; }
      summary.errors.push(`region ${region}: ${msg(e)}`);
    }
  }
  return summary;

  // ───────────────────────── per item ─────────────────────────
  async function processItem(
    item: WatchedItem,
    shops: ItadShop[],
    crawledAt: Map<number, string | null>,
    overview: Map<string, Overview>,
    lows: Map<string, HistoryLow>,
    itad: ItadPort,
  ): Promise<void> {
    const offer = overview.get(item.itadId)?.current ?? null;
    if (!offer) { summary.noOffer++; return; }
    const region = item.region;
    const nowIso = new Date(now()).toISOString();

    const listing = await repo.getListing(item.productId, offer.shopId, region);
    const previous = listing?.priceCents ?? null;

    // ── history-derived stats: refresh only when stale, new, or the price moved ──
    let stats = await repo.getStats(item.productId, region);
    const low = lows.get(item.itadId) ?? null;
    const stale = !stats || now() - Date.parse(stats.computedAt) > o.statsMaxAgeMs;
    const priceMoved = previous !== null && previous !== offer.priceCents;
    let historyEvents: PriceEvent[] = [];
    if (stale || priceMoved || !listing) {
      historyEvents = await itad.history(item.itadId, new Date(now() - 365 * DAY));
      const trusted = historyEvents.filter((e) => tiers.get(e.shopId) !== "grey");
      const c = computeStats(trusted, now());
      const next: StatsRow = {
        productId: item.productId, region,
        // NOTE: ITAD's all-time low may come from a grey-market shop. Known gap; to be
        // tightened by restricting historyLow to trusted shops once their ids are classified.
        atlCents: low?.priceCents ?? stats?.atlCents ?? null,
        atlAt: low?.at ?? stats?.atlAt ?? null,
        atlShopId: low?.shopId ?? stats?.atlShopId ?? null,
        low12mCents: c.low12mCents,
        typicalSaleCents: c.typicalSaleCents,
        regularCents: c.regularCents ?? offer.regularCents,
        saleCount12m: c.saleCount12m,
        computedAt: nowIso,
      };
      await repo.upsertStats(next);
      stats = next;
    }

    // ── validate ──
    const changedAt = offer.changedAt;
    const existing = listing && changedAt ? await repo.getPricePoint(listing.id, changedAt, offer.priceCents) : null;
    const input: ValidationInput = {
      priceCents: offer.priceCents,
      regularCents: offer.regularCents,
      cut: offer.cut,
      previousPriceCents: previous,
      allTimeLowCents: low?.priceCents ?? stats?.atlCents ?? null,
      sourceCheckedAt: crawledAt.get(offer.shopId) ?? null,
      csPriceAtShopCents: null,
      repeatConfirmedAt: existing?.observedAt ?? null,
    };
    let result = validatePrice(input, now());

    // Always consult CheapShark for a big drop (US only) that isn't already confirmed, even if a
    // repeat reading would pass it: an independent source that DISAGREES must block the alert.
    // Skip when the source is stale (a recheck is coming anyway) or the price was rejected.
    const needsSecondReading =
      result.isBigDrop && result.status !== "rejected" && !result.reasons.includes("stale_source") &&
      existing?.validation !== "verified" && region === "US" && !cs.disabled;
    if (needsSecondReading) {
      try {
        const csPrice = await csPriceAtShop(item, offer.shopId, shops);
        if (csPrice !== null) result = validatePrice({ ...input, csPriceAtShopCents: csPrice }, now());
      } catch (e) {
        if (isStop(e)) { cs.disabled = true; summary.csSkipped = true; }
        else summary.errors.push(`cheapshark ${item.productId}: ${msg(e)}`);
      }
    }

    // "verified" is sticky: a later stale crawl must not downgrade a price already confirmed.
    const status: Validation = existing?.validation === "verified" ? "verified" : result.status;
    const reason = status === "verified" ? null : result.reasons.join(",") || null;

    // ── write ──
    const listingId = await repo.upsertListing({
      productId: item.productId, shopId: offer.shopId, source: "itad", region,
      currency: offer.currency, url: offer.url, priceCents: offer.priceCents,
      regularCents: offer.regularCents, cutPct: offer.cut,
      priceChangedAt: changedAt, expiresAt: offer.expiresAt, lastCheckedAt: nowIso,
    });

    if (changedAt) {
      await repo.upsertPricePoint({
        listingId, changedAt, priceCents: offer.priceCents, regularCents: offer.regularCents,
        cutPct: offer.cut, source: "itad", validation: status, reason,
      });
    }
    if (historyEvents.length > 0) {
      const hist: PricePointWrite[] = historyEvents
        .filter((e) => e.shopId === offer.shopId)
        .filter((e) => !(Date.parse(e.changedAt) === Date.parse(changedAt ?? "") && e.priceCents === offer.priceCents))
        .map((e) => ({
          listingId, changedAt: e.changedAt, priceCents: e.priceCents, regularCents: e.regularCents,
          cutPct: e.cut, source: "itad" as const, validation: "verified" as const, reason: null,
        }));
      if (hist.length > 0) await repo.insertHistoricalPoints(hist);
    }

    summary.processed++;
    summary[status]++;
    if (previous === null || previous !== offer.priceCents) {
      summary.changes.push({
        productId: item.productId, listingId, region, shopId: offer.shopId,
        priceCents: offer.priceCents, previousPriceCents: previous,
        validation: status, isBigDrop: result.isBigDrop, reasons: result.reasons,
      });
    }
  }

  // CheapShark price for the same store, or null if it has none / can't be mapped.
  async function csPriceAtShop(item: WatchedItem, itadShopId: number, shops: ItadShop[]): Promise<number | null> {
    if (!cs.storeMap) {
      cs.storeMap = mapStoresByName(
        await deps.cs.stores(),
        shops.map((s) => ({ id: s.id, title: s.title })),
      );
    }
    let csStoreId: number | null = null;
    for (const [storeId, shopId] of cs.storeMap) if (shopId === itadShopId) csStoreId = storeId;
    if (csStoreId === null) return null;

    let gameId = item.csGameId;
    if (gameId === null && item.steamAppId !== null) {
      gameId = (await deps.cs.gameBySteamAppId(item.steamAppId))?.gameId ?? null;
      if (gameId !== null) await repo.setCsGameId(item.productId, gameId);
    }
    if (gameId === null) return null;

    const detail = await deps.cs.gameDetail(gameId);
    const prices = (detail?.deals ?? []).filter((d) => d.storeId === csStoreId).map((d) => d.priceCents);
    return prices.length > 0 ? Math.min(...prices) : null;
  }
}
