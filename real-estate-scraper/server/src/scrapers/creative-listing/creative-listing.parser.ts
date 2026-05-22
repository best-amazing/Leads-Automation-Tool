// src/scrapers/creativelisting/creativelisting.parser.ts
//
// Parses rendered HTML from CreativeListing.com's React SPA.
//
// ── Site Architecture ─────────────────────────────────────────────────────────
//
// CreativeListing.com is a fully client-side React SPA (assets on CloudFront
// at db7z26wykqpga.cloudfront.net).  ALL listing data is:
//   1. Login-gated — no public listing pages exist.
//   2. Rendered client-side via JS — the raw HTML shell has no listing data.
//   3. Fetched from a private AWS backend API after authentication.
//
// ── Scraping Strategy ────────────────────────────────────────────────────────
//
// Because the site is a React SPA, we MUST use Oxylabs render:"html" to get
// the fully hydrated DOM.  We also inject the authenticated session cookie
// (CL_SESSION or equivalent) so Oxylabs' headless Chrome is already logged in
// when it renders the page.
//
// Session cookie is obtained once by the scraper and passed per-request.
//
// ── Listing Page URL Pattern ──────────────────────────────────────────────────
//
// Observed (May 2026):
//   https://www.creativelisting.com/listings              ← paginated list
//   https://www.creativelisting.com/listings?page=2
//   https://www.creativelisting.com/listings?state=OH
//   https://www.creativelisting.com/listings?state=OH&page=2
//   https://www.creativelisting.com/listing/<slug>        ← detail page
//
// URL patterns need to be verified against live browser DevTools.
// Update LISTING_LIST_PATH and LISTING_DETAIL_BASE in the scraper if they differ.
//
// ── HTML Structure (expected, verify via DevTools) ────────────────────────────
//
// Listing card (search results page):
//   <div class="listing-card" data-listing-id="...">
//     <a class="listing-card__link" href="/listing/<slug>">
//       <div class="listing-card__price">$250,000</div>
//       <div class="listing-card__address">123 Main St, Cleveland, OH 44101</div>
//       <div class="listing-card__beds">3 bd</div>
//       <div class="listing-card__baths">2 ba</div>
//       <div class="listing-card__sqft">1,200 sqft</div>
//       <div class="listing-card__type">Subject-To</div>
//       <div class="listing-card__strategy">Seller Finance</div>
//     </a>
//   </div>
//
// Detail page:
//   <h1 class="listing-detail__address">...</h1>
//   <span class="listing-detail__price">...</span>
//   ... (verify in DevTools after login)
//
// NOTE: All selectors above are GUESSES based on common React SPA patterns.
//       You MUST verify them by:
//         1. Logging in on a real browser
//         2. Opening DevTools → Elements tab
//         3. Inspecting the actual listing card markup
//         4. Updating SELECTORS below accordingly
//
// ── Pagination ────────────────────────────────────────────────────────────────
//
// React SPAs typically use one of:
//   a) ?page=N query param               ← most likely
//   b) Infinite scroll (no page param)   ← harder; need JS scroll simulation
//   c) Cursor-based (?after=<token>)
//
// The scraper defaults to ?page=N.  If the site uses infinite scroll,
// set infiniteScroll: true in config and use Oxylabs scroll context.
//
// ── Creative Finance Field Mapping ───────────────────────────────────────────
//
// CreativeListing specialises in these deal types (stored in dealType):
//   "subto"          — Subject-To existing mortgage
//   "seller_finance" — Seller carries the note
//   "wrap"           — All-inclusive trust deed / wraparound mortgage
//   "novation"       — Novation agreement
//   "lease_option"   — Rent-to-own / lease option
//   "cash"           — Traditional cash deal
//   "dscr"           — DSCR loan listing
//   "unknown"        — Not identified
//
// These are mapped from raw strings found in the listing card/detail DOM.

import * as cheerio from "cheerio";
import { RawListing } from "../../types/listing";
import { logger }     from "../../utils/logger";

// ── Selectors ─────────────────────────────────────────────────────────────────
//
// !! IMPORTANT !!  These are placeholder guesses.
// Verify every selector against live rendered HTML from a logged-in session
// before running the scraper in production.  Save a raw HTML sample to
// logs/creativelisting_debug_p1.html and inspect it to find the real class
// names / data attributes.

export const SELECTORS = {
  // Listing card container on the search results page
  listingCard:    '[class*="listing-card"], [data-testid="listing-card"], .listing-item, article',

  // Link to detail page (href="/listing/<slug>") — on the card
  cardLink:       'a[href*="/listing/"]',

  // Fields within a card
  cardPrice:      '[class*="price"], [data-testid="price"]',
  cardAddress:    '[class*="address"], [data-testid="address"]',
  cardBeds:       '[class*="bed"], [data-testid="beds"]',
  cardBaths:      '[class*="bath"], [data-testid="baths"]',
  cardSqft:       '[class*="sqft"], [class*="sqFt"], [class*="size"], [data-testid="sqft"]',
  cardDealType:   '[class*="deal-type"], [class*="strategy"], [class*="finance-type"], [class*="badge"]',
  cardDaysListed: '[class*="days"], [class*="listed"], [data-testid="days-listed"]',
  cardState:      '[class*="state"], [class*="location"]',

  // Pagination: next page button or last-page indicator
  paginationNext: 'a[aria-label="Next"], button[aria-label="Next page"], [class*="pagination"] [class*="next"]',
  paginationInfo: '[class*="pagination"], [class*="page-info"]',

  // Detail page
  detailAddress:  'h1[class*="address"], [data-testid="detail-address"]',
  detailPrice:    '[class*="detail"][class*="price"], [data-testid="detail-price"]',
  detailBeds:     '[data-testid="detail-beds"],  [class*="detail"][class*="bed"]',
  detailBaths:    '[data-testid="detail-baths"], [class*="detail"][class*="bath"]',
  detailSqft:     '[data-testid="detail-sqft"],  [class*="detail"][class*="sqft"]',
  detailDealType: '[class*="deal-type"], [class*="strategy-badge"]',
  detailDesc:     '[class*="description"], [data-testid="description"]',
  detailPropertyType: '[class*="property-type"], [data-testid="property-type"]',
} as const;

// ── Deal type normaliser ──────────────────────────────────────────────────────

const DEAL_TYPE_MAP: Array<{ patterns: string[]; normalized: string }> = [
  { patterns: ["subject-to", "subto", "sub-to", "subject to"],             normalized: "subto" },
  { patterns: ["seller financ", "seller carry", "owner financ"],           normalized: "seller_finance" },
  { patterns: ["wrap", "all-inclusive", "aitd"],                           normalized: "wrap" },
  { patterns: ["novation"],                                                 normalized: "novation" },
  { patterns: ["lease option", "lease-option", "rent-to-own", "rent to own"], normalized: "lease_option" },
  { patterns: ["dscr"],                                                     normalized: "dscr" },
  { patterns: ["cash"],                                                     normalized: "cash" },
];

export function normalizeDealType(raw: string): string {
  const lower = raw.toLowerCase().trim();
  for (const { patterns, normalized } of DEAL_TYPE_MAP) {
    if (patterns.some(p => lower.includes(p))) return normalized;
  }
  return "unknown";
}

// ── Price parser (re-exported from redfin.parser for consistency) ──────────────

export function parsePrice(raw: string | number | null | undefined): number | undefined {
  if (typeof raw === "number" && raw > 0) return raw;
  if (typeof raw === "string") {
    const s = raw.replace(/[$,\s]/g, "").toUpperCase();
    if (s.endsWith("K")) return Math.round(parseFloat(s) * 1_000);
    if (s.endsWith("M")) return Math.round(parseFloat(s) * 1_000_000);
    const n = parseInt(s, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return undefined;
}

// ── Integer extractor ─────────────────────────────────────────────────────────

function extractInt(text: string): number | undefined {
  const m = text.match(/(\d[\d,]*)/);
  if (!m) return undefined;
  const n = parseInt(m[1].replace(/,/g, ""), 10);
  return isNaN(n) ? undefined : n;
}

// ── Days-on-market extractor ──────────────────────────────────────────────────

function parseDaysOnMarket(text: string): number | undefined {
  // "Listed 5 days ago", "3d", "Posted 12 days"
  const m =
    text.match(/(\d+)\s*d(?:ay)?s?\s*ago/i) ??
    text.match(/(\d+)\s*d\b/i)              ??
    text.match(/listed\s+(\d+)/i)           ??
    text.match(/posted\s+(\d+)/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return isNaN(n) ? undefined : n;
};

// ── Address state extractor ───────────────────────────────────────────────────

export function extractStateFromAddress(address: string): string {
  // "123 Main St, Cleveland, OH 44101"  →  "OH"
  const m = address.match(/,\s*([A-Z]{2})\s+\d{5}/);
  if (m) return m[1];
  // Looser: last two-cap-letter token before end or zip
  const m2 = address.match(/\b([A-Z]{2})\b(?:\s+\d{5})?$/);
  return m2 ? m2[1] : "";
}

// ── Listing card parser ───────────────────────────────────────────────────────

export interface ParsedListingCard {
  url:          string;
  address:      string;
  price:        number | undefined;
  bedrooms:     number | undefined;
  bathrooms:    number | undefined;
  squareFeet:   number | undefined;
  daysOnMarket: number | undefined;
  dealType:     string;
  stateAbbr:    string;   // extracted from address for location filtering
  rawHtml:      string;   // original card HTML, saved for debugging
}

export function parseListingCards(
  html:      string,
  pageLabel: string
): ParsedListingCard[] {
  const $ = cheerio.load(html);
  const results: ParsedListingCard[] = [];

  // Dump ALL class names found to help identify the right selector during setup
  const allClasses = new Set<string>();
  $("[class]").each((_, el) => {
    const cls = $(el).attr("class") ?? "";
    cls.split(/\s+/).forEach(c => { if (c) allClasses.add(c); });
  });
  logger.debug(
    `[cl-parser] ${pageLabel}: sample classes → ` +
    [...allClasses].slice(0, 30).join(", ")
  );

  const cards = $(SELECTORS.listingCard);
  logger.debug(`[cl-parser] ${pageLabel}: found ${cards.length} card(s) with selector "${SELECTORS.listingCard}"`);

  if (cards.length === 0) {
    // Fallback: log first 2000 chars of the rendered body so we can inspect it
    logger.warn(
      `[cl-parser] ${pageLabel}: No cards found. Body snippet:\n` +
      $.root().html()?.slice(0, 2_000)
    );
  }

  cards.each((i, el) => {
    const card  = $(el);
    const rawHtml = $.html(el) ?? "";

    // URL
    // Prefer data-listing-id or data attribute if present; fall back to href.
    const dataId = card.attr("data-listing-id") ?? card.data("listing-id") ?? "";
    const href = card.find(SELECTORS.cardLink).first().attr("href") ?? "";
    if (!href) {
      logger.debug(`[cl-parser] ${pageLabel} card[${i}]: no href — skipping`);
      return;
    }
    // If a data-listing-id (UUID) exists, build canonical /deals/<id> URL.
    const url = dataId
      ? `https://www.creativelisting.com/deals/${dataId}`
      : (href.startsWith("http") ? href : `https://www.creativelisting.com${href}`);

    // Address
    const address = card.find(SELECTORS.cardAddress).first().text().trim();

    // Price
    const priceText = card.find(SELECTORS.cardPrice).first().text().trim();
    const price     = parsePrice(priceText);

    // Beds / baths / sqft
    const bedsText  = card.find(SELECTORS.cardBeds).first().text().trim();
    const bathsText = card.find(SELECTORS.cardBaths).first().text().trim();
    const sqftText  = card.find(SELECTORS.cardSqft).first().text().trim();
    const bedrooms  = extractInt(bedsText);
    const bathrooms = extractInt(bathsText);
    const squareFeet = extractInt(sqftText);

    // Deal type badge
    const dealTypeRaw = card.find(SELECTORS.cardDealType).first().text().trim();
    const dealType    = normalizeDealType(dealTypeRaw);

    // Days on market
    const domRaw      = card.find(SELECTORS.cardDaysListed).first().text().trim();
    const daysOnMarket = parseDaysOnMarket(domRaw);

    // State (from address)
    const stateAbbr = extractStateFromAddress(address);

    logger.debug(
      `[cl-parser] ${pageLabel} card[${i}]: ` +
      `${address} | $${price?.toLocaleString()} | ` +
      `${bedrooms}bd ${bathrooms}ba ${squareFeet}sqft | ` +
      `${dealType} | dom=${daysOnMarket ?? "?"} | state=${stateAbbr}`
    );

    results.push({
      url,
      address,
      price,
      bedrooms,
      bathrooms,
      squareFeet,
      daysOnMarket,
      dealType,
      stateAbbr,
      rawHtml,
    });
  });

  return results;
}

// ── Detail page parser ────────────────────────────────────────────────────────
//
// Called only when the listing card lacks sufficient data (e.g. no sqft/beds).
// In practice CreativeListing may put all data in the card; detail fetches
// are rate-limited and should be minimised.

export interface ParsedListingDetail {
  address:      string | undefined;
  price:        number | undefined;
  bedrooms:     number | undefined;
  bathrooms:    number | undefined;
  squareFeet:   number | undefined;
  dealType:     string | undefined;
  description:  string | undefined;
  propertyType: string | undefined;
}

export function parseListingDetail(html: string, slug: string): ParsedListingDetail {
  const $ = cheerio.load(html);

  const address    = $(SELECTORS.detailAddress).first().text().trim() || undefined;
  const priceText  = $(SELECTORS.detailPrice).first().text().trim();
  const price      = parsePrice(priceText) || undefined;
  const bedsText   = $(SELECTORS.detailBeds).first().text().trim();
  const bathsText  = $(SELECTORS.detailBaths).first().text().trim();
  const sqftText   = $(SELECTORS.detailSqft).first().text().trim();
  const dealRaw    = $(SELECTORS.detailDealType).first().text().trim();
  const description = $(SELECTORS.detailDesc).first().text().trim() || undefined;
  const propTypeRaw = $(SELECTORS.detailPropertyType).first().text().trim();

  // Attempt to extract from embedded __NEXT_DATA__ / window.__INITIAL_STATE__
  // Some React apps pre-hydrate JSON — worth checking
  let dataFromScript: Partial<ParsedListingDetail> = {};
  $("script").each((_, el) => {
    const t = $(el).html() ?? "";
    if (!t.includes("price") && !t.includes("address")) return;

    // Try JSON blobs
    const priceMatch = t.match(/"(?:price|listPrice|askingPrice)"\s*:\s*([0-9]+)/i);
    if (priceMatch && !dataFromScript.price) {
      const candidate = parseInt(priceMatch[1], 10);
      if (!isNaN(candidate) && candidate > 10_000) dataFromScript.price = candidate;
    }
    const bedsMatch = t.match(/"(?:beds|bedrooms|numBeds)"\s*:\s*([0-9]+)/i);
    if (bedsMatch && !dataFromScript.bedrooms) {
      dataFromScript.bedrooms = parseInt(bedsMatch[1], 10);
    }
    const bathsMatch = t.match(/"(?:baths|bathrooms|numBaths)"\s*:\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (bathsMatch && !dataFromScript.bathrooms) {
      dataFromScript.bathrooms = parseFloat(bathsMatch[1]);
    }
    const sqftMatch = t.match(/"(?:sqft|squareFeet|livingArea|squareFootage)"\s*:\s*([0-9]+)/i);
    if (sqftMatch && !dataFromScript.squareFeet) {
      dataFromScript.squareFeet = parseInt(sqftMatch[1], 10);
    }
  });

  const result: ParsedListingDetail = {
    address:      address,
    price:        price        ?? dataFromScript.price,
    bedrooms:     extractInt(bedsText)  ?? dataFromScript.bedrooms,
    bathrooms:    extractInt(bathsText) ?? dataFromScript.bathrooms,
    squareFeet:   extractInt(sqftText)  ?? dataFromScript.squareFeet,
    dealType:     dealRaw ? normalizeDealType(dealRaw) : undefined,
    description:  description,
    propertyType: propTypeRaw.toLowerCase() || undefined,
  };

  logger.debug(
    `[cl-parser] detail[${slug}]: ` +
    `${result.address} | $${result.price?.toLocaleString()} | ` +
    `${result.bedrooms}bd ${result.bathrooms}ba ${result.squareFeet}sqft | ` +
    `${result.dealType}`
  );

  return result;
}

// ── Pagination helper ─────────────────────────────────────────────────────────

export interface PaginationInfo {
  hasNextPage:  boolean;
  totalCount:   number | undefined;
  currentPage:  number | undefined;
}

export function parsePagination(html: string): PaginationInfo {
  const $ = cheerio.load(html);

  const hasNextPage = $(SELECTORS.paginationNext).length > 0;

  // Try to extract "Page 1 of 12" or "Showing 1-20 of 240 listings"
  let totalCount:  number | undefined;
  let currentPage: number | undefined;

  $(SELECTORS.paginationInfo).each((_, el) => {
    const text = $(el).text();

    // "Page X of Y"
    const pageOf = text.match(/page\s+(\d+)\s+of\s+(\d+)/i);
    if (pageOf) {
      currentPage = parseInt(pageOf[1], 10);
      const lastPage = parseInt(pageOf[2], 10);
      // can't get total count from page count alone without knowing page size
      _ = lastPage; // suppressing unused-var lint
    }

    // "Showing 1-20 of 240 listings" / "240 listings"
    const totalMatch =
      text.match(/of\s+([\d,]+)\s+listing/i) ??
      text.match(/([\d,]+)\s+listing/i);
    if (totalMatch && !totalCount) {
      totalCount = parseInt(totalMatch[1].replace(/,/g, ""), 10);
    }
  });

  return { hasNextPage, totalCount, currentPage };
}

// ── Card → RawListing converter ───────────────────────────────────────────────

export function cardToRawListing(
  card:   ParsedListingCard,
  detail: ParsedListingDetail | null
): RawListing & { _clDealType?: string } {
  const address = card.address || detail?.address || card.url;

  return {
    url:          card.url,
    source:       "creativelisting",
    title:        address,
    address:      address,
    price:        card.price        ?? detail?.price,
    zestimate:    undefined,         // CreativeListing has no AVM
    bedrooms:     card.bedrooms     ?? detail?.bedrooms,
    bathrooms:    card.bathrooms    ?? detail?.bathrooms,
    squareFeet:   card.squareFeet   ?? detail?.squareFeet,
    propertyType: (detail?.propertyType ?? "unknown") as any,
    description:  detail?.description ?? "",
    listedAt:     card.daysOnMarket != null
      ? (() => { const d = new Date(); d.setDate(d.getDate() - card.daysOnMarket!); return d; })()
      : undefined,
    daysOnMarket: card.daysOnMarket,
    _clDealType:  card.dealType !== "unknown"
      ? card.dealType
      : (detail?.dealType ?? "unknown"),
  };
}