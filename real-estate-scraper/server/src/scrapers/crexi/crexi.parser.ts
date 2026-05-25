// src/scrapers/crexi/crexi.parser.ts
// ─────────────────────────────────────────────────────────────────────────────
// Three-path parser for Crexi search results:
//
// PATH A — Intercepted API JSON
//   Crexi's Angular app fetches from api.crexi.com. When the scraper intercepts
//   these XHR responses the JSON is passed here as `nextData`. The tree-walker
//   finds the listings array and maps it to RawListing objects.
//
//   Known Crexi API shapes (newest first):
//     { data: { assets: [ { id, name, askingPrice, locations: [{ city, stateCode }] } ] } }
//     { data: { assets: [ { id, name, askingPrice, address: { city, stateCode } } ] } }
//     { assets: [ ... ] }
//     { results: [ ... ] }
//
//   ⚠  IMPORTANT: Crexi's API has changed over time. Location data may appear as:
//        (a) r.locations[0].city / r.locations[0].stateCode   ← current shape
//        (b) r.address.city / r.address.stateCode             ← older nested shape
//        (c) r.city / r.stateCode                             ← legacy flat shape
//      The parser normalises all known shapes into flat city/state strings.
//
// PATH B — __NEXT_DATA__ JSON (not applicable — Crexi is Angular, not Next.js)
//   Kept for future compatibility but will always return empty in practice.
//
// PATH C — HTML / cheerio using Crexi's Angular custom elements.
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

// ── Nested address shape returned by api.crexi.com ────────────────────────

interface CrxAddress {
  street?:        string;
  streetAddress?: string;
  address1?:      string;
  address2?:      string;
  city?:          string;
  cityName?:      string;
  state?:         string;
  stateCode?:     string;
  stateName?:     string;
  zip?:           string;
  zipCode?:       string;
  postalCode?:    string;
  county?:        string;
  country?:       string;
}

// ── Location entry in the `locations` array (current API shape) ───────────

interface CrxLocation {
  city?:          string;
  cityName?:      string;
  state?:         string;
  stateCode?:     string;
  stateName?:     string;
  street?:        string;
  streetAddress?: string;
  address1?:      string;
  zip?:           string;
  zipCode?:       string;
  postalCode?:    string;
  latitude?:      number;
  longitude?:     number;
  county?:        string;
  country?:       string;
  fullAddress?:   string;
}

// ── Raw asset shape from api.crexi.com/assets/search ──────────────────────

interface CrxRaw {
  // Identity
  id?:            string | number;
  name?:          string;
  title?:         string;
  slug?:          string;
  urlSlug?:       string;   // Crexi uses urlSlug, not slug
  url?:           string;

  // Location — current API shape: array of location objects
  locations?:     CrxLocation[];

  // Location — legacy flat fields
  address?:       string | CrxAddress;
  city?:          string;
  cityName?:      string;
  state?:         string;
  stateCode?:     string;
  stateName?:     string;
  zip?:           string;
  postalCode?:    string;
  latitude?:      number;
  longitude?:     number;

  // Financials
  askingPrice?:   number;
  price?:         number;
  listPrice?:     number;
  capRate?:       number;
  noi?:           number;
  noiAnnual?:     number;
  netOperatingIncome?: number;
  grossRevenue?:  number;

  // Property type
  propertyType?:  string;
  type?:          string;
  types?:         string[];  // Crexi often sends an array of type strings
  assetType?:     string;
  listingType?:   string;
  assetClass?:    string;
  category?:      string;

  // Size
  squareFeet?:          number;
  squareFootage?:       number;   // Crexi field name variant
  sqft?:                number;
  buildingSize?:        number;
  buildingSquareFeet?:  number;
  totalSquareFeet?:     number;
  lotSize?:             number;
  lotSqft?:             number;
  lotSizeAcres?:        number;

  // Unit counts
  units?:         number;
  unitCount?:     number;
  totalUnits?:    number;
  bedrooms?:      number;
  bathrooms?:     number;
  yearBuilt?:     number;

  // Text
  description?:   string;
  summary?:       string;
  teaser?:        string;

  // Broker
  brokerName?:    string;
  brokerPhone?:   string;
  brokerageName?: string;

  // Status / meta
  status?:        string;
  isNew?:         boolean;
  activatedOn?:   string;
  updatedOn?:     string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function normalisePropertyType(raw: string | undefined): PropertyType {
  if (!raw) return "unknown";
  const t = raw.toLowerCase();
  if (t.includes("single") || t.includes("sfr") || t.includes("sfh"))                     return "single_family";
  if (t.includes("duplex"))                                                                 return "duplex";
  if (t.includes("multi") || t.includes("apartment") || t.includes("residential income")) return "multi_family";
  if (t.includes("condo"))                                                                  return "condo";
  if (t.includes("town"))                                                                   return "townhouse";
  return "unknown";
}

function normalisePropertyTypeFromDescription(desc: string): PropertyType {
  const d = desc.toLowerCase();
  if (/single.?family|sfh|sfr|\bsf\b/.test(d))                        return "single_family";
  if (/\bduplex\b/.test(d))                                             return "duplex";
  if (/multi.?family|multifamily|apartment|\bunit[s]?\b/.test(d))      return "multi_family";
  if (/\bcondo\b/.test(d))                                              return "condo";
  if (/townhouse|town.?home/.test(d))                                   return "townhouse";
  return "unknown";
}

/**
 * Safely coerce a value to a plain string, returning undefined if it is
 * an object, null, or otherwise not a usable string.
 * This prevents "[object Object]" from leaking into address fields.
 */
function safeStr(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val === "string") return val.trim() || undefined;
  if (typeof val === "number") return String(val);
  // Explicitly reject plain objects / arrays
  return undefined;
}

/**
 * Extract flat city + state strings from a CrxRaw record.
 * Priority order (highest fidelity first):
 *   1. r.locations[0]          — current Crexi API shape
 *   2. r.address (object)      — older nested shape
 *   3. r.city / r.stateCode    — legacy flat fields
*/

function extractCityState(r: CrxRaw): { city: string | undefined; state: string | undefined } {
  // ── 1. locations array (current API shape) ──────────────────────────────
  if (Array.isArray(r.locations) && r.locations.length > 0) {
    const loc = r.locations[0];
    const city  = safeStr(loc.city)  ?? safeStr(loc.cityName);
    const state = safeStr(loc.stateCode) ?? safeStr(loc.state) ?? safeStr(loc.stateName);
    if (city || state) return { city, state };
  }

  // ── 2. nested address object ─────────────────────────────────────────────
  if (r.address && typeof r.address === "object") {
    const a = r.address as CrxAddress;
    const city  = safeStr(a.city)      ?? safeStr(a.cityName);
    const state = safeStr(a.stateCode) ?? safeStr(a.state) ?? safeStr(a.stateName);
    if (city || state) return { city, state };
  }

  // ── 3. legacy flat fields ────────────────────────────────────────────────
  return {
    city:  safeStr(r.city)      ?? safeStr(r.cityName),
    state: safeStr(r.stateCode) ?? safeStr(r.state) ?? safeStr(r.stateName),
  };
}

/**
 * Build a human-readable address string.
 * Priority order mirrors extractCityState — newest API shape first.
*/

function buildAddress(r: CrxRaw): string | undefined {
  // ── 1. locations array ───────────────────────────────────────────────────
  if (Array.isArray(r.locations) && r.locations.length > 0) {
    const loc = r.locations[0];

    // Some location objects carry a pre-built fullAddress string
    const full = safeStr(loc.fullAddress);
    if (full) return full;

    const parts = [
      safeStr(loc.street) ?? safeStr(loc.streetAddress) ?? safeStr(loc.address1),
      safeStr(loc.city)   ?? safeStr(loc.cityName),
      safeStr(loc.stateCode) ?? safeStr(loc.state) ?? safeStr(loc.stateName),
      safeStr(loc.zip)    ?? safeStr(loc.zipCode) ?? safeStr(loc.postalCode),
    ].filter((p): p is string => p !== undefined);
    if (parts.length > 0) return parts.join(", ");
  }

  // ── 2. nested address object ─────────────────────────────────────────────
  if (r.address && typeof r.address === "object") {
    const a = r.address as CrxAddress;
    const parts = [
      safeStr(a.street) ?? safeStr(a.streetAddress) ?? safeStr(a.address1),
      safeStr(a.city)   ?? safeStr(a.cityName)   ?? safeStr(r.city)   ?? safeStr(r.cityName),
      safeStr(a.stateCode) ?? safeStr(a.state) ?? safeStr(a.stateName)
        ?? safeStr(r.stateCode) ?? safeStr(r.state) ?? safeStr(r.stateName),
      safeStr(a.zip) ?? safeStr(a.zipCode) ?? safeStr(a.postalCode)
        ?? safeStr(r.zip) ?? safeStr(r.postalCode),
    ].filter((p): p is string => p !== undefined);
    if (parts.length > 0) return parts.join(", ");
  }

  // ── 3. flat string / flat fields fallback ────────────────────────────────
  const { city, state } = extractCityState(r);
  const parts = [
    typeof r.address === "string" ? safeStr(r.address) : undefined,
    city,
    state,
    safeStr(r.zip) ?? safeStr(r.postalCode),
  ].filter((p): p is string => p !== undefined);
  return parts.length > 0 ? parts.join(", ") : undefined;
}

/**
 * Build the canonical URL for a listing.
 * Crexi uses `urlSlug` (not `slug`) in its current API responses.
 * URL format: https://www.crexi.com/properties/{id}/{slug}
*/

function buildUrl(r: CrxRaw, fallback: string): string {
  if (r.url && r.url.startsWith("http")) return r.url;
  // urlSlug is the current field name; slug kept as legacy fallback
  const slug = safeStr(r.urlSlug) ?? safeStr(r.slug);
  const id = r.id ? String(r.id) : undefined;
  
  // Preferred: include both ID and slug for full URL
  if (id && slug) return `https://www.crexi.com/properties/${id}/${slug}`;
  // Fallback: ID only
  if (id) return `https://www.crexi.com/properties/${id}`;
  // Last resort: slug only (legacy)
  if (slug) return `https://www.crexi.com/properties/${slug}`;
  return fallback;
}

/**
 * Resolve the property type.
 * `types` is an array in the current API (e.g. ["Multifamily", "Apartment"]).
 * Falls back to scalar fields, then description heuristics.
*/

function resolvePropertyType(r: CrxRaw): PropertyType {
  // Current API sends types as an array
  if (Array.isArray(r.types) && r.types.length > 0) {
    const result = normalisePropertyType(r.types[0]);
    if (result !== "unknown") return result;
    // Try remaining entries before giving up
    for (const t of r.types.slice(1)) {
      const r2 = normalisePropertyType(t);
      if (r2 !== "unknown") return r2;
    }
  }

  const typeRaw = safeStr(r.propertyType) ?? safeStr(r.type) ?? safeStr(r.assetType)
               ?? safeStr(r.listingType)  ?? safeStr(r.assetClass) ?? safeStr(r.category);
  if (typeRaw) {
    const result = normalisePropertyType(typeRaw);
    if (result !== "unknown") return result;
  }

  return normalisePropertyTypeFromDescription(
    safeStr(r.description) ?? safeStr(r.summary) ?? safeStr(r.teaser) ?? ""
  );
}

function rawToListing(r: CrxRaw, sourceUrl: string, source: string): RawListing | null {
  const price = r.askingPrice ?? r.price ?? r.listPrice ?? undefined;
  const sqft  = r.squareFeet  ?? r.squareFootage ?? r.sqft
             ?? r.buildingSize ?? r.buildingSquareFeet ?? r.totalSquareFeet ?? undefined;

  const { city, state } = extractCityState(r);
  const address  = buildAddress(r);
  const location = [city, state].filter(Boolean).join(", ") || address;

  const propType = resolvePropertyType(r);

  const title = safeStr(r.name) ?? safeStr(r.title)
             ?? (safeStr(r.description) ?? "").slice(0, 100);
  const url   = buildUrl(r, sourceUrl);

  // Require at least a price OR an address to emit a listing
  if (!price && !address) return null;

  return {
    url,
    source,
    title:        (title ?? "").replace(/\s+/g, " ").trim().slice(0, 200),
    price,
    address,
    location,
    propertyType: propType,
    bedrooms:     r.bedrooms,
    bathrooms:    r.bathrooms,
    squareFeet:   sqft ? Math.round(sqft) : undefined,
    description:  safeStr(r.description) ?? safeStr(r.summary) ?? safeStr(r.teaser) ?? "",
    ownerName:    safeStr(r.brokerName),
    ownerPhone:   safeStr(r.brokerPhone),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// JSON tree-walker — finds a listings array anywhere in the JSON tree.
// "assets" is first because that is Crexi's primary API field name.
// ─────────────────────────────────────────────────────────────────────────────

function isListingObject(obj: any): boolean {
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) return false;
  const listingFields = [
    // Financial signals
    "askingPrice", "listPrice", "price",
    // Location signals — current and legacy
    "locations", "address", "city", "cityName", "stateCode",
    // Type / size signals
    "propertyType", "assetType", "squareFeet", "squareFootage",
    // Identity signals
    "urlSlug", "slug", "capRate",
  ];
  return listingFields.some((f) => f in obj);
}

function findListingsArray(node: any, depth = 0): CrxRaw[] | null {
  if (depth > 10 || node === null || typeof node !== "object") return null;

  if (Array.isArray(node)) {
    if (node.length > 0 && isListingObject(node[0])) return node as CrxRaw[];
    for (const item of node) {
      const found = findListingsArray(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  // Check high-priority keys first so we don't accidentally descend into
  // a nested object that happens to contain listing-like data at a wrong level.
  const priorityKeys = [
    "assets",           // Crexi API primary key
    "listings",
    "properties",
    "results",
    "items",
    "searchResults",
    "propertyResults",
    "data",
  ];

  for (const key of priorityKeys) {
    if (key in node) {
      const found = findListingsArray(node[key], depth + 1);
      if (found) return found;
    }
  }

  // Fall through to all other keys
  for (const key of Object.keys(node)) {
    if (priorityKeys.includes(key)) continue;
    const found = findListingsArray(node[key], depth + 1);
    if (found) return found;
  }

  return null;
}

function parseViaJSON(json: any, sourceUrl: string, source: string, label: string): RawListing[] {
  if (!json) return [];

  const rawListings = findListingsArray(json);
  if (!rawListings || rawListings.length === 0) {
    logger.debug(`[crexi-parser] ${label}: JSON present but no listings array found`);
    return [];
  }

  logger.info(`[crexi-parser] ${label}: found ${rawListings.length} raw items`);

  // Debug: log shape of first item to make future API changes easy to spot
  if (rawListings.length > 0) {
    const first = rawListings[0] as any;
    logger.debug(`[crexi-parser] ${label}: first item keys → ${Object.keys(first).join(", ")}`);

    if (Array.isArray(first.locations) && first.locations.length > 0) {
      logger.debug(
        `[crexi-parser] ${label}: locations[0] keys → ${Object.keys(first.locations[0]).join(", ")}`
      );
    } else if (first.address && typeof first.address === "object") {
      logger.debug(
        `[crexi-parser] ${label}: address object keys → ${Object.keys(first.address).join(", ")}`
      );
    }
  }

  const results: RawListing[] = [];
  for (const r of rawListings) {
    const listing = rawToListing(r, sourceUrl, source);
    if (listing) results.push(listing);
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH C — HTML / cheerio
// ─────────────────────────────────────────────────────────────────────────────

function extractPriceFromText(text: string): number | undefined {
  const clean = (text ?? "").trim();
  if (!clean || /unpriced/i.test(clean)) return undefined;

  const m =
    clean.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Mm]\b/) ||
    clean.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Kk]\b/) ||
    clean.match(/\$\s*([\d,]+)/);
  if (!m) return undefined;
  let val      = parseFloat(m[1].replace(/,/g, ""));
  const suffix = m[0][m[0].length - 1]?.toLowerCase();
  if (suffix === "k") val *= 1_000;
  if (suffix === "m") val *= 1_000_000;
  return Math.round(val);
}

function extractSqftFromText(text: string): number | undefined {
  const m = (text ?? "").match(/([\d,]+)\s*(?:sqft|sq\.?\s*ft|sf)\b/i);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : undefined;
}

function parseViaHTML(html: string, sourceUrl: string, source: string): RawListing[] {
  if (
    html.includes("challenges.cloudflare.com") ||
    html.includes("cf-browser-verification") ||
    html.includes("Performing security verification")
  ) {
    logger.warn("[crexi-parser] HTML appears to be a Cloudflare challenge page — skipping parse");
    return [];
  }

  const $ = cheerio.load(html);
  const results: RawListing[] = [];
  const seen = new Set<string>();

  let cards = $("crx-sales-property-tile[id^='search-item-']");
  let selectorUsed = "crx-sales-property-tile[id^='search-item-']";

  if (cards.length === 0) {
    cards = $("cui-card:has(a.cui-card-cover-link)");
    selectorUsed = "cui-card:has(a.cui-card-cover-link)";
  }

  if (cards.length === 0) {
    cards = $("[data-cy='propertyPrice']")
      .map((_, el) => $(el).closest("cui-card, crx-sales-property-tile, article").get(0))
      .filter((_, el) => !!el) as any;
    selectorUsed = "ancestor of [data-cy=propertyPrice]";
  }

  if (cards.length === 0) {
    logger.warn("[crexi-parser] Angular tile selectors missed — collecting property hrefs as stubs");
    $("a[href*='/properties/'][href*='-']").each((_, el) => {
      const rawHref = $(el).attr("href") ?? "";
      if (!rawHref || rawHref === "/" || rawHref.includes("?")) return;
      const url = rawHref.startsWith("http") ? rawHref : `https://www.crexi.com${rawHref}`;
      if (seen.has(url) || url === sourceUrl) return;
      seen.add(url);
      results.push({
        url,
        source,
        title:        rawHref.split("/").pop()?.replace(/-/g, " ") ?? "",
        propertyType: "unknown",
        description:  "",
      });
    });
    logger.info(`[crexi-parser] href stubs: ${results.length}`);
    return results;
  }

  logger.info(`[crexi-parser] HTML fallback: ${cards.length} tiles via "${selectorUsed}"`);

  cards.each((_, el) => {
    const tile = $(el);

    const linkEl  = tile.find("a.cui-card-cover-link").first();
    const rawHref = linkEl.attr("href") ?? "";
    if (!rawHref) return;
    const url = rawHref.startsWith("http") ? rawHref : `https://www.crexi.com${rawHref}`;
    if (seen.has(url)) return;
    seen.add(url);

    const priceText = tile.find("[data-cy='propertyPrice']").first().text().trim();
    const price     = extractPriceFromText(priceText);
    const title     = tile.find("[data-cy='propertyName']").first().text().trim();
    const descText  = tile.find("[data-cy='propertyDescription']").first().text().trim();
    const propType  = normalisePropertyType(descText);

    const addrEl    = tile.find("[data-cy='propertyAddress']").first();
    const citySpan  = addrEl.find("span").first().text().trim();
    const streetRaw = addrEl.clone().find("span").remove().end().text().trim();
    const address   = [streetRaw, citySpan].filter(Boolean).join(", ") || undefined;
    const location  = citySpan || address;
    const sqft      = extractSqftFromText(descText);

    results.push({
      url,
      source,
      title:        (title || rawHref.split("/").pop() || "").replace(/\s+/g, " ").trim().slice(0, 200),
      price,
      address,
      location,
      propertyType: propType,
      squareFeet:   sqft,
      description:  descText,
    });
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug dump
// ─────────────────────────────────────────────────────────────────────────────

function saveParserDebug(pathACount: number, pathBCount: number, pathCCount: number) {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "crexi_parser_debug.txt"),
      [
        `Path A (intercepted API JSON) listings: ${pathACount}`,
        `Path B (__NEXT_DATA__ JSON) listings:   ${pathBCount}`,
        `Path C (HTML cheerio) listings:         ${pathCCount}`,
        `Final count: ${Math.max(pathACount, pathBCount, pathCCount)}`,
      ].join("\n")
    );
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export function parseCrxiListings(
  html: string,
  nextData: any,
  sourceUrl: string,
  source: string
): RawListing[] {
  // Path A: intercepted API JSON — highest fidelity
  const pathAResults = parseViaJSON(nextData, sourceUrl, source, "intercepted API");
  if (pathAResults.length > 0) {
    logger.info(`[crexi-parser] PATH A succeeded: ${pathAResults.length} listings`);
    saveParserDebug(pathAResults.length, 0, 0);
    return pathAResults;
  }

  // Path B: __NEXT_DATA__ JSON (same walker — Crexi is Angular so this is a no-op)
  const pathBResults = parseViaJSON(nextData, sourceUrl, source, "__NEXT_DATA__");
  if (pathBResults.length > 0) {
    logger.info(`[crexi-parser] PATH B succeeded: ${pathBResults.length} listings`);
    saveParserDebug(0, pathBResults.length, 0);
    return pathBResults;
  }

  // Path C: rendered Angular HTML
  if (!html) {
    logger.info("[crexi-parser] No HTML provided and no JSON listings — returning empty");
    saveParserDebug(0, 0, 0);
    return [];
  }

  logger.info("[crexi-parser] Paths A+B empty — falling back to HTML");
  const pathCResults = parseViaHTML(html, sourceUrl, source);
  logger.info(`[crexi-parser] PATH C: ${pathCResults.length} listings`);
  saveParserDebug(0, 0, pathCResults.length);
  return pathCResults;
}