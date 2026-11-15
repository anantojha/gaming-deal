// IsThereAnyDeal client. Auth is the API key (header), NOT the OAuth client id/secret.
// Parsers are pure and defensive: a field we don't recognise becomes null, never a crash,
// and a malformed record is skipped rather than poisoning a whole batch.
// Shapes verified against real responses: lookup, overview.current, historylow, history, shops.
// NOT yet verified against a positive result: subs. Overview `lowest` is parsed leniently.

import { asRecord, asString, toInt } from "../ingest/normalize.ts";
import type { HttpClient } from "./http.ts";

const BASE = "https://api.isthereanydeal.com";
/** Conservative per-request batch size; confirm ITAD's real cap in its docs before raising. */
export const ITAD_MAX_BATCH = 100;

export interface ItadGame {
  id: string;
  slug: string | null;
  title: string;
  type: string | null;
  mature: boolean;
}

export interface Offer {
  shopId: number;
  shopName: string;
  priceCents: number;
  regularCents: number;
  cut: number;
  url: string | null; // stored UNMODIFIED (affiliate tag must stay intact)
  changedAt: string | null; // when this price last CHANGED, not when ITAD checked it
  expiresAt: string | null;
  drm: string[];
  platforms: string[];
  flag: string | null;
  hasVoucher: boolean; // price may require a voucher code
}

export interface Overview {
  current: Offer | null;
  lowest: Offer | null;
}

export interface HistoryLow {
  shopId: number;
  shopName: string;
  priceCents: number;
  regularCents: number | null;
  cut: number | null;
  at: string | null;
}

export interface PriceEvent {
  shopId: number;
  shopName: string;
  changedAt: string; // ISO with offset, as ITAD returns it
  priceCents: number;
  regularCents: number | null;
  cut: number | null;
}

export interface ItadShop {
  id: number;
  title: string;
  deals: number | null;
  games: number | null;
  updatedAt: string | null; // last crawl; use THIS for staleness
}

// ───────────── pure parsers ─────────────

function money(v: unknown): number | null {
  const r = asRecord(v);
  if (!r) return null;
  if (typeof r.amountInt === "number" && Number.isInteger(r.amountInt) && r.amountInt >= 0) return r.amountInt;
  if (typeof r.amount === "number" && Number.isFinite(r.amount) && r.amount >= 0) return Math.round(r.amount * 100);
  return null;
}

function names(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item === "string") out.push(item.slice(0, 60));
    else {
      const n = asString(asRecord(item)?.name);
      if (n) out.push(n.slice(0, 60));
    }
  }
  return out;
}

export function parseLookup(body: unknown): ItadGame | null {
  const r = asRecord(body);
  const g = asRecord(r?.game);
  if (!r || r.found !== true || !g) return null;
  const id = asString(g.id);
  const title = asString(g.title);
  if (!id || !title) return null;
  return {
    id,
    slug: asString(g.slug),
    title: title.slice(0, 200),
    type: asString(g.type),
    mature: g.mature === true,
  };
}

export function parseOffer(v: unknown): Offer | null {
  const r = asRecord(v);
  const shop = asRecord(r?.shop);
  if (!r || !shop) return null;
  const shopId = toInt(shop.id);
  const priceCents = money(r.price);
  if (shopId === null || priceCents === null) return null;
  const regularCents = money(r.regular) ?? priceCents;
  return {
    shopId,
    shopName: (asString(shop.name) ?? `shop-${shopId}`).slice(0, 80),
    priceCents,
    regularCents,
    cut: typeof r.cut === "number" ? r.cut : 0,
    url: asString(r.url),
    changedAt: asString(r.timestamp),
    expiresAt: asString(r.expiry),
    drm: names(r.drm),
    platforms: names(r.platforms),
    flag: asString(r.flag),
    hasVoucher: r.voucher !== null && r.voucher !== undefined,
  };
}

export function parseOverview(body: unknown): Map<string, Overview> {
  const out = new Map<string, Overview>();
  const prices = asRecord(body)?.prices;
  if (!Array.isArray(prices)) return out;
  for (const p of prices) {
    const r = asRecord(p);
    const id = asString(r?.id);
    if (!r || !id) continue;
    out.set(id, { current: parseOffer(r.current), lowest: parseOffer(r.lowest) });
  }
  return out;
}

export function parseHistoryLow(body: unknown): Map<string, HistoryLow> {
  const out = new Map<string, HistoryLow>();
  if (!Array.isArray(body)) return out;
  for (const item of body) {
    const r = asRecord(item);
    const id = asString(r?.id);
    const low = asRecord(r?.low);
    const shop = asRecord(low?.shop);
    const shopId = toInt(shop?.id);
    const priceCents = money(low?.price);
    if (!id || !low || shopId === null || priceCents === null) continue; // low can be null: no history
    out.set(id, {
      shopId,
      shopName: (asString(shop?.name) ?? `shop-${shopId}`).slice(0, 80),
      priceCents,
      regularCents: money(low.regular),
      cut: typeof low.cut === "number" ? low.cut : null,
      at: asString(low.timestamp),
    });
  }
  return out;
}

/** Returns events oldest-first (ITAD returns newest-first). */
export function parseHistory(body: unknown): PriceEvent[] {
  if (!Array.isArray(body)) return [];
  const out: PriceEvent[] = [];
  for (const item of body) {
    const r = asRecord(item);
    const shop = asRecord(r?.shop);
    const deal = asRecord(r?.deal);
    const changedAt = asString(r?.timestamp);
    const shopId = toInt(shop?.id);
    const priceCents = money(deal?.price);
    if (!r || !changedAt || shopId === null || priceCents === null || Number.isNaN(Date.parse(changedAt))) continue;
    out.push({
      shopId,
      shopName: (asString(shop?.name) ?? `shop-${shopId}`).slice(0, 80),
      changedAt,
      priceCents,
      regularCents: money(deal?.regular),
      cut: typeof deal?.cut === "number" ? deal.cut : null,
    });
  }
  return out.sort((a, b) => Date.parse(a.changedAt) - Date.parse(b.changedAt));
}

export function parseShops(body: unknown): ItadShop[] {
  if (!Array.isArray(body)) return [];
  const out: ItadShop[] = [];
  for (const item of body) {
    const r = asRecord(item);
    const id = toInt(r?.id);
    const title = asString(r?.title);
    if (!r || id === null || !title) continue;
    out.push({
      id,
      title: title.slice(0, 80),
      deals: toInt(r.deals),
      games: toInt(r.games),
      updatedAt: asString(r.update),
    });
  }
  return out;
}

/** ITAD rejected JS toISOString() (milliseconds + Z). It accepts second precision + offset. */
export function formatSince(d: Date): string {
  return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ───────────── client ─────────────

export class ItadClient {
  private http: HttpClient;
  private apiKey: string;
  private country: string;

  constructor(http: HttpClient, apiKey: string, country = "US") {
    this.http = http;
    this.apiKey = apiKey;
    this.country = country;
  }

  private headers(): Record<string, string> {
    return { "ITAD-API-Key": this.apiKey };
  }

  async lookupBySteamAppId(appid: number): Promise<ItadGame | null> {
    const url = `${BASE}/games/lookup/v1?appid=${encodeURIComponent(String(appid))}`;
    return parseLookup(await this.http.getJson(url, { headers: this.headers() }));
  }

  async overview(ids: string[]): Promise<Map<string, Overview>> {
    const out = new Map<string, Overview>();
    for (const batch of chunk(ids, ITAD_MAX_BATCH)) {
      const url = `${BASE}/games/overview/v2?country=${this.country}`;
      const body = await this.http.getJson(url, { method: "POST", headers: this.headers(), body: batch });
      for (const [k, v] of parseOverview(body)) out.set(k, v);
    }
    return out;
  }

  async historyLow(ids: string[]): Promise<Map<string, HistoryLow>> {
    const out = new Map<string, HistoryLow>();
    for (const batch of chunk(ids, ITAD_MAX_BATCH)) {
      const url = `${BASE}/games/historylow/v1?country=${this.country}`;
      const body = await this.http.getJson(url, { method: "POST", headers: this.headers(), body: batch });
      for (const [k, v] of parseHistoryLow(body)) out.set(k, v);
    }
    return out;
  }

  /** One game's price-change log since `since` (default window on ITAD's side is short). */
  async history(id: string, since: Date): Promise<PriceEvent[]> {
    const q = new URLSearchParams({ id, country: this.country, since: formatSince(since) });
    const url = `${BASE}/games/history/v2?${q.toString()}`; // URLSearchParams encodes '+' as %2B
    return parseHistory(await this.http.getJson(url, { headers: this.headers() }));
  }

  /** Raw only: the positive (Game Pass) response shape has not been observed yet. */
  async subsRaw(ids: string[]): Promise<unknown> {
    const url = `${BASE}/games/subs/v1?country=${this.country}`;
    return this.http.getJson(url, { method: "POST", headers: this.headers(), body: ids });
  }

  async shops(): Promise<ItadShop[]> {
    const url = `${BASE}/service/shops/v1?country=${this.country}`;
    return parseShops(await this.http.getJson(url, { headers: this.headers() }));
  }
}
