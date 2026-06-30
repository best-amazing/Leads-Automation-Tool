// src/scrapers/property-purchase-research/adu-research.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// ADU Property Purchase Research Scraper
//
// Extends the existing InvestorLiftScraper to:
//   1. Replace price/location passesFilter() with keyword-based ADU matching
//   2. Match listings across target states (OH, IN, WI, IA, IL)
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

const MARKETPLACE_URL    = "https://investorlift.com/marketplace/";
const PROPERTIES_API_URL = "https://investorlift.com/marketplace/api/customer/api/properties";
const ADDRESS_INQUIRY_URL = "https://investorlift.com/marketplace/api/customer/api/inquiry";

const ADDRESS_LIMIT_SENTINEL = "You have reached the daily address request limit";
const ADDRESS_FETCH_LIMIT    = 5;
const ADDRESS_REQUEST_DELAY  = 800;

const SESSION_FILE = path.join(__dirname, "../../..", "investorlift-session.json");
const DEBUG_DIR    = path.resolve("logs");

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": USER_AGENT,
  "Origin":     "https://investorlift.com",
  "Referer":    "https://investorlift.com/marketplace/",
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

// ── ADU Filter ──────────────────────────────────────────────────────────────

/**
 * Check if a listing matches the ADU research criteria:
 *   1. Located in one of TARGET_STATES
 *   2. Contains at least one ADU_KEYWORD in title/description/address
 */
export function passesAduFilter(listing: AduResearchListing): boolean {
  const haystack = [listing.title, listing.description, listing.address]
    .join(" ")
    .toLowerCase();

  // Check state — match ", OH", ", IN", etc. at end of address
  const inTargetState = TARGET_STATES.some((s) =>
    listing.address?.toUpperCase().includes(`, ${s}`) ||
    listing.state?.toUpperCase() === s
  );

  if (!inTargetState) return false;

  // Check keywords
  const hasKeyword = ADU_KEYWORDS.some((kw) =>
    haystack.includes(kw.toLowerCase()),
  );

  return hasKeyword;
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
    return passesAduFilter(listing as AduResearchListing);
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
        userAgent:    USER_AGENT,
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
            const r    = await fetch(url, { credentials: "include" });
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
        return;
      }
      logger.warn("[adu-research] Session invalid — deleting stale session file");
      fs.unlinkSync(SESSION_FILE);
    } else {
      logger.info("[adu-research] No session file found");
    }

    throw new SessionExpiredError();
  }

  // ── Browser factory ────────────────────────────────────────────────────

  private async launchBrowser(): Promise<Browser> {
    return chromium.launch({
      headless: true,
      args:     CHROMIUM_ARGS,
    });
  }

  // ── Address enrichment ─────────────────────────────────────────────────

  private buildCookieHeader(): string | null {
    try {
      if (!fs.existsSync(SESSION_FILE)) return null;
      const state   = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
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
        method:  "POST",
        headers: {
          ...BASE_HEADERS,
          "Content-Type": "text/plain;charset=UTF-8",
          "Referer":      `https://investorlift.com/marketplace/deal/${listingId}`,
          "Cookie":       cookieHeader,
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

    const text    = await response.text();
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

  // ── Post-filter enrichment ─────────────────────────────────────────────

  protected async enrichAfterFilter(listings: RawListing[]): Promise<RawListing[]> {
    if (listings.length === 0) return listings;

    logger.info(
      `[adu-research] Enriching up to ${ADDRESS_FETCH_LIMIT} of ${listings.length} matched listings with addresses`,
    );

    const result:       RawListing[] = [];
    let   fetchedCount               = 0;
    let   limitReached               = false;

    for (let i = 0; i < listings.length; i++) {
      const listing = { ...listings[i] };

      if (limitReached || fetchedCount >= ADDRESS_FETCH_LIMIT) {
        result.push(listing);
        continue;
      }

      const listingId = extractListingId(listing.url);
      if (!listingId) {
        result.push(listing);
        continue;
      }

      try {
        const fullAddress = await this.fetchFullAddress(listingId);
        if (fullAddress) {
          listing.address = fullAddress;
          fetchedCount++;
        }
        result.push(listing);
        await sleep(ADDRESS_REQUEST_DELAY);
      } catch (err) {
        if (err instanceof DailyLimitReachedError) {
          logger.warn(
            `[adu-research] Daily address limit reached after ${fetchedCount} fetches`,
          );
          limitReached = true;
          result.push(listing);
          continue;
        }
        logger.warn(`[adu-research] Address fetch failed for ${listingId}: ${err}`);
        result.push(listing);
      }
    }

    logger.info(
      `[adu-research] Enrichment done — ${fetchedCount} addresses fetched, ${result.length} listings total`,
    );
    return result;
  }

  // ── Main scrape ────────────────────────────────────────────────────────

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
        userAgent:    USER_AGENT,
      });

      const page = await context.newPage();

      const seenUrls:       Set<string>              = new Set();
      const apiListings:    AduResearchListing[]     = [];
      const pendingParses:  Promise<void>[]          = [];

      // Intercept all /api/customer/api/properties XHR responses
      // — use ADU parser to capture description + extended fields
      page.on("response", (response) => {
        if (!response.url().includes("/api/customer/api/properties")) return;
        logger.debug(`[adu-research] XHR intercepted: ${response.url()}`);

        const p = response
          .json()
          .then((json) => {
            const parsed = parseAduApiResponse(json, this.sourceName);
            if (parsed.length > 0) {
              logger.info(
                `[adu-research] ${parsed.length} listings from ${response.url()}`,
              );
            }
            for (const listing of parsed) {
              if (!listing.url || seenUrls.has(listing.url)) continue;
              seenUrls.add(listing.url);
              apiListings.push(listing);
            }
          })
          .catch((err) => {
            logger.debug(`[adu-research] XHR parse error from ${response.url()}: ${err}`);
          });

        pendingParses.push(p);
      });

      try {
        logger.info("[adu-research] Loading marketplace…");
        await page.goto(MARKETPLACE_URL, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });

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

        // Scroll to trigger additional XHRs
        if (apiListings.length === 0) {
          logger.info("[adu-research] No listings yet — scrolling to trigger XHR");
          for (let i = 0; i < 5; i++) {
            await page.mouse.wheel(0, 5000);
            await sleep(2500);
          }
          await sleep(3000);
          await Promise.allSettled(pendingParses);
        }

        // Log results
        if (apiListings.length > 0) {
          logger.info(`[adu-research] ${apiListings.length} total listings collected via XHR`);

          // Pre-filter stats for debugging
          const withDescription = apiListings.filter(
            (l) => l.description && l.description.length > 10,
          ).length;
          logger.info(
            `[adu-research] ${withDescription}/${apiListings.length} listings have description text`,
          );
        } else {
          logger.warn("[adu-research] No XHR data captured — check session");
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
    } catch {}
  }
}
