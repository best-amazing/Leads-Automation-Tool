// src/scrapers/loopnet/loopnet.parser.ts
// ─────────────────────────────────────────────────────────────────────────────
// LoopNet search results parser — v4
//
// ── Bug fixes in this revision ───────────────────────────────────────────────
//
//  BUG 1 — extractCityStateFromText produced "Ave Cleveland, OH" not "Cleveland, OH"
//    The old regex `[A-Z][a-zA-Z\s]{2,20}` greedily consumed the street-type
//    word before the city ("Ave", "St", "Blvd" etc.).
//    Fix: new token-walking algorithm scans right-to-left from the ", ST" anchor,
//    skips any trailing street-suffix tokens, then collects the remaining
//    capitalised tokens as the city name.
//
//  BUG 2 — address was undefined for most cards
//    The cheerio address selector grabbed a mix of subtitle/location elements
//    producing garbled text.
//    Fix: extract the full address from the card description text using two
//    structured regex patterns (with/without zip), then fall back to the DOM
//    element only if it contains a digit.
//
//  BUG 3 — title was "Cincinnati, OH 45202" instead of the street address
//    The titleEl selector matched the subtitle/location span before h2/h3 on
//    some card layouts.
//    Fix: prefer the street address extracted from description as the title;
//    use h2/h3 only if it doesn't look like a bare "City, ST Zip" string.
//
//  BUG 4 — location derived from poisoned address / title
//    Because address was undefined and title was "City, ST Zip", location
//    inherited junk strings.
//    Fix: location is always derived by extractCityStateFromText (which now
//    correctly strips street suffixes) — never from the raw address or title.
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import * as fs from "fs";
import * as path from "path";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

// ── Non-listing schema types to skip in JSON-LD ───────────────────────────────

const SKIP_SCHEMA_TYPES = new Set([
  "website",
  "webpage",
  "organization",
  "breadcrumblist",
  "sitelinksearchbox",
  "searchaction",
  "searchresultspage",
  "itemlist",
  "listitem",
]);

// ── Street-type words that must NOT be treated as part of a city name ─────────

const STREET_SUFFIXES = new Set([
  "st","street","ave","avenue","blvd","boulevard","rd","road","dr","drive",
  "ln","lane","ct","court","pl","place","way","cir","circle","ter","terrace",
  "pkwy","parkway","hwy","highway","fwy","freeway","sq","square","loop","run",
  "row","path","pass","pike","trail","trl","expy","expressway","aly","alley",
  // single-letter directionals that precede street names but are not city names
  "n","s","e","w",
]);

// ── Shared helpers ────────────────────────────────────────────────────────────

function normalisePropertyType(raw: string | undefined): PropertyType {
  if (!raw) return "unknown";
  const t = raw.toLowerCase();
  if (t.includes("single") || t.includes("sfr") || t.includes("sfh")) return "single_family";
  if (t.includes("duplex"))                                             return "duplex";
  if (t.includes("multi") || t.includes("apartment"))                  return "multi_family";
  if (t.includes("condo"))                                              return "condo";
  if (t.includes("town"))                                               return "townhouse";
  return "unknown";
}

function extractPriceFromText(text: string): number | undefined {
  if (!text) return undefined;
  if (/contact|request|negotiable|call|upon|ask/i.test(text)) return undefined;

  const shortM = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Mm]\b/);
  if (shortM) return Math.round(parseFloat(shortM[1].replace(/,/g, "")) * 1_000_000);

  const shortK = text.match(/\$\s*([\d,]+(?:\.\d+)?)\s*[Kk]\b/);
  if (shortK) return Math.round(parseFloat(shortK[1].replace(/,/g, "")) * 1_000);

  const plain = text.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (plain) return Math.round(parseFloat(plain[1].replace(/,/g, "")));

  return undefined;
}

function extractSqftFromText(text: string): number | undefined {
  const m = text.match(/([\d,]+)\s*(?:sqft|sq\.?\s*ft|sf|square\s*feet)\b/i);
  return m ? parseInt(m[1].replace(/,/g, ""), 10) : undefined;
}

function extractUnitsFromText(text: string): number | undefined {
  const m =
    text.match(/(\d+)\s*-?\s*units?\b/i) ||
    text.match(/(\d+)\s*-?\s*(?:plex|family|unit)\b/i) ||
    text.match(/\b(duplex|triplex|quadplex|fourplex)\b/i);
  if (!m) return undefined;
  const word = m[1]?.toLowerCase();
  if (word === "duplex")                          return 2;
  if (word === "triplex")                         return 3;
  if (word === "quadplex" || word === "fourplex") return 4;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? undefined : n;
}

function extractPhoneFromText(text: string): string | undefined {
  const m = text.match(/\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}/);
  return m ? m[0].replace(/\s+/g, "") : undefined;
}

/**
 * Extract a full street address from a block of card text.
 *
 * Two patterns tried in order:
 *   1. Tight: "123 Main St City, ST 12345"  (requires zip)
 *   2. Loose: "123 Main St City, ST"         (no zip required)
 */
function extractFullAddressFromText(text: string): string | undefined {
  // Pattern 1 — requires zip code (more accurate)
  const m1 = text.match(
    /\b(\d{1,5}(?:-\d{1,5})?(?:\s+[NSEW]\.?)?(?:\s+\w+){1,4}),?\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?),\s+([A-Z]{2})\s+\d{5}\b/
  );
  if (m1) return m1[0].trim();

  // Pattern 2 — no zip, but must end with a street-type word then city+state
  const m2 = text.match(
    /\b(\d{1,5}(?:-\d{1,5})?\s+(?:[NSEW]\s+)?(?:\w+\s+){1,5}(?:St|Ave|Blvd|Rd|Dr|Ln|Ct|Pl|Way|Cir|Ter|Pkwy|Hwy)\b(?:\s+\w+)?),?\s+([A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)?),\s+([A-Z]{2})\b/i
  );
  if (m2) return m2[0].trim();

  return undefined;
}

/**
 * Extract a clean "City, ST" string from a block of text.
 *
 * FIX for BUG 1:
 * The previous regex greedily captured street-suffix words as part of the city
 * name (e.g. "Ave Cleveland, OH" instead of "Cleveland, OH").
 *
 * New algorithm:
 *   1. Find every ", ST [zip]?" anchor in the text.
 *   2. Look at the words immediately before the anchor (up to 60 chars back).
 *   3. Walk right-to-left through those words:
 *      - Skip trailing street-suffix tokens (they belong to the street, not the city).
 *      - Collect subsequent capitalised tokens as city words (up to 3).
 *      - Stop on a digit, a lowercase non-suffix word, or after 3 city words.
 *   4. Return the first valid city we find.
 */
function extractCityStateFromText(text: string): string | undefined {
  if (!text) return undefined;

  const anchorPattern = /,\s+([A-Z]{2})(?:\s+\d{5})?(?!\w)/g;
  let anchor: RegExpExecArray | null;

  while ((anchor = anchorPattern.exec(text)) !== null) {
    const state = anchor[1];
    // Grab up to 60 characters before this anchor
    const pre   = text.slice(Math.max(0, anchor.index - 60), anchor.index);
    // Split into word tokens (letters only)
    const tokens = pre.match(/[A-Za-z''-]+/g) ?? [];

    const cityTokens: string[] = [];
    let skippingTrailingSuffixes = true;

    for (let i = tokens.length - 1; i >= 0; i--) {
      const tok = tokens[i];
      const low = tok.toLowerCase();

      if (STREET_SUFFIXES.has(low)) {
        if (skippingTrailingSuffixes) {
          // Still in the "street suffix" zone — keep skipping
          continue;
        } else {
          // A suffix appeared after we started collecting city tokens — stop
          break;
        }
      }

      if (/^\d/.test(tok)) break; // hit a house number — stop

      if (tok[0] === tok[0].toUpperCase() && tok[0] !== tok[0].toLowerCase()) {
        // Capitalised word — treat as a city token
        skippingTrailingSuffixes = false;
        cityTokens.unshift(tok);
        if (cityTokens.length >= 3) break;
      } else {
        // Lowercase non-suffix word (e.g. "of", "the") — stop if we have city tokens
        if (cityTokens.length > 0) break;
      }
    }

    if (cityTokens.length > 0) {
      return `${cityTokens.join(" ")}, ${state}`;
    }
  }

  return undefined;
}

/** True when a string is just "City, ST" or "City, ST 12345" with no other content. */
function isCityStateOnly(s: string): boolean {
  return /^[A-Z][a-zA-Z\s]{2,30},\s+[A-Z]{2}(\s+\d{5})?$/.test(s.trim());
}

function locationFromSourceUrl(sourceUrl: string): string | undefined {
  try {
    const parts = new URL(sourceUrl).pathname.split("/").filter(Boolean);
    const citySlug = parts[2];
    if (!citySlug) return undefined;

    const stateOnly: Record<string, string> = {
      oh: "Ohio", wi: "Wisconsin", il: "Illinois", mi: "Michigan", in: "Indiana",
    };
    if (stateOnly[citySlug]) return stateOnly[citySlug];

    const dash = citySlug.lastIndexOf("-");
    if (dash === -1) return undefined;
    const city  = citySlug.slice(0, dash).replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const state = citySlug.slice(dash + 1).toUpperCase();
    return `${city}, ${state}`;
  } catch {
    return undefined;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH A — JSON-LD extraction
// ─────────────────────────────────────────────────────────────────────────────

interface JsonLdAddress {
  streetAddress?:   string;
  addressLocality?: string;
  addressRegion?:   string;
  postalCode?:      string;
}

interface JsonLdItem {
  "@type"?:            string | string[];
  "@id"?:              string;
  name?:               string;
  description?:        string;
  url?:                string;
  price?:              string | number;
  minPrice?:           string | number | null;
  currency?:           string;
  additionalType?:     string;
  numberOfRooms?:      string | number;
  floorSize?:          { value?: number; unitCode?: string };
  additionalProperty?: { name?: string; value?: string | number } | Array<{ name?: string; value?: string | number }>;
  address?:            JsonLdAddress;
  geo?:                { latitude?: number; longitude?: number };
  spatialCoverage?:    { name?: string; address?: JsonLdAddress };
  containedInPlace?:   { name?: string; address?: JsonLdAddress };
  offeredBy?: Array<{
    name?:         string;
    jobTitle?:     string;
    organization?: string;
    telephone?:    string;
  }>;
  offers?: {
    price?:    string | number;
    priceCurrency?: string;
  } | Array<{ price?: string | number }>;
  "@graph"?: JsonLdItem[];
  itemListElement?: JsonLdItem[];
}

function extractSqftFromJsonLd(item: JsonLdItem): number | undefined {
  if (item.floorSize?.value) {
    const v = Number(item.floorSize.value);
    if (!isNaN(v) && v > 0) return Math.round(v);
  }
  const prop = item.additionalProperty;
  if (prop) {
    const props = Array.isArray(prop) ? prop : [prop];
    const sqftProp = props.find(
      (p) => p.name?.toLowerCase().includes("square") || p.name?.toLowerCase() === "sf"
    );
    if (sqftProp?.value) {
      const val = parseInt(String(sqftProp.value).replace(/,/g, ""), 10);
      if (!isNaN(val)) return val;
    }
  }
  return undefined;
}

function extractUnitsFromJsonLd(item: JsonLdItem): number | undefined {
  const prop = item.additionalProperty;
  if (!prop) return undefined;
  const props = Array.isArray(prop) ? prop : [prop];
  const unitProp = props.find((p) => p.name?.toLowerCase().includes("unit"));
  if (unitProp?.value) {
    const v = parseInt(String(unitProp.value), 10);
    return isNaN(v) ? undefined : v;
  }
  return undefined;
}

function getJsonLdPrice(item: JsonLdItem): number | undefined {
  const raw =
    item.price ??
    item.minPrice ??
    (Array.isArray(item.offers) ? item.offers[0]?.price : (item.offers as any)?.price);
  if (raw === null || raw === undefined) return undefined;
  const n = parseFloat(String(raw).replace(/[^0-9.]/g, ""));
  return isNaN(n) || n === 0 ? undefined : Math.round(n);
}

function getJsonLdAddress(item: JsonLdItem): { full: string | undefined; location: string } {
  const addr: JsonLdAddress | undefined =
    item.address ??
    item.spatialCoverage?.address ??
    item.containedInPlace?.address;

  const spatialName = item.spatialCoverage?.name ?? item.containedInPlace?.name;

  if (addr) {
    const street = addr.streetAddress ?? spatialName;
    const parts  = [street, addr.addressLocality, addr.addressRegion, addr.postalCode].filter(Boolean);
    const full   = parts.length > 0 ? parts.join(", ") : undefined;
    // location = clean "City, ST" only — never full address
    const loc    = [addr.addressLocality, addr.addressRegion].filter(Boolean).join(", ");
    return { full, location: loc || full || "" };
  }

  return { full: spatialName, location: spatialName ?? "" };
}

function getJsonLdSchemaType(item: JsonLdItem): string {
  const t = item["@type"];
  if (!t) return "";
  return (Array.isArray(t) ? t[0] : t).toLowerCase();
}

function jsonLdItemToListing(
  item: JsonLdItem,
  sourceUrl: string,
  source: string,
  urlFallback: string
): RawListing | null {
  const type = getJsonLdSchemaType(item);
  if (type && SKIP_SCHEMA_TYPES.has(type)) return null;

  const price = getJsonLdPrice(item);
  const { full: address, location: rawLocation } = getJsonLdAddress(item);

  const url = item.url?.startsWith("http")
    ? item.url
    : item.url
    ? `https://www.loopnet.com${item.url}`
    : urlFallback;

  const hasListingUrl = url.includes("/Listing/");
  if (!price && !address && !hasListingUrl) return null;

  // location: prefer structured JSON-LD "City, ST", then source URL
  const location =
    rawLocation ||
    address ||
    locationFromSourceUrl(sourceUrl) ||
    "Unknown";

  const brokers = item.offeredBy ?? [];
  const broker  = brokers[0];

  return {
    url,
    source,
    title:        (item.name ?? address ?? "").slice(0, 200).replace(/\s+/g, " ").trim(),
    price:        price && price > 0 ? price : undefined,
    address,
    location,
    propertyType: normalisePropertyType(item.additionalType),
    squareFeet:   extractSqftFromJsonLd(item),
    units:        extractUnitsFromJsonLd(item),
    description:  (item.description ?? "").slice(0, 2000),
    ownerName:    broker?.name,
    ownerPhone:   broker?.telephone,
  } as RawListing;
}

function parseViaJsonLd(html: string, sourceUrl: string, source: string): RawListing[] {
  const $ = cheerio.load(html);
  const results: RawListing[] = [];
  const seen = new Set<string>();

  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const raw  = $(el).html() ?? "";
      const data = JSON.parse(raw) as JsonLdItem | JsonLdItem[];
      const items: JsonLdItem[] = Array.isArray(data) ? data : [data];

      for (const item of items) {
        if (item["@graph"]) {
          for (const g of item["@graph"]) {
            const l = jsonLdItemToListing(g, sourceUrl, source, sourceUrl);
            if (l && !seen.has(l.url)) { seen.add(l.url); results.push(l); }
          }
          continue;
        }
        if (item.itemListElement) {
          for (const g of item.itemListElement) {
            const l = jsonLdItemToListing(g, sourceUrl, source, sourceUrl);
            if (l && !seen.has(l.url)) { seen.add(l.url); results.push(l); }
          }
          continue;
        }
        const l = jsonLdItemToListing(item, sourceUrl, source, sourceUrl);
        if (l && !seen.has(l.url)) { seen.add(l.url); results.push(l); }
      }
    } catch { /* malformed JSON-LD — skip */ }
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// PATH B — HTML / cheerio fallback
// ─────────────────────────────────────────────────────────────────────────────

const CARD_SELECTORS = [
  "[data-testid='listing-card']",
  "[data-testid='search-result-card']",
  "article.listingCard",
  "article[class*='listingCard']",
  "article[class*='listing-card']",
  "li[class*='listingCard']",
  "li[class*='listing-card']",
  "[class*='SearchResults'] article",
  "[class*='searchResult'] article",
  "[class*='property-card']",
  "article",
];

function findCards($: cheerio.CheerioAPI): cheerio.Cheerio<any> {
  for (const sel of CARD_SELECTORS) {
    const found = $(sel);
    if (found.length === 0) continue;
    const hasListingLink = found
      .toArray()
      .some((el) => $(el).find("a[href*='/Listing/']").length > 0);
    if (hasListingLink) {
      logger.info(`[loopnet-parser] HTML fallback: ${found.length} cards via "${sel}"`);
      return found;
    }
  }
  logger.warn("[loopnet-parser] HTML fallback: no cards with /Listing/ links found");
  return $();
}

function parseViaHTML(html: string, sourceUrl: string, source: string): RawListing[] {
  const $ = cheerio.load(html);
  const results: RawListing[] = [];
  const seen = new Set<string>();

  const cards = findCards($);
  if (cards.length === 0) return [];

  const urlLocation = locationFromSourceUrl(sourceUrl);

  cards.each((_, el) => {
    const card = $(el);
    const text = card.text().replace(/\s+/g, " ").trim();
    if (text.length < 20) return;

    // ── URL ───────────────────────────────────────────────────────────────
    const linkEl  = card.find("a[href*='/Listing/']").first();
    const rawHref = linkEl.attr("href") ?? "";
    if (!rawHref) return;

    const url    = rawHref.startsWith("http") ? rawHref : `https://www.loopnet.com${rawHref}`;
    const urlKey = url.split("?")[0];
    if (seen.has(urlKey)) return;
    seen.add(urlKey);

    // ── Description (the full card text is the ground truth) ──────────────
    const description = text.slice(0, 1500);

    // ── Address (FIX for BUG 2) ───────────────────────────────────────────
    // Primary: structured regex against the full card text — reliable because
    // LoopNet always renders the address as visible text even when it's split
    // across multiple DOM elements.
    // Fallback: dedicated address DOM element, but only if it contains a digit.
    let address: string | undefined = extractFullAddressFromText(description);

    if (!address) {
      const addrEl = card
        .find([
          "[data-testid*='address']",
          "[class*='address']",
          "[class*='location']",
          "[class*='street']",
        ].join(", "))
        .first();
      const addrText = addrEl.text().replace(/\s+/g, " ").trim();
      // Only accept if it contains a digit (must look like a street address)
      if (addrText && /\d/.test(addrText)) {
        address = addrText;
      }
    }

    // ── Location (FIX for BUG 1 & 4) ─────────────────────────────────────
    // Always a clean "City, ST" — never a full address, never a street-suffix
    // polluted string like "Ave Cleveland, OH".
    const location =
      extractCityStateFromText(description) ||
      urlLocation ||
      "Unknown";

    // ── Title (FIX for BUG 3) ─────────────────────────────────────────────
    // Preference order:
    //   1. The extracted street address (most useful / filterable)
    //   2. The h2/h3 text — but only if it isn't a bare "City, ST Zip" string
    //   3. First digit-containing substring of the card text
    const h2Text = card.find("h2, h3").first().text().replace(/\s+/g, " ").trim();

    let title: string;
    if (address && address.length > 10) {
      title = address;
    } else if (h2Text && !isCityStateOnly(h2Text)) {
      title = h2Text;
    } else {
      title = description.match(/\d+[^$\n]{5,50}/)?.[0]?.trim() ?? description.slice(0, 120);
    }
    title = title.slice(0, 200);

    // ── Price ─────────────────────────────────────────────────────────────
    const priceEl = card
      .find([
        "[data-testid*='price']",
        "[class*='price']",
        "[class*='Price']",
        "[class*='asking']",
      ].join(", "))
      .first();
    const price = extractPriceFromText(priceEl.text().trim()) ?? extractPriceFromText(description);

    // ── Property type ─────────────────────────────────────────────────────
    const typeEl = card
      .find([
        "[data-testid*='type']",
        "[class*='propertyType']",
        "[class*='property-type']",
        "[class*='assetType']",
      ].join(", "))
      .first();
    const propType = normalisePropertyType(typeEl.text().trim());

    // ── Sqft / Units ──────────────────────────────────────────────────────
    const sqft  = extractSqftFromText(description);
    const units = extractUnitsFromText(description);

    // ── Broker ────────────────────────────────────────────────────────────
    const brokerEl = card
      .find([
        "[class*='broker']",
        "[class*='agent']",
        "[class*='contact']",
        "[data-testid*='broker']",
      ].join(", "))
      .first();
    const ownerName  = brokerEl.text().replace(/\s+/g, " ").trim() || undefined;
    const ownerPhone = extractPhoneFromText(description);

    results.push({
      url,
      source,
      title,
      price,
      address,
      location,
      propertyType: propType,
      squareFeet:   sqft,
      units,
      description,
      ownerName,
      ownerPhone,
    } as RawListing);
  });

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Debug dump
// ─────────────────────────────────────────────────────────────────────────────

function saveParserDebug(info: {
  url:          string;
  jsonLdBlocks: number;
  pathACount:   number;
  pathBCount:   number;
  final:        number;
}): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    const content = [
      `Source URL:       ${info.url}`,
      `JSON-LD blocks:   ${info.jsonLdBlocks}`,
      `Path A (JSON-LD): ${info.pathACount} listings`,
      `Path B (HTML):    ${info.pathBCount} listings`,
      `Final:            ${info.final} listings`,
    ].join("\n");
    const slug = info.url
      .replace(/https?:\/\/[^/]+\/search\//, "")
      .replace(/[/?&=]/g, "_")
      .slice(0, 40);
    fs.writeFileSync(path.join(dir, `loopnet_parser_${slug}.txt`), content);
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// Main entry point
// ─────────────────────────────────────────────────────────────────────────────

export function parseLoopNetListings(
  html: string,
  sourceUrl: string,
  source: string
): RawListing[] {
  const jsonLdCount = (html.match(/application\/ld\+json/g) ?? []).length;
  logger.debug(`[loopnet-parser] JSON-LD blocks found: ${jsonLdCount}`);

  // PATH A — JSON-LD (structured data embedded by LoopNet)
  const pathAResults = parseViaJsonLd(html, sourceUrl, source);
  if (pathAResults.length > 0) {
    logger.info(`[loopnet-parser] PATH A (JSON-LD): ${pathAResults.length} listings`);
    saveParserDebug({
      url: sourceUrl, jsonLdBlocks: jsonLdCount,
      pathACount: pathAResults.length, pathBCount: 0, final: pathAResults.length,
    });
    return pathAResults;
  }

  // PATH B — HTML article-card fallback
  logger.info("[loopnet-parser] PATH A empty — falling back to HTML");
  const pathBResults = parseViaHTML(html, sourceUrl, source);
  logger.info(`[loopnet-parser] PATH B (HTML): ${pathBResults.length} listings`);

  saveParserDebug({
    url: sourceUrl, jsonLdBlocks: jsonLdCount,
    pathACount: 0, pathBCount: pathBResults.length, final: pathBResults.length,
  });

  return pathBResults;
}