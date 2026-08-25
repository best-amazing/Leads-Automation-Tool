// src/scrapers/property-purchase-research/adu-research.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// ADU Property Purchase Research Scraper
//
// Extends the existing InvestorLiftScraper to:
//   1. Replace price/location passesFilter() with keyword-based ADU matching
//   2. Match listings in Ohio (OH)
//   3. Capture extended fields (description, units, yearBuilt, schoolRating)
//   4. Output results to CSV + JSON instead of the database
//
// Usage:
//   npm run scrape:adu-research
//   node -r ts-node/register index.ts --source adu-research
// ─────────────────────────────────────────────────────────────────────────────

import { chromium, Browser } from "playwright";
import * as fs from "fs";
import * as path from "path";

// How many listings to log detailed diagnostics for (avoids log spam)
const DIAGNOSTIC_LOG_LIMIT = 10;

import axios from "axios";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import {
  loadSeenListings as loadSeenFromDb,
  saveSeenListings as saveSeenToDb,
} from "../../utils/backfill-store";
import { ADU_KEYWORDS, TARGET_STATES } from "./adu-keywords";
import {
  AduResearchListing,
  parseAduApiResponse,
} from "./adu-research.parser";

// ── Constants (reuse from InvestorLift) ────────────────────────────────────

const MARKETPLACE_URL = "https://investorlift.com/marketplace/";
const PROPERTIES_API_URL = "https://investorlift.com/marketplace/api/customer/api/properties";
const ADDRESS_INQUIRY_URL = "https://investorlift.com/marketplace/api/customer/api/inquiry";

const ADDRESS_LIMIT_SENTINEL = "You have reached the daily address request limit";
const ADDRESS_FETCH_LIMIT = 5;
const ADDRESS_REQUEST_DELAY = 800;

const SESSION_FILE_DEFAULT = process.env.INVESTORLIFT_SESSION_FILE
  ? path.resolve(process.env.INVESTORLIFT_SESSION_FILE)
  : path.join(__dirname, "../../..", "investorlift-session.json");
const SESSION_FILE_FALLBACK = path.join(__dirname, "../../..", "investor-session.json");
const SESSION_FILE = fs.existsSync(SESSION_FILE_FALLBACK) && !fs.existsSync(SESSION_FILE_DEFAULT)
  ? SESSION_FILE_FALLBACK
  : SESSION_FILE_DEFAULT;
const DEBUG_DIR = path.resolve("logs");

// How many new listings to process per run
const BACKFILL_BATCH_SIZE = 1000;

// How many raw XHR payloads to save for inspection (avoids disk spam if there are many requests)
const MAX_RAW_SAVES = 3;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": USER_AGENT,
  "Origin": "https://investorlift.com",
  "Referer": "https://investorlift.com/marketplace/",
};

const CHROMIUM_ARGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

// ── Error types ─────────────────────────────────────────────────────────────

class DailyLimitReachedError extends Error {
  constructor() {
    super("Daily address request limit reached");
    this.name = "DailyLimitReachedError";
  }
}

class SessionExpiredError extends Error {
  constructor() {
    super("InvestorLift session expired or missing");
    this.name = "SessionExpiredError";
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractListingId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/\/(?:deal|p)\/([^/?#]+)/);
  return m?.[1];
}

// ── ADU Filters (split into location + keyword stages) ─────────────────────

// Counter for diagnostic logging (reset per run)
let _locationDiagCount = 0;
let _keywordDiagCount = 0;
let _criteriaDiagCount = 0;

/** Reset diagnostic counters — call at the start of each run */
export function resetDiagCounters(): void {
  _locationDiagCount = 0;
  _keywordDiagCount = 0;
  _criteriaDiagCount = 0;
}

/**
 * Stage 1: Check if a listing is located in one of TARGET_STATES.
 * Logs diagnostic details for the first N listings.
 */
export function passesLocationFilter(listing: AduResearchListing): boolean {
  const addressUpper = (listing.address ?? "").toUpperCase();
  const stateUpper = (listing.state ?? "").toUpperCase();

  const matchedState = TARGET_STATES.find((s) => {
    if (stateUpper === s) return true;
    return addressUpper.includes(`, ${s}`);
  });

  const passed = !!matchedState;

  // Diagnostic logging for first N listings
  if (_locationDiagCount < DIAGNOSTIC_LOG_LIMIT) {
    _locationDiagCount++;
    logger.info(
      `[adu-filter] LOCATION [${_locationDiagCount}] ` +
      `${passed ? "✓ PASS" : "✗ FAIL"} | ` +
      `state field="${listing.state ?? "(empty)"}" | ` +
      `address="${(listing.address ?? "(empty)").slice(0, 80)}" | ` +
      `matched="${matchedState ?? "none"}"`
    );
  }

  return passed;
}

/**
 * Stage 2: Check if a listing contains at least one ADU_KEYWORD
 * in title/description/address.
 * Logs diagnostic details for the first N listings.
 */
export function passesKeywordFilter(listing: AduResearchListing): boolean {
  const titlePart = listing.title ?? "";
  const descriptionPart = listing.description ?? "";
  const addressPart = listing.address ?? "";

  const haystack = [titlePart, descriptionPart, addressPart]
    .join(" ")
    .toLowerCase();

  const matchedKeyword = ADU_KEYWORDS.find((kw) => {
    const regex = new RegExp(`\\b${kw}\\b`, 'i');
    return regex.test(haystack);
  });

  const passed = !!matchedKeyword;

  // Diagnostic logging for first N listings
  if (_keywordDiagCount < DIAGNOSTIC_LOG_LIMIT) {
    _keywordDiagCount++;
    logger.info(
      `[adu-filter] KEYWORD [${_keywordDiagCount}] ` +
      `${passed ? "✓ PASS" : "✗ FAIL"} | ` +
      `title="${titlePart.slice(0, 60)}" | ` +
      `desc length=${descriptionPart.length} | ` +
      `desc preview="${descriptionPart.slice(0, 100)}" | ` +
      `address="${addressPart.slice(0, 60)}" | ` +
      `matchedKw="${matchedKeyword ?? "none"}" | ` +
      `haystack (300 chars)="${haystack.slice(0, 300)}"`
    );
  }

  return passed;
}

/**
 * Stage 3: Check strict property criteria (Price, Beds, Baths, Year, HOA, etc.)
 */
export function passesPropertyCriteria(listing: AduResearchListing): boolean {
  let passed = true;
  let failReason = "";

  // 1. Price <= $600,000
  if (listing.price != null && listing.price > 600000) {
    passed = false;
    failReason = `price > 600k (${listing.price})`;
  }
  // 2. Bedrooms >= 3
  else if (listing.bedrooms != null && listing.bedrooms < 3) {
    passed = false;
    failReason = `bedrooms < 3 (${listing.bedrooms})`;
  }
  // 3. Bathrooms >= 2
  else if (listing.bathrooms != null && listing.bathrooms < 2) {
    passed = false;
    failReason = `bathrooms < 2 (${listing.bathrooms})`;
  }
  // 4. Year Built >= 1950
  else if (listing.yearBuilt != null && listing.yearBuilt < 1950) {
    passed = false;
    failReason = `year built < 1950 (${listing.yearBuilt})`;
  }
  // 5. Exclude HOA, 55+, New Construction, Auctions, Foreclosures, Short Sales
  else {
    const haystack = [listing.title, listing.description, listing.address].join(" ").toLowerCase();

    // Property Type constraint (Single Family Home or Multi-Family only) -> exclude condo/townhouse/mobile/land/lot
    // Use word boundaries so "Woodland" or "1 acre lot" don't false-positive
    const propertyTypeRe = /\b(condo|townhouse|townhome|mobile home|manufactured|mobile|vacant land|bare land|lot only)\b/i;
    if (propertyTypeRe.test(haystack)) {
      passed = false;
      failReason = "property type (not SFH/Multi)";
    }
    else if (haystack.includes("hoa") || haystack.includes("homeowners association") || haystack.includes("home owner association") || haystack.includes("home owner's association") || haystack.includes("homeowner's association")) {
      passed = false;
      failReason = "has HOA";
    }
    else if (haystack.includes("55+") || haystack.includes("55 and older") || haystack.includes("active adult") || haystack.includes("senior community")) {
      passed = false;
      failReason = "55+ community";
    }
    else if (haystack.includes("new construction") || haystack.includes("to be built") || haystack.includes("under construction") || haystack.includes("pre-construction")) {
      passed = false;
      failReason = "new construction";
    }
    else if (haystack.includes("auction")) {
      passed = false;
      failReason = "auction";
    }
    else if (haystack.includes("foreclosure") || haystack.includes("reo ") || haystack.includes("bank owned")) {
      passed = false;
      failReason = "foreclosure";
    }
    else if (haystack.includes("short sale")) {
      passed = false;
      failReason = "short sale";
    }
  }

  // Diagnostic logging for first N listings
  if (_criteriaDiagCount < DIAGNOSTIC_LOG_LIMIT) {
    _criteriaDiagCount++;
    logger.info(
      `[adu-filter] CRITERIA [${_criteriaDiagCount}] ` +
      `${passed ? "✓ PASS" : "✗ FAIL"} | ` +
      `reason="${failReason}" | ` +
      `price=${listing.price} beds=${listing.bedrooms} baths=${listing.bathrooms} year=${listing.yearBuilt} dom=${listing.daysOnMarket} status=${listing.status}`
    );
  }

  return passed;
}

/**
 * Combined filter: location + criteria + keyword (backward compatible).
 * Use passesLocationFilter + passesPropertyCriteria + passesKeywordFilter separately when
 * you need to inspect the intermediate set.
 */
export function passesAduFilter(listing: AduResearchListing): boolean {
  return passesLocationFilter(listing) && passesPropertyCriteria(listing) && passesKeywordFilter(listing);
}

// ── Scraper ──────────────────────────────────────────────────────────────────

export class AduResearchScraper extends BaseScraper {
  readonly sourceName: string = "investorlift-adu";

  /** Collected ADU-matching listings (extended type) */
  private aduListings: AduResearchListing[] = [];

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  // Always connect direct — InvestorLift blocks proxy headers
  protected getEffectiveProxy(): string | null {
    logger.info("[adu-research] Proxy disabled — connecting direct");
    return null;
  }

  // ── Filter overrides ────────────────────────────────────────────────────

  /**
   * Override base passesFilter: use ADU keyword + state matching
   * instead of price/location filtering.
   */
  protected passesFilter(listing: RawListing): boolean {
    // Return only location-filtered listings, the runner will do keyword filtering
    return passesLocationFilter(listing as AduResearchListing);
  }

  /**
   * Override base isRelevant: always true since keyword matching
   * is already done in passesFilter().
   */
  protected isRelevant(_listing: RawListing): boolean {
    return true;
  }

  // ── Session helpers ────────────────────────────────────────────────────

  private sessionExists(): boolean {
    try {
      if (!fs.existsSync(SESSION_FILE)) return false;
      const state = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      return Array.isArray(state.cookies) && state.cookies.length > 0;
    } catch {
      return false;
    }
  }

  private async isSessionValid(): Promise<boolean> {
    const browser = await this.launchBrowser();
    try {
      const context = await browser.newContext({
        storageState: SESSION_FILE,
        userAgent: USER_AGENT,
      });
      const page = await context.newPage();
      try {
        logger.info("[adu-research] Validating saved session…");
        await page.goto(MARKETPLACE_URL, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });

        const result = await page.evaluate(async (url: string) => {
          try {
            const r = await fetch(url, { credentials: "include" });
            const body = await r.json().catch(() => null);
            return { status: r.status, hasData: !!(body?.data?.length) };
          } catch {
            return { status: 0, hasData: false };
          }
        }, `${PROPERTIES_API_URL}?per_page=1`);

        logger.info(
          `[adu-research] Session check — HTTP ${result.status}, hasData: ${result.hasData}`,
        );
        return result.status === 200 && result.hasData;
      } finally {
        await page.close();
        await context.close();
      }
    } catch (err) {
      logger.warn(`[adu-research] Session validation error: ${err}`);
      return false;
    } finally {
      await browser.close();
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionExists()) {
      const valid = await this.isSessionValid();
      if (valid) {
        logger.info("[adu-research] Session is valid");
      } else {
        logger.warn("[adu-research] Session validation failed or timed out — keeping file to try anyway");
      }
      return;
    } else {
      logger.info("[adu-research] No session file found");
    }

    throw new SessionExpiredError();
  }

  // ── Browser factory ────────────────────────────────────────────────────

  private async launchBrowser(): Promise<Browser> {
    return chromium.launch({
      headless: true,
      args: CHROMIUM_ARGS,
    });
  }

  // ── Address enrichment ─────────────────────────────────────────────────

  private buildCookieHeader(): string | null {
    try {
      if (!fs.existsSync(SESSION_FILE)) return null;
      const state = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      const cookies = (state.cookies ?? []) as Array<{ name: string; value: string }>;
      if (cookies.length === 0) return null;
      return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    } catch (err) {
      logger.warn(`[adu-research] Could not read session cookies: ${err}`);
      return null;
    }
  }

  private async fetchFullAddress(listingId: string): Promise<string | undefined> {
    const cookieHeader = this.buildCookieHeader();
    if (!cookieHeader) {
      logger.warn("[adu-research] No session cookies — cannot fetch address");
      return undefined;
    }

    let text: string;
    let status: number;
    try {
      const response = await axios.post(ADDRESS_INQUIRY_URL, 
        JSON.stringify({ property_id: listingId, type: "address_request" }),
        {
          headers: {
            ...BASE_HEADERS,
            "Content-Type": "text/plain;charset=UTF-8",
            "Referer": `https://investorlift.com/marketplace/deal/${listingId}`,
            "Cookie": cookieHeader,
          },
          validateStatus: () => true // Resolve for all status codes
        }
      );
      status = response.status;
      text = response.data;
    } catch (err: any) {
      logger.warn(`[adu-research] Network error fetching address for ${listingId}: ${err.message}`);
      return undefined;
    }

    if (status !== 200) {
      logger.warn(
        `[adu-research] Address inquiry returned HTTP ${status} for ${listingId}`,
      );
      return undefined;
    }

    const address = text.trim().replace(/^"|"$/g, "");

    if (address.includes(ADDRESS_LIMIT_SENTINEL)) {
      throw new DailyLimitReachedError();
    }

    if (!address) {
      logger.warn(`[adu-research] Empty address returned for ${listingId}`);
      return undefined;
    }

    logger.debug(`[adu-research] Address for ${listingId}: ${address}`);
    return address;
  }

  private async fetchFullDetails(listingId: string): Promise<any> {
    const cookieHeader = this.buildCookieHeader();
    if (!cookieHeader) return null;

    try {
      const response = await axios.get(`https://investorlift.com/marketplace/api/customer/api/properties/${listingId}`, {
        headers: {
          ...BASE_HEADERS,
          "Cookie": cookieHeader,
        },
      });
      return response.data;
    } catch (err: any) {
      logger.warn(`[adu-research] Network error fetching details for ${listingId}: ${err.message}`);
    }
    return null;
  }

  // ── Post-filter enrichment ─────────────────────────────────────────────

  protected async enrichAfterFilter(listings: RawListing[]): Promise<RawListing[]> {
    if (listings.length === 0) return listings;

    logger.info(
      `[adu-research] Enriching ${listings.length} candidate listings with descriptions for keyword filtering...`,
    );

    const result:       RawListing[] = [];
    let   fetchedAddressCount        = 0;
    let   addressLimitReached        = false;
    let   descFetchCount             = 0;

    for (let i = 0; i < listings.length; i++) {
      const listing = { ...listings[i] } as AduResearchListing;
      const listingId = extractListingId(listing.url);

      if (listingId) {
        const details = await this.fetchFullDetails(listingId);
        if (details) {
          if (details.description) {
            listing.description = details.description.replace(/<[^>]*>?/gm, ' ');
            descFetchCount++;
          }
          if (details.year_built && !listing.yearBuilt) {
            listing.yearBuilt = Number(details.year_built);
          }
          if (details.units && !listing.units) {
            listing.units = Number(details.units);
          }
          if (!listing.ownerName) {
            listing.ownerName = details.dispositions_manager?.name || details.account?.title;
          }
          if (!listing.bedrooms && details.bedrooms) {
            listing.bedrooms = Number(details.bedrooms);
          }
          if (!listing.bathrooms && details.bathrooms) {
            listing.bathrooms = Number(details.bathrooms);
          }
          if (!listing.squareFeet && details.sq_footage) {
            listing.squareFeet = Number(details.sq_footage);
          }
          if (!listing.lotSqft && details.lot_size) {
            listing.lotSqft = Number(details.lot_size);
          }

          // ── Detail API enrichment ──────────────────────────────────────
          if (!listing.arvEstimate && details.arv_estimate != null) {
            listing.arvEstimate = Number(details.arv_estimate);
          }
          if (!listing.arvPercentage && details.arv_percentage != null) {
            listing.arvPercentage = Number(details.arv_percentage);
          }
          if (!listing.grossMargin && details.gross_margin != null) {
            listing.grossMargin = Number(details.gross_margin);
          }
          if (!listing.views && details.views != null) {
            listing.views = Number(details.views);
          }
          if (!listing.entryFee && details.entry_fee != null) {
            listing.entryFee = Number(details.entry_fee);
          }
          if (!listing.propertyTypeId && details.property_type_id != null) {
            listing.propertyTypeId = Number(details.property_type_id);
          }
          if (!listing.parkingTypeId && details.parking_type_id != null) {
            listing.parkingTypeId = Number(details.parking_type_id);
          }
          if (!listing.publishedAt && details.published_at) {
            listing.publishedAt = details.published_at;
          }
          if (!listing.latitude && details.latitude != null) {
            listing.latitude = Number(details.latitude);
          }
          if (!listing.longitude && details.longitude != null) {
            listing.longitude = Number(details.longitude);
          }
          if (!listing.tags && details.tags) {
            listing.tags = details.tags;
          }
          if (!listing.isVerified && details.is_verified != null) {
            listing.isVerified = Boolean(details.is_verified);
          }

          // ── Detail-only API fields ────────────────────────────────────
          if (!listing.buyNowPrice && details.buy_now_price != null) {
            listing.buyNowPrice = Number(details.buy_now_price);
          }
          if (!listing.repairEstimateMin && details.repair_estimate_min != null) {
            listing.repairEstimateMin = Number(details.repair_estimate_min);
          }
          if (!listing.repairEstimateMax && details.repair_estimate_max != null) {
            listing.repairEstimateMax = Number(details.repair_estimate_max);
          }
          if (!listing.occupancy && details.occupancy?.value) {
            listing.occupancy = details.occupancy.value;
          }
          if (!listing.condition && details.condition?.value) {
            listing.condition = details.condition.value;
          }
          if (!listing.halfBathrooms && details.half_bathrooms != null) {
            listing.halfBathrooms = Number(details.half_bathrooms);
          }
          if (!listing.lotSizeUnit && details.lot_size_unit) {
            listing.lotSizeUnit = details.lot_size_unit;
          }
          if (!listing.accountType && details.account?.account_type) {
            listing.accountType = details.account.account_type;
          }
          if (!listing.expiresAt && details.expires_at) {
            listing.expiresAt = details.expires_at;
          }
          if (!listing.publicAddress && details.public_address) {
            listing.publicAddress = details.public_address;
          }
          if (!listing.propertyPageUrl && details.property_page_url) {
            listing.propertyPageUrl = details.property_page_url;
          }
        }
        await sleep(400); // small delay to avoid spamming the API
      }

      // 2. Now run keyword filter (requires description)
      if (!passesKeywordFilter(listing)) {
        continue; // drop it if it doesn't match any ADU keywords
      }

      // Set matchedKeyword for traceability (passesKeywordFilter doesn't mutate)
      if (!listing.matchedKeyword) {
        const kHaystack = [listing.title, listing.description, listing.address].join(" ").toLowerCase();
        listing.matchedKeyword = ADU_KEYWORDS.find((kw) => {
          const regex = new RegExp(`\\b${kw}\\b`, 'i');
          return regex.test(kHaystack);
        });
      }

      // 3. Fetch full address for keyword-matched listings
      if (listingId && !addressLimitReached && fetchedAddressCount < ADDRESS_FETCH_LIMIT) {
        try {
          const fullAddress = await this.fetchFullAddress(listingId);
          if (fullAddress) {
            listing.address = fullAddress;
            fetchedAddressCount++;
          }
          await sleep(ADDRESS_REQUEST_DELAY);
        } catch (err) {
          if (err instanceof DailyLimitReachedError) {
            logger.warn(
              `[adu-research] Daily address limit reached after ${fetchedAddressCount} fetches`,
            );
            addressLimitReached = true;
          } else {
            logger.warn(`[adu-research] Address fetch failed for ${listingId}: ${err}`);
          }
        }
      }

      // Final match — passes location + criteria + keyword!
      logger.info(
        `[adu-research] ✓ MATCH #${result.length + 1}: ${listing.address || listing.url} | keyword="${listing.matchedKeyword ?? ''}"`,
      );
      result.push(listing);
      if (this.options.onMatch) await this.options.onMatch(listing);
    }

    logger.info(
      `[adu-research] Enrichment done — ${descFetchCount} descriptions fetched, ${fetchedAddressCount} addresses fetched, ${result.length} listings passed all filters`,
    );
    return result;
  }

  // ── Main scrape ────────────────────────────────────────────────────────

  async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting ADU scrape`);
    this.results = [];
    const handle = {} as any; // mock handle since we use Playwright
    try {
      this.results = await this.scrapePage(handle, 1);
      this.results = await this.enrichAfterFilter(this.results);
    } catch (err: any) {
      if (err.name === "SessionExpiredError") throw err;
      logger.error(`[${this.sourceName}] Scrape failed: ${err}`);
    }
    return this.results;
  }

  protected async scrapePage(
    _handle: BrowserHandle,
    pageNumber: number,
  ): Promise<RawListing[]> {
    // InvestorLift is not paginated — skip page 2+
    if (pageNumber > 1) {
      logger.info("[adu-research] Non-paginated source — skipping page 2+");
      return [];
    }

    // Validate session
    await this.ensureSession();

    const browser = await this.launchBrowser();
    try {
      const context = await browser.newContext({
        storageState: SESSION_FILE,
        userAgent: USER_AGENT,
      });

      const page = await context.newPage();

      try {
        logger.info("[adu-research] Loading marketplace to pass Cloudflare…");
        try {
          await page.goto(MARKETPLACE_URL, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
        } catch (gotoErr) {
          logger.warn(`[adu-research] page.goto failed or timed out: ${gotoErr} — continuing anyway`);
        }

        // Guard: session expiry / bot detection
        const landedUrl = page.url();
        const pageTitle = (await page.title()).toLowerCase();

        if (
          landedUrl.includes("/login") ||
          landedUrl.includes("/signin") ||
          pageTitle.includes("sign in") ||
          pageTitle.includes("log in")
        ) {
          logger.warn("[adu-research] Redirected to login — session expired");
          fs.unlinkSync(SESSION_FILE);
          throw new SessionExpiredError();
        }

        if (
          pageTitle.includes("access denied") ||
          pageTitle.includes("captcha") ||
          pageTitle.includes("just a moment") ||
          landedUrl.includes("challenge") ||
          landedUrl.includes("blocked")
        ) {
          logger.error("[adu-research] IP blocked or CAPTCHA challenge detected");
          return [];
        }

        logger.info(`[adu-research] Landed on: ${landedUrl}`);

        logger.info("[adu-research] Fetching properties directly via API...");
        const cookies = await context.cookies();
        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join("; ");
        
        let json: any;
        try {
          const resp = await axios.get(PROPERTIES_API_URL, {
            headers: {
              ...BASE_HEADERS,
              Cookie: cookieStr,
            },
            maxContentLength: Infinity,
            maxBodyLength: Infinity,
          });
          json = resp.data;
        } catch (err: any) {
          logger.error(`[adu-research] Axios fetch failed: ${err.message}`);
          return [];
        }

        try {
          fs.mkdirSync(DEBUG_DIR, { recursive: true });
          fs.writeFileSync(
            path.join(DEBUG_DIR, `il_adu_raw_response_full.json`),
            JSON.stringify(json, null, 2),
            "utf-8"
          );
        } catch (saveErr) {}

        const parsed = parseAduApiResponse(json, this.sourceName);
        logger.info(`[adu-research] Fetched ${parsed.length} total listings from API.`);

        // ── Sort by publishedAt ascending (oldest first) ──────────────
        parsed.sort((a, b) => {
          const dateA = a.publishedAt ?? "";
          const dateB = b.publishedAt ?? "";
          return dateA.localeCompare(dateB); // ascending
        });
        logger.info(`[adu-research] Sorted listings oldest-first. Oldest: ${parsed[0]?.publishedAt ?? "N/A"}, Newest: ${parsed[parsed.length - 1]?.publishedAt ?? "N/A"}`);

        // ── Load previously seen listing IDs ────────────────────────────
        const previouslySeen = await loadSeenFromDb(this.sourceName);
        const allSeenIds = new Set(previouslySeen); 

        const seenUrls: Set<string> = new Set();
        const apiListings: AduResearchListing[] = [];
        const rawStateCounts: Map<string, number> = new Map();
        
        let skippedAsSeen = 0;
        let processedThisBatch = 0;
        let oldestInBatch = "N/A";
        let newestInBatch = "N/A";

        for (const listing of parsed) {
          if (!listing.url || seenUrls.has(listing.url)) continue;
          seenUrls.add(listing.url);

          // Extract the listing ID from the URL
          const listingId = extractListingId(listing.url);

          // Skip if already processed in a previous backfill run
          if (listingId && previouslySeen.has(listingId)) {
            skippedAsSeen++;
            continue;
          }

          if (oldestInBatch === "N/A") oldestInBatch = listing.publishedAt ?? "N/A";
          newestInBatch = listing.publishedAt ?? "N/A";

          // Process this new listing
          processedThisBatch++;
          if (listingId) allSeenIds.add(listingId);

          if (passesLocationFilter(listing)) {
            const addressUpper = (listing.address ?? "").toUpperCase();
            const stateUpper = (listing.state ?? "").toUpperCase();
            const matchedState = TARGET_STATES.find((s) =>
              addressUpper.includes(`, ${s}`) || stateUpper === s
            ) ?? "UNKNOWN";

            const stateCount = rawStateCounts.get(matchedState) || 0;
            if (stateCount < this.options.maxListings) {
              rawStateCounts.set(matchedState, stateCount + 1);

              if (passesPropertyCriteria(listing)) {
                apiListings.push(listing);
              }
            }
          }

          // Stop if we hit the batch limit
          if (processedThisBatch >= BACKFILL_BATCH_SIZE) {
             logger.info(`[adu-research] Reached backfill batch limit of ${BACKFILL_BATCH_SIZE}. Stopping processing.`);
             break;
          }
        }

        // ── Save updated tracker to DB ─────────────────────────────
        await saveSeenToDb(this.sourceName, allSeenIds, processedThisBatch);
        logger.info(`[adu-research] Batch date range: ${oldestInBatch} to ${newestInBatch}`);

        // Log results
        logger.info(`[adu-research] Processed ${processedThisBatch} new listings, skipped ${skippedAsSeen} already-seen`);
        if (apiListings.length > 0) {
          logger.info(`[adu-research] ${apiListings.length} NEW passing ADU listings collected via API`);
          for (const [state, count] of rawStateCounts.entries()) {
            logger.info(`[adu-research] Raw listings scanned for ${state}: ${count}/${this.options.maxListings}`);
          }
        } else {
          logger.warn("[adu-research] No new matching listings collected");
        }

        return apiListings;
      } finally {
        await page.close();
        await context.close();
      }
    } finally {
      await browser.close();
    }
  }

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= 1;
  }


  // ── Debug helpers ──────────────────────────────────────────────────────

  private saveDebugHtml(html: string, label: string): void {
    try {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(DEBUG_DIR, `adu-research_${label}.html`),
        html,
      );
      logger.info(`[adu-research] Debug HTML saved: logs/adu-research_${label}.html`);
    } catch { }
  }
}
