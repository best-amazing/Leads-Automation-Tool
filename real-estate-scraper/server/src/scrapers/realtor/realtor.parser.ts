// src/scrapers/realtor/realtor.parser.ts
//
// ── Response shape ────────────────────────────────────────────────────────────
//
// All data now comes from the Realtor.com internal GraphQL API
// (POST /api/v1/hulk) rather than __NEXT_DATA__ SSR HTML.
//
// Search response envelope:
//   {
//     "data": {
//       "home_search": {
//         "count": 42,
//         "total": 387,
//         "results": [ ...properties ]
//       }
//     }
//   }
//
// Property shape (one item inside results[]):
//   {
//     "property_id":  "1234567890",
//     "list_price":   249000,
//     "list_date":    "2024-04-10",
//     "status":       "for_sale",
//     "permalink":    "123-Main-St_Columbus_OH_43215_M12345-67890",
//     "price_reduced_amount": null,
//     "flags":        { "is_price_reduced": false, "is_new_listing": true },
//     "location": {
//       "address": {
//         "line":        "123 Main St",
//         "city":        "Columbus",
//         "state_code":  "OH",
//         "postal_code": "43215",
//         "coordinate":  { "lat": 39.96, "lon": -82.99 }
//       }
//     },
//     "description": {
//       "beds": 3, "baths_consolidated": 2, "sqft": 1400,
//       "lot_sqft": 6000, "year_built": 1985, "type": "single_family",
//       "text": "..."
//     },
//     "primary_photo": { "href": "https://..." },
//     "agents":  [{ "full_name": "Jane Smith", "phones": [{"number":"614-555-1234"}] }],
//     "estimates": { "estimate": 262000, "estimate_high": 278000, "estimate_low": 246000 }
//   }
//
// Detail response envelope (for estimate fetching):
//   {
//     "data": {
//       "property": {
//         "property_id": "1234567890",
//         "estimates": {
//           "estimate": 262000,
//           "estimate_high": 278000,
//           "estimate_low": 246000,
//           "provider_url": "https://..."
//         }
//       }
//     }
//   }
//
// ── Debugging ─────────────────────────────────────────────────────────────────
//
// The scraper saves raw API responses to:
//   logs/realtor_api_<market>_p1.json   ← first DEBUG_PAGES pages
//
// If field paths below stop matching, inspect those files and update the
// accessors in buildListing() and parseRealtorGraphQL().
//

import { RawListing, PropertyType } from "../../types/listing";
import { logger }                   from "../../utils/logger";

// ── Constants ─────────────────────────────────────────────────────────────────

export const MAX_DAYS_OLD     = 30;
export const RESULTS_PER_PAGE = 42;

// ── Shared types ──────────────────────────────────────────────────────────────

export interface RealtorEstimate {
  estimate:      number;
  estimateHigh?: number;
  estimateLow?:  number;
  provider?:     string;
}

export interface ParsedPage {
  listings: RawListing[];
  total:    number;    // total results from API (for pagination planning)
  hasMore:  boolean;
}

// ── Pure helpers ──────────────────────────────────────────────────────────────

export function toPropertyType(raw: string | undefined): PropertyType {
  if (!raw) return "single_family";
  const t = raw.toLowerCase();
  if (t.includes("single"))                           return "single_family";
  if (t.includes("multi"))                            return "multi_family";
  if (t.includes("duplex"))                           return "duplex";
  if (t.includes("condo"))                            return "condo";
  if (t.includes("townhouse") || t.includes("town")) return "townhouse";
  return "single_family";
}

export function daysSince(dateStr: string | undefined | null): number | undefined {
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
  permalink:  string | undefined,
  propertyId: string
): string {
  if (permalink) {
    return `https://www.realtor.com/realestateandhomes-detail/${permalink}`;
  }
  return `https://www.realtor.com/realestateandhomes-detail/${propertyId}`;
}

// ── Estimate helpers ──────────────────────────────────────────────────────────

/**
 * Extracts a RealtorEstimate from a known estimate block object.
 * Handles both the GraphQL shape and older REST shapes.
 */
export function extractFromEstimateBlock(
  block:   any,
  address: string
): RealtorEstimate | null {
  if (!block || typeof block !== "object") return null;

  // GraphQL shape: { estimate, estimate_high, estimate_low, provider_url }
  // REST shape:    { estimate, estimateHigh, estimateLow, provider }
  const raw =
    block.estimate        ??
    block.estimated_value ??
    block.avm_value       ??
    null;

  const value = typeof raw === "number" && raw > 10_000 ? raw : null;
  if (!value) return null;

  const result: RealtorEstimate = { estimate: value };

  const hi = block.estimate_high ?? block.estimateHigh ?? block.high ?? block.upper;
  const lo = block.estimate_low  ?? block.estimateLow  ?? block.low  ?? block.lower;
  if (typeof hi === "number" && hi > 10_000) result.estimateHigh = hi;
  if (typeof lo === "number" && lo > 10_000) result.estimateLow  = lo;

  const provider = block.provider_url ?? block.provider ?? block.source;
  if (typeof provider === "string") result.provider = provider;

  logger.debug(
    `[realtor-parser] estimate for "${address}": ` +
    `$${value.toLocaleString()}` +
    (result.estimateLow  ? ` lo=$${result.estimateLow.toLocaleString()}`  : "") +
    (result.estimateHigh ? ` hi=$${result.estimateHigh.toLocaleString()}` : "")
  );

  return result;
}

/**
 * Deep-scans a JSON tree (max depth 8) for any key named "estimate",
 * "estimated_value", or "avm_value" with a numeric value > $10k.
 * Last-resort fallback when no known path yields a result.
 */
function deepFindEstimate(node: any, depth = 0): number | null {
  if (depth > 8 || node === null || typeof node !== "object") return null;

  for (const key of ["estimate", "estimated_value", "avm_value"]) {
    if (key in node && typeof node[key] === "number" && node[key] > 10_000) {
      return node[key] as number;
    }
  }

  for (const k of Object.keys(node)) {
    const found = deepFindEstimate(node[k], depth + 1);
    if (found !== null) return found;
  }

  return null;
}

// ── Core listing builder ──────────────────────────────────────────────────────

function buildListing(item: any): RawListing | null {
  const propertyId: string | undefined =
    item?.property_id ?? item?.propertyId ?? item?.id;
  if (!propertyId) return null;

  // ── Address ───────────────────────────────────────────────────────────────
  // GraphQL shape: item.location.address.{ line, city, state_code, postal_code }
  const addr       = item?.location?.address ?? item?.address ?? {};
  const streetLine = (addr.line ?? addr.street ?? addr.line1 ?? "").trim();
  const city       = (addr.city ?? "").trim();
  const stateCode  = (addr.state_code ?? addr.state ?? "").trim();
  const postalCode = (addr.postal_code ?? addr.zip ?? addr.zipcode ?? "").trim();
  const fullAddress = [streetLine, city, stateCode, postalCode]
    .filter(Boolean)
    .join(", ");

  const coord = addr.coordinate ?? {};
  const lat: number | undefined =
    typeof coord.lat === "number" ? coord.lat :
    typeof coord.lat === "string" ? parseFloat(coord.lat) || undefined :
    undefined;
  const lng: number | undefined =
    typeof coord.lon === "number" ? coord.lon :
    typeof coord.lon === "string" ? parseFloat(coord.lon) || undefined :
    typeof coord.lng === "number" ? coord.lng :
    undefined;

  // ── Price ─────────────────────────────────────────────────────────────────
  const rawPrice   = item?.list_price ?? item?.price ?? item?.listing_price;
  const price: number | undefined =
    typeof rawPrice === "number" && rawPrice > 0 ? rawPrice : undefined;

  // ── Dates ─────────────────────────────────────────────────────────────────
  const listDate = item?.list_date ?? item?.listing_date ?? item?.listed_date ?? null;
  const daysOld  = daysSince(listDate);

  // ── Property details ──────────────────────────────────────────────────────
  // GraphQL nests these under "description"
  const desc = item?.description ?? {};

  const beds: number | undefined =
    typeof desc.beds      === "number" ? desc.beds      :
    typeof item.beds      === "number" ? item.beds      :
    typeof desc.bedrooms  === "number" ? desc.bedrooms  :
    undefined;

  // baths_consolidated = full + half*0.5, provided by the API
  const baths: number | undefined =
    typeof desc.baths_consolidated === "number" ? desc.baths_consolidated :
    (typeof desc.baths_full === "number" || typeof desc.baths_half === "number")
      ? (desc.baths_full ?? 0) + (desc.baths_half ?? 0) * 0.5
      : typeof desc.baths === "number" ? desc.baths
      : undefined;

  const sqft: number | undefined =
    typeof desc.sqft         === "number" ? desc.sqft        :
    typeof desc.square_feet  === "number" ? desc.square_feet :
    typeof item.sqft         === "number" ? item.sqft        :
    undefined;

  const lotSqft: number | undefined =
    typeof desc.lot_sqft  === "number" ? desc.lot_sqft  :
    typeof desc.lot_size  === "number" ? desc.lot_size  :
    typeof item.lot_sqft  === "number" ? item.lot_sqft  :
    undefined;

  const yearBuilt: number | undefined =
    typeof desc.year_built === "number" ? desc.year_built :
    typeof item.year_built === "number" ? item.year_built :
    undefined;

  // ── Media / contact ───────────────────────────────────────────────────────
  const imgSrc =
    item?.primary_photo?.href ??
    item?.photos?.[0]?.href   ??
    item?.thumbnail            ??
    undefined;

  const agent      = item?.agents?.[0] ?? item?.agent ?? item?.listing_agent;
  const ownerName  =
    agent?.full_name              ??
    agent?.name                   ??
    item?.branding?.[0]?.name     ??
    undefined;
  const ownerPhone =
    agent?.phones?.[0]?.number ??
    agent?.phone               ??
    undefined;

  // ── Inline estimate (sometimes returned in search results) ────────────────
  const inlineEst = extractFromEstimateBlock(
    item?.estimates ?? item?.avm,
    fullAddress || propertyId
  );

  // ── Build listing ─────────────────────────────────────────────────────────
  const listing: RawListing & {
    _realtorPropertyId?: string;
    zestimate?:          number;
    zestimateLow?:       number;
    zestimateHigh?:      number;
    estimateSource?:     string;
  } = {
    url:          buildListingUrl(item?.permalink, propertyId),
    source:       "realtor",
    title:        streetLine || fullAddress,
    address:      fullAddress || undefined,
    price,
    beds,
    baths,
    sqft,
    lotSqft,
    yearBuilt,
    lat,
    lng,
    propertyType: toPropertyType(desc.type ?? item?.property_type),
    imgSrc,
    ownerName,
    ownerPhone,
    status:       item?.status ?? "for_sale",
    daysOnMarket: typeof daysOld === "number" ? daysOld : undefined,
    priceReduced: !!(
      item?.price_reduced_amount            ||
      item?.list_price_last_change_amount   ||
      item?.flags?.is_price_reduced
    ),
    listedAt:     listDate ? new Date(listDate) : undefined,
    description:  desc.text ?? "",
    zestimate:    inlineEst?.estimate,
    zestimateLow:  inlineEst?.estimateLow,
    zestimateHigh: inlineEst?.estimateHigh,
    estimateSource: inlineEst ? (inlineEst.provider ?? "realtor") : undefined,
    _realtorPropertyId: propertyId,
  };

  return listing;
}

// ── Search-results parser (GraphQL) ──────────────────────────────────────────

export function parseRealtorGraphQL(
  apiResponse:     any,
  applyDateFilter: boolean = true
): ParsedPage {
  // Unwrap the GraphQL envelope
  const homeSearch = apiResponse?.data?.home_search ?? apiResponse?.home_search ?? {};
  const raw: any[] = homeSearch?.results ?? [];
  const total: number = homeSearch?.total ?? homeSearch?.count ?? raw.length;

  if (raw.length === 0) {
    logger.debug(
      "[realtor-parser] No results in GraphQL response. " +
      `Envelope keys: ${Object.keys(apiResponse?.data ?? apiResponse ?? {}).join(", ")}`
    );
    return { listings: [], total: 0, hasMore: false };
  }

  logger.debug(
    `[realtor-parser] ${raw.length} raw items | total=${total} | ` +
    `first item keys: ${Object.keys(raw[0] ?? {}).join(", ")}`
  );

  const listings: RawListing[] = [];
  let staleCount = 0;

  for (const item of raw) {
    const listing = buildListing(item);
    if (!listing) continue;

    if (
      applyDateFilter &&
      typeof listing.daysOnMarket === "number" &&
      listing.daysOnMarket > MAX_DAYS_OLD
    ) {
      staleCount++;
      logger.debug(`[realtor-parser] stale (${listing.daysOnMarket}d): ${listing.address}`);
      continue;
    }

    listings.push(listing);

    logger.debug(
      `[realtor-parser] ✓ ${listing.address} | ` +
      `$${listing.price?.toLocaleString() ?? "?"} | ` +
      `${listing.beds ?? "?"}bd/${listing.baths ?? "?"}ba | ` +
      ((listing as any).zestimate
        ? `est $${((listing as any).zestimate as number).toLocaleString()}`
        : "no inline est")
    );
  }

  const hasMore = raw.length >= RESULTS_PER_PAGE;

  logger.info(
    `[realtor-parser] ${listings.length} valid | ${staleCount} stale | ` +
    `total=${total} | hasMore=${hasMore}`
  );

  return { listings, total, hasMore };
}

// ── Detail-page estimate parser (GraphQL) ─────────────────────────────────────

export function parseRealtorDetailGraphQL(
  apiResponse: any,
  address:     string
): RealtorEstimate | null {
  if (!apiResponse) return null;

  // GraphQL detail shape: data.property.estimates
  const candidates: any[] = [
    apiResponse?.data?.property?.estimates,
    apiResponse?.data?.home?.estimates,
    apiResponse?.data?.estimates,
    apiResponse?.property?.estimates,
    apiResponse?.estimates,
  ];

  for (const block of candidates) {
    const result = extractFromEstimateBlock(block, address);
    if (result) return result;
  }

  // Deep-scan fallback
  const found = deepFindEstimate(apiResponse);
  if (found) {
    logger.debug(
      `[realtor-parser] estimate for "${address}" via deep scan: ` +
      `$${found.toLocaleString()}`
    );
    return { estimate: found };
  }

  logger.debug(`[realtor-parser] no estimate found for "${address}"`);
  return null;
}

// ── Legacy exports (kept for backward compatibility) ─────────────────────────
//
// These are no longer called by the scraper but are preserved so any other
// callers that import them continue to compile without changes.

export interface ParsedPageLegacy {
  listings:        RawListing[];
  allStale:        boolean;
  totalPages:      number;
  totalProperties: number;
}

export interface RealtorEstimateLegacy extends RealtorEstimate {}

export function extractEstimateFromDetailNextData(
  nextData: any,
  address:  string
): RealtorEstimate | null {
  const candidates: any[] = [
    nextData?.props?.pageProps?.property?.estimates,
    nextData?.props?.pageProps?.propertyDetails?.estimates,
    nextData?.props?.pageProps?.initialReduxState?.propertyDetails
      ?.currentListing?.estimates,
  ];
  for (const block of candidates) {
    const result = extractFromEstimateBlock(block, address);
    if (result) return result;
  }
  const found = deepFindEstimate(nextData);
  return found ? { estimate: found } : null;
}

export function extractEstimateFromPropertyDetail(
  detail:  any,
  address: string
): RealtorEstimate | null {
  return parseRealtorDetailGraphQL(detail, address);
}

export function parseRealtorResults(
  nextData:        any,
  applyDateFilter: boolean = true
): ParsedPageLegacy {
  const pageProps         = nextData?.props?.pageProps ?? {};
  const totalProperties   = pageProps.totalProperties ?? 0;
  const totalPages: number =
    pageProps.totalPages ??
    (totalProperties > 0 ? Math.ceil(totalProperties / RESULTS_PER_PAGE) : 1);

  let raw: any[] = [];
  if (Array.isArray(pageProps.properties)) {
    raw = pageProps.properties;
  } else if (pageProps.properties && typeof pageProps.properties === "object") {
    const inner = (pageProps.properties as any).results ?? (pageProps.properties as any).listings;
    if (Array.isArray(inner)) raw = inner;
  }

  if (raw.length === 0) {
    return { listings: [], allStale: true, totalPages, totalProperties };
  }

  const listings: RawListing[] = [];
  let staleCount = 0;

  for (const item of raw) {
    const listing = buildListing(item);
    if (!listing) continue;
    if (
      applyDateFilter &&
      typeof listing.daysOnMarket === "number" &&
      listing.daysOnMarket > MAX_DAYS_OLD
    ) {
      staleCount++;
      continue;
    }
    listings.push(listing);
  }

  const itemsWithDate = raw.filter(
    (i: any) => i?.list_date ?? i?.last_update_date
  ).length;
  const allStale = itemsWithDate > 0 && staleCount >= itemsWithDate;

  return { listings, allStale, totalPages, totalProperties };
}

export function parseRealtorApiResults(
  apiResponse:     any,
  marketName:      string,
  applyDateFilter: boolean = true
): { listings: RawListing[]; allStale: boolean; total: number } {
  const { listings, total, hasMore } = parseRealtorGraphQL(apiResponse, applyDateFilter);
  const allStale = listings.length === 0 && total === 0;
  return { listings, allStale, total };
}