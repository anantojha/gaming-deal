// CheapShark client. Used for the INDEPENDENT SECOND READING and on-demand lookups only:
// never for catalog crawling (their docs warn this can get you permanently blocked).
// Everything arrives as strings; parsers convert to integer cents at the boundary.
// Verified shapes: /games?steamAppID=, /deals, /stores.
// NOT yet verified: /games?id= (deals list). Parsed leniently; run the updated probe to capture it.

import { asRecord, asString, toCents, toInt, toPct } from "../ingest/normalize.ts";
import type { HttpClient } from "./http.ts";

const BASE = "https://www.cheapshark.com/api/1.0";

export interface CsGameSummary {
  gameId: number;
  steamAppId: number | null;
  title: string;
  cheapestCents: number;
  cheapestDealId: string | null;
}

export interface CsDeal {
  storeId: number;
  dealId: string; // keep exactly as returned (already URL-encoded)
  priceCents: number;
  retailCents: number | null;
  savingsPct: number | null;
}

export interface CsGameDetail {
  title: string | null;
  steamAppId: number | null;
  cheapestEverCents: number | null;
  deals: CsDeal[];
}

export interface CsStore {
  storeId: number;
  name: string;
  isActive: boolean;
}

export function parseGameSummary(body: unknown): CsGameSummary | null {
  const first = Array.isArray(body) ? asRecord(body[0]) : null;
  if (!first) return null;
  const gameId = toInt(first.gameID);
  const cheapestCents = toCents(first.cheapest);
  const title = asString(first.external);
  if (gameId === null || cheapestCents === null || !title) return null;
  return {
    gameId,
    steamAppId: toInt(first.steamAppID),
    title: title.slice(0, 200),
    cheapestCents,
    cheapestDealId: asString(first.cheapestDealID),
  };
}

export function parseGameDetail(body: unknown): CsGameDetail | null {
  const r = asRecord(body);
  if (!r) return null;
  const info = asRecord(r.info);
  const dealsRaw = Array.isArray(r.deals) ? r.deals : [];
  const deals: CsDeal[] = [];
  for (const d of dealsRaw) {
    const dr = asRecord(d);
    const storeId = toInt(dr?.storeID);
    const priceCents = toCents(dr?.price);
    const dealId = asString(dr?.dealID);
    if (!dr || storeId === null || priceCents === null || !dealId) continue;
    deals.push({
      storeId,
      dealId,
      priceCents,
      retailCents: toCents(dr.retailPrice),
      savingsPct: toPct(dr.savings),
    });
  }
  return {
    title: asString(info?.title),
    steamAppId: toInt(info?.steamAppID),
    cheapestEverCents: toCents(asRecord(r.cheapestPriceEver)?.price),
    deals,
  };
}

export function parseStores(body: unknown): CsStore[] {
  if (!Array.isArray(body)) return [];
  const out: CsStore[] = [];
  for (const s of body) {
    const r = asRecord(s);
    const storeId = toInt(r?.storeID);
    const name = asString(r?.storeName);
    if (!r || storeId === null || !name) continue;
    out.push({ storeId, name: name.slice(0, 80), isActive: r.isActive === 1 || r.isActive === "1" });
  }
  return out;
}

/** CheapShark's terms require sending users through THEIR redirect links. */
export function redirectUrl(dealId: string): string {
  return `https://www.cheapshark.com/redirect?dealID=${dealId}`; // dealId is already encoded
}

function norm(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Best-effort CheapShark store id → ITAD shop id by name. Unmatched stores are simply absent. */
export function mapStoresByName(
  cs: CsStore[],
  itad: { id: number; title: string }[],
  overrides: Record<number, number> = {},
): Map<number, number> {
  const byName = new Map(itad.map((s) => [norm(s.title), s.id]));
  const out = new Map<number, number>();
  for (const s of cs) {
    const id = overrides[s.storeId] ?? byName.get(norm(s.name));
    if (id !== undefined) out.set(s.storeId, id);
  }
  return out;
}

export class CheapSharkClient {
  private http: HttpClient;

  constructor(http: HttpClient) {
    this.http = http;
  }

  async gameBySteamAppId(appid: number): Promise<CsGameSummary | null> {
    const url = `${BASE}/games?steamAppID=${encodeURIComponent(String(appid))}`;
    return parseGameSummary(await this.http.getJson(url));
  }

  async gameDetail(gameId: number): Promise<CsGameDetail | null> {
    const url = `${BASE}/games?id=${encodeURIComponent(String(gameId))}`;
    return parseGameDetail(await this.http.getJson(url));
  }

  async stores(): Promise<CsStore[]> {
    return parseStores(await this.http.getJson(`${BASE}/stores`));
  }
}
