// src/scrapers/propwire/propwire.parser.ts
//
// ── API shape (confirmed from DevTools network capture) ───────────────────────
//
//   POST https://api.propwire.com/api/property_search
//   Authorization: Bearer <JWT from PROPWIRE_BEARER_TOKEN>
//
//   Request body:
//   {
//     "size": 50,
//     "result_index": 0,       ← pagination offset (0, 50, 100 …)
//     "house": true,
//     "locations": [
//       { "searchType": "C", "state": "OH", "title": "Columbus, OH",
//         "stateName": "Ohio", "city": "Columbus" }
//     ],
//     "lead_type_filters": ["mls_active"],   ← for_sale maps to this
//     "estimated_value": { "max": 300000 }
//   }
//
//   Response:
//   {
//     "request": { "size": 50, "result_index": 0, ... },
//     "response": [
//       {
//         "id": 41019,
//         "address": { "address": "3206 Tampa Ave", "city": "Cleveland",
//                      "state": "OH", "zip": "44109" },
//         "bedrooms": 3,
//         "bathrooms": 1,
//         "building_area_sf": 847,
//         "estimated_value": 63876,
//         "estimated_equity": 15030,
//         "geo_location": { "latitude": "41.432696", "longitude": "-81.704793" },
//         "last_sold_date": "2007-03-30",
//         "last_sold_price": 77000,
//         "lead_type": { "mls_active": false, ... },
//         "days_on_market": null,
//         ...
//       }
//     ]
//   }
//
// ── HOW TO GET THE BEARER TOKEN ───────────────────────────────────────────────
//
//   1. Log into propwire.com in Chrome
//   2. Open DevTools → Network tab → filter by Fetch/XHR
//   3. Perform any search on the site
//   4. Look for a request to api.propwire.com/api/property_search
//   5. Click it → Headers → Authorization: Bearer eyJ...
//   6. Copy the value AFTER "Bearer " and set in .env:
//      PROPWIRE_BEARER_TOKEN=eyJ...
//   Token lasts ~24-72h. When expired you'll see API 401 — grab a fresh one.
//
// ─────────────────────────────────────────────────────────────────────────────

import { RawListing, PropertyType } from "../../types/listing";
import { logger }                   from "../../utils/logger";

export const MAX_DAYS_OLD     = 90;   // off-market props have no list date; be generous
export const RESULTS_PER_PAGE = 50;   // api.propwire.com default page size

// ── Helpers ───────────────────────────────────────────────────────────────────

export function parsePrice(raw: any): number | undefined {
  if (typeof raw === "number" && raw > 0) return Math.round(raw);
  if (typeof raw === "string") {
    const s = raw.replace(/[$,\s]/g, "").toUpperCase();
    if (s.endsWith("K")) return Math.round(parseFloat(s) * 1_000);
    if (s.endsWith("M")) return Math.round(parseFloat(s) * 1_000_000);
    const n = parseInt(s, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return undefined;
}

function toPropertyType(raw: string | undefined): PropertyType {
  if (!raw) return "single_family";
  const t = raw.toUpperCase();
  if (t === "SFR"  || t.includes("SINGLE")) return "single_family";
  if (t === "MFR"  || t.includes("MULTI"))  return "multi_family";
  if (t === "DUPLEX")                        return "duplex";
  if (t === "CONDO")                         return "condo";
  if (t.includes("TOWN"))                    return "townhouse";
  return "single_family";
}

function daysSince(dateStr: string | undefined | null): number | undefined {
  if (!dateStr) return undefined;
  try {
    const ms = Date.now() - new Date(dateStr).getTime();
    const d  = Math.floor(ms / 86_400_000);
    return d >= 0 ? d : undefined;
  } catch {
    return undefined;
  }
}

export function buildListingUrl(
  propertyId: string,
  address:    string,
  city:       string,
  state:      string
): string {
  const addrSlug = address
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-]/g, "");
  return `https://propwire.com/realestate/${addrSlug}/${propertyId}/property-details`;
}

// ── Lead-type helpers ─────────────────────────────────────────────────────────
//
// The API returns lead_type as an object with boolean flags:
//   { "mls_active": true, "preforeclosure": false, ... }
// We collect the truthy keys as an array for storage/display.

function extractLeadTypes(leadTypeObj: any): string[] {
  if (!leadTypeObj || typeof leadTypeObj !== "object") return [];
  if (Array.isArray(leadTypeObj)) return leadTypeObj.filter(Boolean);
  return Object.entries(leadTypeObj)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
}

// ── Main parser ───────────────────────────────────────────────────────────────

export interface PropwireSearchResult {
  listings:   RawListing[];
  allStale:   boolean;
  totalCount: number;
  hasMore:    boolean;   // true if more pages remain
}

export function parsePropwireApiResponse(
  json:            any,
  resultIndex:     number  = 0,
  applyDateFilter: boolean = false   // most Propwire results lack list dates — keep open
): PropwireSearchResult {
  // Confirmed response envelope: { request: {...}, response: [...] }
  const raw: any[] =
    json?.response            ??
    json?.data?.properties    ??
    json?.data?.results       ??
    json?.properties          ??
    (Array.isArray(json?.data) ? json.data : []) ??
    [];

  const requestSize: number = json?.request?.size ?? RESULTS_PER_PAGE;
  const hasMore             = raw.length >= requestSize;   // if we got a full page, assume more exist

  logger.debug(
    `[propwire-parser] raw=${raw.length} resultIndex=${resultIndex} hasMore=${hasMore}`
  );

  if (raw.length === 0) {
    logger.debug(
      "[propwire-parser] No properties in response. Top-level keys: " +
      Object.keys(json ?? {}).join(", ")
    );
    return { listings: [], allStale: false, totalCount: 0, hasMore: false };
  }

  logger.debug(
    `[propwire-parser] First property keys: ${Object.keys(raw[0]).join(", ")}`
  );

  const listings: RawListing[] = [];
  let staleCount = 0;
  let noEstimateCount = 0;

  for (const item of raw) {
    // id is the primary key in the confirmed response shape
    if (!item?.id && !item?.property_id) continue;

    const propertyId = String(item.id ?? item.property_id);

    // ── Address ── confirmed shape: item.address = { address, city, state, zip }
    const addrObj    = item.address ?? {};
    const streetLine = (
      typeof addrObj === "string" ? addrObj :
      addrObj.address ?? addrObj.street_address ?? item.street_address ?? ""
    ).trim();
    const city       = (addrObj.city   ?? item.city  ?? "").trim();
    const state      = (addrObj.state  ?? item.state ?? "").trim();
    const zip        = (addrObj.zip    ?? item.zip   ?? addrObj.postal_code ?? "").trim();
    const fullAddress = [streetLine, city, state, zip].filter(Boolean).join(", ");

    if (!streetLine || !city) {
      logger.debug(`[propwire-parser] Skip ${propertyId}: no address`);
      continue;
    }

    // ── Staleness ─────────────────────────────────────────────────────────
    // Most off-market Propwire results have null days_on_market and no list_date.
    // We use last_sold_date only as a rough proxy; don't filter on it.
    const listDate  = item.list_date ?? item.listing_date ?? null;
    const daysOld   =
      item.days_on_market != null ? Number(item.days_on_market) :
      listDate                    ? daysSince(listDate)         :
      undefined;

    if (applyDateFilter && typeof daysOld === "number" && daysOld > MAX_DAYS_OLD) {
      staleCount++;
      continue;
    }

    // ── Price ─────────────────────────────────────────────────────────────
    // For MLS-active listings, list_price is present.
    // For off-market, we fall back to estimated_value.
    const price          = parsePrice(item.list_price ?? item.listing_price);
    const estimatedValue = parsePrice(item.estimated_value ?? item.estimatedValue ?? item.avm_value);
    const estimatedEquity = parsePrice(item.estimated_equity ?? item.estimatedEquity);

    // ── Geo ───────────────────────────────────────────────────────────────
    // Confirmed shape: geo_location: { latitude: "41.43", longitude: "-81.70" }
    const geo = item.geo_location ?? {};
    const lat: number | undefined =
      typeof geo.latitude  === "number" ? geo.latitude  :
      typeof geo.latitude  === "string" ? parseFloat(geo.latitude)  || undefined :
      typeof item.latitude === "number" ? item.latitude : undefined;
    const lng: number | undefined =
      typeof geo.longitude  === "number" ? geo.longitude  :
      typeof geo.longitude  === "string" ? parseFloat(geo.longitude) || undefined :
      typeof item.longitude === "number" ? item.longitude : undefined;

    // ── Property type ─────────────────────────────────────────────────────
    const propType = toPropertyType(item.property_type ?? item.propertyType);

    // ── Lead types ────────────────────────────────────────────────────────
    const leadTypes = extractLeadTypes(item.lead_type);

    // ── MLS status ────────────────────────────────────────────────────────
    const mlsActive  = item.lead_type?.mls_active  ?? false;
    const mlsPending = item.lead_type?.mls_pending ?? false;
    const status     =
      item.mls_status   ??
      (mlsActive  ? "Active"  :
       mlsPending ? "Pending" :
       leadTypes[0] ?? "off_market");

    // ── Build URL ─────────────────────────────────────────────────────────
    const url = buildListingUrl(propertyId, streetLine, city, state);

    // Handle ownerName — Propwire may return it as string or array
    let ownerName: string | undefined;
    const rawOwnerName = item.owner_name ?? item.ownerName;
    if (Array.isArray(rawOwnerName)) {
      ownerName = rawOwnerName[0] ?? undefined;
    } else if (typeof rawOwnerName === "string") {
      ownerName = rawOwnerName;
    }

    const listing: RawListing = {
      url,
      source:       "propwire",
      title:        streetLine || fullAddress,
      address:      fullAddress,
      price:        price ?? estimatedValue,   // use AVM as fallback price for filtering
      propwireEstimate: estimatedValue,
      estimate: estimatedValue,
      beds:         typeof item.bedrooms  === "number" ? item.bedrooms  : undefined,
      baths:        typeof item.bathrooms === "number" ? item.bathrooms : undefined,
      sqft:         typeof item.building_area_sf === "number" ? item.building_area_sf : undefined,
      propertyType: propType,
      lat,
      lng,
      ownerName,
      ownerPhone:   item.owner_phone ?? undefined,
      status,
      daysOnMarket: typeof daysOld === "number" ? daysOld : undefined,
      yearBuilt:    typeof item.year_built === "number" ? item.year_built : undefined,
      listedAt:     listDate ? new Date(listDate) : undefined,
      description:  leadTypes.join(", "),
    } as RawListing;

    // Extra Propwire-specific fields for downstream use
    (listing as any)._propwireId       = propertyId;
    (listing as any)._estimatedEquity  = estimatedEquity;
    (listing as any)._taxAssessment    = parsePrice(item.tax_assessment);
    (listing as any)._lastSalePrice    = parsePrice(item.last_sold_price ?? item.last_sale_price);
    (listing as any)._lastSaleDate     = item.last_sold_date ?? item.last_sale_date ?? null;
    (listing as any)._openMortgage     = parsePrice(item.open_mortgage_balance);
    (listing as any)._leadTypes        = leadTypes;

    // ── Skip listings without estimates ────────────────────────────────────
    if (!estimatedValue) {
      noEstimateCount++;
      logger.debug(
        `[propwire-parser] Skip ${fullAddress}: no estimate available`
      );
      continue;
    }

    listings.push(listing);

    logger.debug(
      `[propwire-parser] ✓ ${fullAddress} | ` +
      `price=$${(price ?? estimatedValue)?.toLocaleString() ?? "?"} | ` +
      `AVM=$${estimatedValue?.toLocaleString() ?? "?"} | ` +
      `${item.bedrooms ?? "?"}bd/${item.bathrooms ?? "?"}ba | ` +
      `leads=[${leadTypes.join(",")}]`
    );
  }

  const allStale = staleCount > 0 && staleCount >= raw.length;

  logger.info(
    `[propwire-parser] ${listings.length} valid | ${staleCount} stale | ${noEstimateCount} no estimate | hasMore=${hasMore}`
  );

  return { listings, allStale, totalCount: raw.length, hasMore };
}

// ── Token extractor (kept for Inertia XHR / Oxylabs fallback) ────────────────

export function extractPropwireToken(html: string): string | null {
  if (!html || html.length < 500) return null;

  // Method 1: data-page attribute (Inertia.js SPA pattern)
  const dataPagePatterns = [
    /id=["']app["'][^>]+data-page=["']([\s\S]+?)["']\s*>/i,
    /data-page=["']([\s\S]+?)["']\s*(?:id|class|>)/i,
    /data-page='([^']+)'/i,
    /data-page="([^"]+)"/i,
  ];

  for (const pattern of dataPagePatterns) {
    const m = html.match(pattern);
    if (!m?.[1]) continue;
    try {
      let raw = m[1]
        .replace(/&quot;/g, '"').replace(/&amp;/g, "&")
        .replace(/&#039;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
      try { raw = decodeURIComponent(raw); } catch {}
      const parsed = JSON.parse(raw);
      const token  = parsed?.props?.token ?? parsed?.token ?? parsed?.props?.auth?.token ?? null;
      if (token && typeof token === "string" && token.length > 50) {
        logger.info("[propwire-parser] ✓ Token from data-page");
        return token;
      }
    } catch { /* try next */ }
  }

  // Method 2: inline script JWT patterns
  const scriptPatterns = [
    /["']token["']\s*:\s*["'](ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+)["']/,
    /window\._token\s*=\s*["'](ey[A-Za-z0-9_-]{20,})/,
  ];
  for (const p of scriptPatterns) {
    const m = html.match(p);
    if (m?.[1]) { logger.info("[propwire-parser] ✓ Token from inline script"); return m[1]; }
  }

  logger.warn("[propwire-parser] ✗ No token found in HTML");
  logger.debug(`[propwire-parser] HTML length=${html.length} has data-page=${html.includes("data-page")}`);
  return null;
}