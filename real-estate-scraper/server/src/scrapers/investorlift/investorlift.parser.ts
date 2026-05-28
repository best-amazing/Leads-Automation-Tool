// src/scrapers/investorlift/investorlift.parser.ts
// ─────────────────────────────────────────────────────────────────────────────
// InvestorLift is a React SPA — all data is loaded dynamically.
// We extract listings from two sources (in priority order):
//   1. The XHR/fetch API responses that the SPA calls (most reliable)
//   2. The rendered DOM as a fallback
// ─────────────────────────────────────────────────────────────────────────────

import * as cheerio from "cheerio";
import { RawListing, PropertyType } from "../../types/listing";
import { logger } from "../../utils/logger";

// ── Helpers ────────────────────────────────────────────────────────────────

function normalizePrice(val: unknown): number | undefined {
  if (typeof val === "number") return Math.round(val);
  if (typeof val === "string") {
    const m = val.replace(/[$,\s]/g, "").match(/\d+/);
    return m ? parseInt(m[0], 10) : undefined;
  }
  return undefined;
}

function normalizePropertyType(raw: unknown): PropertyType {
  if (!raw) return "unknown";
  const t = String(raw).toLowerCase();
  if (t.includes("single") || t.includes("sfh")) return "single_family";
  if (t.includes("multi") || t.includes("duplex") || t.includes("triplex"))
    return "multi_family";
  if (t.includes("condo")) return "condo";
  if (t.includes("town")) return "townhouse";
  return "unknown";
}

function buildDetailUrl(listingId: string | number): string {
  return `https://app.investorlift.com/properties/${listingId}`;
}

/**
 * Validate that an address looks like a real street address.
 * Must start with a street number (one or more digits).
 * Examples:
 *   ✓ "1863 Clarion Avenue, Cincinnati, OH 45207"
 *   ✓ "786 Noah Avenue, Akron, OH 44320"
 *   ✗ "Your request has been submitted. Our manager will contact you shortly."
 *   ✗ "Columbus, OH 43215"
 */
function isValidStreetAddress(address: string | undefined): boolean {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  // Must start with digits (street number)
  return /^\d+\s/.test(trimmed);
}

// ── API response parser ────────────────────────────────────────────────────

/**
 * Parse the JSON payload from InvestorLift's internal API.
 *
 * InvestorLift calls endpoints like:
 *   GET /api/v1/properties?page=1&per_page=20&...
 *
 * The response shape (based on observed traffic) looks like:
 * {
 *   data: [ { id, address, city, state, zip, price, beds, baths, sqft,
 *             property_type, listed_at, owner_name, owner_phone, ... } ],
 *   meta: { total, page, per_page }
 * }
 *
 * ⚠️  InvestorLift may change their API shape — check logs/investorlift_api_*.json
 *     if parsing breaks.
 */
// Original object-per-row path, preserved as fallback
function mapObjectItems(items: any[], source: string): RawListing[] {
  if (items.length === 0) {
    logger.warn("[il-parser] No items found in API response (empty array)");
    return [];
  }
  logger.debug(`[il-parser] API returned ${items.length} raw items`);

  return items
    .map((item): RawListing | null => {
      try {
        const id = item.id;
        const price = item.price;
        if (!id || !price) return null;

        const address = [item.city, item.county, item.state_code, item.zip]
          .filter(Boolean)
          .join(", ");

        return {
          source,
          url: `https://investorlift.com/marketplace/deal/${id}`,
          title: item.title || address,
          address,
          price: Number(price),
          bedrooms:   item.bedrooms   != null ? Number(item.bedrooms)   : undefined,
          bathrooms:  item.bathrooms  != null ? Number(item.bathrooms)  : undefined,
          squareFeet: item.sq_footage != null ? Number(item.sq_footage) : undefined,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as RawListing[];
}

export function parseApiResponse(json: unknown, source: string): RawListing[] {
  if (!json) return [];

  let columns: string[] = [];
  let rows: any[][] = [];

  if (typeof json === "object" && !Array.isArray(json)) {
    const raw = json as Record<string, unknown>;

    // Columnar format: { columns: [...], data: [[...], ...], meta: {...} }
    if (Array.isArray(raw.columns) && Array.isArray(raw.data)) {
      columns = raw.columns as string[];
      rows = raw.data as any[][];
    }
    // Fallback: array of objects — try common envelope keys
    else if (Array.isArray(raw.data)) {
      const items = raw.data as any[];
      return mapObjectItems(items, source);
    } else if (Array.isArray(raw.results)) {
      return mapObjectItems(raw.results as any[], source);
    } else if (Array.isArray(raw.properties)) {
      return mapObjectItems(raw.properties as any[], source);
    } else if (Array.isArray(raw.items)) {
      return mapObjectItems(raw.items as any[], source);
    } else if (
      typeof raw.data === "object" &&
      !Array.isArray(raw.data) &&
      Array.isArray((raw.data as any).properties)
    ) {
      // Nested: { data: { properties: [...] } }
      return mapObjectItems((raw.data as any).properties as any[], source);
    }
    // Try any top-level array key as a last resort
    else {
      for (const key of Object.keys(raw)) {
        if (Array.isArray(raw[key])) {
          return mapObjectItems(raw[key] as any[], source);
        }
      }
    }

    // No array found — log diagnostic info
    logger.warn(
      `[il-parser] No items found — top-level keys: ${Object.keys(raw).join(", ")}. Raw object keys and types: ${Object.entries(raw)
        .map(([k, v]) => `${k}: ${typeof v}${Array.isArray(v) ? `[${(v as any[]).length}]` : ""}`)
        .join(", ")}`
    );
  } else if (Array.isArray(json)) {
    return mapObjectItems(json as any[], source);
  }

  if (rows.length === 0) {
    logger.warn("[il-parser] No items found in API response");
    return [];
  }

  logger.debug(`[il-parser] API returned ${rows.length} raw items`);

  // Convert columnar rows → objects, then map
  const col = (name: string) => columns.indexOf(name);

  return rows
    .map((row): RawListing | null => {
      try {
        const id = row[col("id")];
        const price = row[col("price")];
        if (!id || price == null) return null;

        const city = row[col("city")] ?? "";
        const county = row[col("county")] ?? "";
        const stateCode = row[col("state_code")] ?? "";
        const zip = row[col("zip")] ?? "";

        const address = [city, county, stateCode, zip]
          .filter(Boolean)
          .join(", ");

        return {
          source,
          url: `https://investorlift.com/marketplace/deal/${id}`,
          title: row[col("title")] || address,
          address,
          price: Number(price),
          bedrooms:
            row[col("bedrooms")] != null
              ? Number(row[col("bedrooms")])
              : undefined,
          bathrooms:
            row[col("bathrooms")] != null
              ? Number(row[col("bathrooms")])
              : undefined,
          squareFeet:
            row[col("sq_footage")] != null
              ? Number(row[col("sq_footage")])
              : undefined,
        };
      } catch {
        return null;
      }
    })
    .filter(Boolean) as RawListing[];
}

// ── DOM fallback parser ────────────────────────────────────────────────────

/**
 * Fallback: parse listings from the rendered HTML when the API
 * intercept didn't capture a response.
 *
 * Card selectors are based on InvestorLift's current layout (April 2026).
 * If the layout changes, update the selectors here — the rest of the
 * pipeline stays the same.
 */
export function parseDomListings(html: string, source: string): RawListing[] {
  const $ = cheerio.load(html);
  const results: RawListing[] = [];

  // InvestorLift renders property cards — try several known selectors
  const cardSelectors = [
    "[data-testid='property-card']",
    ".property-card",
    ".listing-card",
    "[class*='PropertyCard']",
    "[class*='ListingCard']",
    "[class*='property-item']",
  ];

  let cards = $();
  for (const sel of cardSelectors) {
    cards = $(sel);
    if (cards.length > 0) {
      logger.debug(
        `[il-parser] DOM: found ${cards.length} cards with selector "${sel}"`,
      );
      break;
    }
  }

  if (cards.length === 0) {
    logger.warn(
      "[il-parser] DOM fallback: no property cards found — check selectors",
    );
    return [];
  }

  cards.each((_, el) => {
    const card = $(el);

    // URL — look for a link with a property path
    const anchor = card
      .find("a[href*='/properties/'], a[href*='/listing/']")
      .first();
    const href = anchor.attr("href") ?? "";
    const url = href.startsWith("http")
      ? href
      : href
        ? `https://app.investorlift.com${href}`
        : "";

    if (!url) return; // skip cards without a link

    // Price
    const priceText =
      card.find("[class*='price'], [data-testid*='price']").first().text() ||
      card
        .find("span, p")
        .filter((_, e) => /\$[\d,]+/.test($(e).text()))
        .first()
        .text();
    const price = normalizePrice(priceText);

    // Address — try dedicated selector first, NEVER fall back to anchor text
    const addressFromCard = card
      .find("[class*='address'], [data-testid*='address']")
      .first()
      .text()
      .trim();

    // Validate that address has a street number (leading digits)
    if (!isValidStreetAddress(addressFromCard)) {
      logger.debug(
        `[il-parser] DOM: skipping card — invalid address "${addressFromCard}" (no street number)`
      );
      return;
    }

    // Beds / baths / sqft
    const detailText = card
      .find("[class*='detail'], [class*='spec'], [class*='stat']")
      .text();
    const bedsM = detailText.match(/(\d+)\s*(?:bd|bed|br)/i);
    const bathsM = detailText.match(/(\d+(?:\.\d+)?)\s*(?:ba|bath)/i);
    const sqftM = detailText.match(/([\d,]+)\s*(?:sqft|sq ft|sf)/i);

    results.push({
      url,
      source,
      title: addressFromCard || undefined,
      address: addressFromCard || undefined,
      price,
      bedrooms: bedsM ? parseInt(bedsM[1], 10) : undefined,
      bathrooms: bathsM ? parseFloat(bathsM[1]) : undefined,
      squareFeet: sqftM ? parseInt(sqftM[1].replace(/,/g, ""), 10) : undefined,
    });
  });

  logger.debug(`[il-parser] DOM fallback: parsed ${results.length} listings`);
  return results;
}
