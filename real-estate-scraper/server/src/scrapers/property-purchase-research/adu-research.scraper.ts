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

import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
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

const SESSION_FILE = path.join(__dirname, "../../..", "investorlift-session.json");
const DEBUG_DIR = path.resolve("logs");

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
    const regex = new RegExp(`\\b${s}\\b`);
    return regex.test(addressUpper);
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

    // Property Type constraint (Single Family Home or Multi-Family only) -> exclude condo/townhouse/mobile/land
    if (haystack.includes("condo") || haystack.includes("townhouse") || haystack.includes("townhome") || haystack.includes("mobile") || haystack.includes("manufactured") || haystack.includes("land") || haystack.includes("lot")) {
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
      `price=${listing.price} beds=${listing.bedrooms} baths=${listing.bathrooms} year=${listing.yearBuilt}`
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
  readonly sourceName = "adu-research";

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
        }, `${PROPERTIES_API_URL}?status=available&per_page=1`);

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

    let response: Response;
    try {
      response = await fetch(ADDRESS_INQUIRY_URL, {
        method: "POST",
        headers: {
          ...BASE_HEADERS,
          "Content-Type": "text/plain;charset=UTF-8",
          "Referer": `https://investorlift.com/marketplace/deal/${listingId}`,
          "Cookie": cookieHeader,
        },
        body: JSON.stringify({ property_id: listingId, type: "address_request" }),
      });
    } catch (err) {
      logger.warn(`[adu-research] Network error fetching address for ${listingId}: ${err}`);
      return undefined;
    }

    if (!response.ok) {
      logger.warn(
        `[adu-research] Address inquiry returned HTTP ${response.status} for ${listingId}`,
      );
      return undefined;
    }

    const text = await response.text();
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
      const response = await fetch(`https://investorlift.com/marketplace/api/customer/api/properties/${listingId}`, {
        headers: {
          ...BASE_HEADERS,
          "Cookie": cookieHeader,
        },
      });
      if (response.ok) {
        return await response.json();
      }
    } catch (err) {
      logger.warn(`[adu-research] Network error fetching details for ${listingId}: ${err}`);
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

      // 1. Fetch the full description from the individual property API
      if (listingId) {
        const details = await this.fetchFullDetails(listingId);
        if (details?.description) {
          // Strip HTML tags for clean keyword matching
          listing.description = details.description.replace(/<[^>]*>?/gm, ' ');
          descFetchCount++;
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

      const seenUrls: Set<string> = new Set();
      const apiListings: AduResearchListing[] = [];
      const rawStateCounts: Map<string, number> = new Map();
      const pendingParses: Promise<void>[] = [];
      let rawSaveCount = 0;

      // Intercept all /api/customer/api/properties XHR responses
      // — use ADU parser to capture description + extended fields
      page.on("response", (response) => {
        if (!response.url().includes("/api/customer/api/properties")) return;
        logger.debug(`[adu-research] XHR intercepted: ${response.url()}`);

        const p = response
          .json()
          .then((json) => {
            // ── Save raw XHR payload for inspection ──────────────────────────
            // Open logs/il_adu_raw_response_<n>.json to see EVERY field
            // the InvestorLift API returns — look for description/overview/
            // remarks/body/details that the parser may currently be missing.
            if (rawSaveCount < MAX_RAW_SAVES) {
              const saveIndex = ++rawSaveCount;
              try {
                fs.mkdirSync(DEBUG_DIR, { recursive: true });
                const filename = path.join(
                  DEBUG_DIR,
                  `il_adu_raw_response_${saveIndex}.json`,
                );
                fs.writeFileSync(filename, JSON.stringify(json, null, 2), "utf-8");
                logger.info(
                  `[adu-research] Raw XHR saved → logs/il_adu_raw_response_${saveIndex}.json`,
                );
              } catch (saveErr) {
                logger.warn(`[adu-research] Could not save raw XHR: ${saveErr}`);
              }
            }
            // ─────────────────────────────────────────────────────────────────

            const parsed = parseAduApiResponse(json, this.sourceName);
            if (parsed.length > 0) {
              logger.info(
                `[adu-research] ${parsed.length} listings from ${response.url()}`,
              );
            }
            for (const listing of parsed) {
              if (!listing.url || seenUrls.has(listing.url)) continue;
              seenUrls.add(listing.url);

              if (passesLocationFilter(listing)) {
                // Determine which target state it matched
                const addressUpper = (listing.address ?? "").toUpperCase();
                const stateUpper = (listing.state ?? "").toUpperCase();
                const matchedState = TARGET_STATES.find((s) =>
                  addressUpper.includes(`, ${s}`) || stateUpper === s
                ) ?? "UNKNOWN";

                const stateCount = rawStateCounts.get(matchedState) || 0;

                // Track RAW listings per state, stop at maxListings
                if (stateCount < this.options.maxListings) {
                  rawStateCounts.set(matchedState, stateCount + 1);

                  // Filter by criteria only inline - keyword filtering happens later after description fetch
                  if (passesPropertyCriteria(listing)) {
                    apiListings.push(listing);
                  }
                }
              }
            }
          })
          .catch((err) => {
            logger.debug(`[adu-research] XHR parse error from ${response.url()}: ${err}`);
          });

        pendingParses.push(p);
      });

      try {
        logger.info("[adu-research] Loading marketplace…");
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

        // Wait for first XHR
        try {
          await page.waitForResponse(
            (r) =>
              r.url().includes("/api/customer/api/properties") &&
              r.status() === 200,
            { timeout: 15_000 },
          );
          logger.info("[adu-research] Properties XHR received");
        } catch {
          logger.warn("[adu-research] XHR timeout — scrolling to trigger lazy load");
        }

        await sleep(2000);
        await Promise.allSettled(pendingParses);

        // Scroll to load more listings from InvestorLift
        logger.info("[adu-research] Scrolling to load more listings...");

        const MAX_SCROLLS = 50;
        let consecutiveEmptyScrolls = 0;
        const MAX_EMPTY_SCROLLS = 3;

        for (let scrollIdx = 0; scrollIdx < MAX_SCROLLS; scrollIdx++) {
          const prevCount = seenUrls.size;

          await page.mouse.wheel(0, 8000);
          await sleep(2500);
          await Promise.allSettled(pendingParses);

          if (seenUrls.size === prevCount) {
            consecutiveEmptyScrolls++;
            if (consecutiveEmptyScrolls >= MAX_EMPTY_SCROLLS) {
              logger.info(`[adu-research] No new listings after ${MAX_EMPTY_SCROLLS} scrolls. Stopping.`);
              break;
            }
          } else {
            consecutiveEmptyScrolls = 0;
          }

          // Stop if all target states have hit maxListings
          let totalRawScanned = 0;
          for (const count of rawStateCounts.values()) {
            totalRawScanned += count;
          }
          if (totalRawScanned >= TARGET_STATES.length * this.options.maxListings) {
            logger.info("[adu-research] Reached maxListings for all target states. Stopping scroll.");
            break;
          }

          logger.info(
            `[adu-research] Scroll ${scrollIdx + 1}/${MAX_SCROLLS} — ${seenUrls.size} unique listings seen, ${apiListings.length} candidates collected`,
          );
        }

        // Log results
        if (apiListings.length > 0) {
          logger.info(`[adu-research] ${apiListings.length} total passing ADU listings collected via XHR`);
          for (const [state, count] of rawStateCounts.entries()) {
            logger.info(`[adu-research] Raw listings scanned for ${state}: ${count}/${this.options.maxListings}`);
          }
        } else {
          logger.warn("[adu-research] No matching listings collected");
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
