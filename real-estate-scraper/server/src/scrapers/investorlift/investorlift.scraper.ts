// src/scrapers/investorlift/investorlift.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// InvestorLift marketplace scraper
//
// Authentication:
//   InvestorLift's login button does not fire in sandboxed Chromium, so we
//   rely on a manually exported session file (investorlift-session.json).
//
//   To export your session:
//     1. Log in to https://investorlift.com/marketplace/ in your real browser
//     2. Run:  npm run session:investorlift
//        (or:  node scripts/export-investorlift-session.js)
//     3. Follow the on-screen instructions — the script saves the session file
//
//   The session is valid for ~30 days. Re-export when it expires.
//
// Data flow:
//   • Playwright loads the marketplace with the saved session cookies
//   • Crexi's Angular-like app fires XHR to /api/customer/api/properties
//   • We intercept those responses and parse them via parseApiResponse()
//   • After location/price filtering in the base runner, enrichAfterFilter()
//     fetches full street-level addresses for the top 5 results via the
//     inquiry API (rate-limited to 5/day by InvestorLift)
//
// NOTE on proxy:
//   InvestorLift detects proxy headers and blocks them. This scraper always
//   connects direct, overriding any global proxy config.
//
// NOTE on headless mode:
//   playwright-extra's stealth plugin patches the global chromium launcher
//   which can force headed mode on subsequent chromium.launch() calls from
//   other scrapers. We guard against this by passing --headless=new explicitly
//   in every launch() call and importing chromium from "playwright" directly
//   (not from "playwright-extra").
// ─────────────────────────────────────────────────────────────────────────────

import { chromium, BrowserContext, Page, Browser } from "playwright";
import * as fs from "fs";
import * as path from "path";

import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { parseApiResponse, parseDomListings } from "./investorlift.parser";

// ── Constants ──────────────────────────────────────────────────────────────

const MARKETPLACE_URL     = "https://investorlift.com/marketplace/";
const PROPERTIES_API_URL  = "https://investorlift.com/marketplace/api/customer/api/properties";
const ADDRESS_INQUIRY_URL = "https://investorlift.com/marketplace/api/customer/api/inquiry";

const ADDRESS_LIMIT_SENTINEL = "You have reached the daily address request limit";
const ADDRESS_FETCH_LIMIT    = 5;   // InvestorLift rate-limits address lookups per day
const ADDRESS_REQUEST_DELAY  = 800; // ms between address requests

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

/**
 * Chromium launch args shared by every launch() call in this file.
 * --headless=new is explicit to guard against playwright-extra stealth plugin
 * accidentally forcing headed mode via its global chromium patches.
*/
const CHROMIUM_ARGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu"
  // "--no-zygote",
  // "--single-process",
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

// ── Scraper ──────────────────────────────────────────────────────────────────

export class InvestorLiftScraper extends BaseScraper {
  readonly sourceName = "investorlift";

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  // Always connect direct — InvestorLift blocks proxy headers
  protected getEffectiveProxy(): string | null {
    logger.info("[investorlift] Proxy disabled — connecting direct");
    return null;
  }

  // ── Session helpers ────────────────────────────────────────────────────────

  private sessionExists(): boolean {
    try {
      if (!fs.existsSync(SESSION_FILE)) return false;
      const state = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      return Array.isArray(state.cookies) && state.cookies.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Validate the saved session by hitting the properties API with a
   * 1-item request. Uses a temporary browser so cookies are sent correctly.
   */
  private async isSessionValid(): Promise<boolean> {
    const browser = await this.launchBrowser();
    try {
      const context = await browser.newContext({
        storageState: SESSION_FILE,
        userAgent:    USER_AGENT,
      });
      const page = await context.newPage();
      try {
        logger.info("[investorlift] Validating saved session…");
        await page.goto(MARKETPLACE_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });

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
          `[investorlift] Session check — HTTP ${result.status}, hasData: ${result.hasData}`
        );
        return result.status === 200 && result.hasData;
      } finally {
        await page.close();
        await context.close();
      }
    } catch (err) {
      logger.warn(`[investorlift] Session validation error: ${err}`);
      return false;
    } finally {
      await browser.close();
    }
  }

  /**
   * Ensure a valid session file exists. Throws SessionExpiredError with
   * clear instructions if the session is missing or stale.
   */
  private async ensureSession(): Promise<void> {
    if (this.sessionExists()) {
      const valid = await this.isSessionValid();
      if (valid) {
        logger.info("[investorlift] Session is valid");
        return;
      }
      logger.warn("[investorlift] Session invalid — deleting stale session file");
      fs.unlinkSync(SESSION_FILE);
    } else {
      logger.info("[investorlift] No session file found");
    }

    throw new SessionExpiredError();
  }

  // ── Browser factory ────────────────────────────────────────────────────────

  /**
   * Single launch point — ensures headless is always enforced regardless of
   * any global stealth plugin patches applied by other scrapers.
   */
  private async launchBrowser(): Promise<Browser> {
    return chromium.launch({
      headless: true,
      args:     CHROMIUM_ARGS,
    });
  }

  // ── Address enrichment ─────────────────────────────────────────────────────

  /**
   * Build a Cookie header string from the saved session file.
   * Used for direct Node fetch() calls (no browser needed).
   */
  private buildCookieHeader(): string | null {
    try {
      if (!fs.existsSync(SESSION_FILE)) return null;
      const state   = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      const cookies = (state.cookies ?? []) as Array<{ name: string; value: string }>;
      if (cookies.length === 0) return null;
      return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    } catch (err) {
      logger.warn(`[investorlift] Could not read session cookies: ${err}`);
      return null;
    }
  }

  /**
   * Fetch the full street-level address for a single listing.
   * Throws DailyLimitReachedError if the account's daily quota is exhausted.
   */
  private async fetchFullAddress(listingId: string): Promise<string | undefined> {
    const cookieHeader = this.buildCookieHeader();
    if (!cookieHeader) {
      logger.warn("[investorlift] No session cookies — cannot fetch address");
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
      logger.warn(`[investorlift] Network error fetching address for ${listingId}: ${err}`);
      return undefined;
    }

    if (!response.ok) {
      logger.warn(
        `[investorlift] Address inquiry returned HTTP ${response.status} for ${listingId}`
      );
      return undefined;
    }

    const text    = await response.text();
    const address = text.trim().replace(/^"|"$/g, "");

    if (address.includes(ADDRESS_LIMIT_SENTINEL)) {
      throw new DailyLimitReachedError();
    }

    if (!address) {
      logger.warn(`[investorlift] Empty address returned for ${listingId}`);
      return undefined;
    }

    logger.debug(`[investorlift] Address for ${listingId}: ${address}`);
    return address;
  }

  /**
   * Enrich up to ADDRESS_FETCH_LIMIT listings with full street-level addresses.
   * Stops early if the daily quota is reached.
   */
  private async enrichWithAddresses(listings: RawListing[]): Promise<RawListing[]> {
    if (listings.length === 0) return listings;

    logger.info(
      `[investorlift] Enriching up to ${ADDRESS_FETCH_LIMIT} of ${listings.length} listings with addresses`
    );

    const result:       RawListing[] = [];
    let   fetchedCount               = 0;
    let   limitReached               = false;

    for (let i = 0; i < listings.length; i++) {
      const listing = { ...listings[i] };

      // Once we've hit the limit (either our cap or InvestorLift's daily limit),
      // pass remaining listings through unchanged
      if (limitReached || fetchedCount >= ADDRESS_FETCH_LIMIT) {
        result.push(listing);
        continue;
      }

      const listingId = extractListingId(listing.url);
      if (!listingId) {
        logger.warn(`[investorlift] Cannot extract listing ID from: ${listing.url}`);
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
            `[investorlift] Daily address limit reached after ${fetchedCount} fetches — ` +
            `passing remaining ${listings.length - i} listings through unchanged`
          );
          limitReached = true;
          // Push current listing (no address) and continue loop to drain remaining
          result.push(listing);
          continue;
        }
        logger.warn(`[investorlift] Address fetch failed for ${listingId}: ${err}`);
        result.push(listing);
      }
    }

    logger.info(
      `[investorlift] Enrichment done — ${fetchedCount} addresses fetched, ` +
      `${result.length} listings total`
    );
    return result;
  }

  // ── Public enrichment surface ──────────────────────────────────────────────

  /** Exposed for external callers (e.g. manual enrichment scripts). */
  public async enrichListingsWithAddresses(listings: RawListing[]): Promise<RawListing[]> {
    return this.enrichWithAddresses(listings);
  }

  // ── Post-filter hook ───────────────────────────────────────────────────────

  /**
   * Called by the base runner AFTER location/price filtering.
   * Enriches only the top 5 filtered results — avoids burning the daily
   * address quota on listings that would be filtered out anyway.
   */
  protected async enrichAfterFilter(listings: RawListing[]): Promise<RawListing[]> {
    if (listings.length === 0) return listings;

    const topN = listings.slice(0, ADDRESS_FETCH_LIMIT);
    logger.info(
      `[investorlift] Post-filter enrichment: top ${topN.length} of ${listings.length} listings`
    );

    try {
      const enriched = await this.enrichWithAddresses(topN);
      return [...enriched, ...listings.slice(ADDRESS_FETCH_LIMIT)];
    } catch (err) {
      logger.warn(`[investorlift] Post-filter enrichment failed: ${err} — returning unenriched`);
      return listings;
    }
  }

  // ── Main scrape ────────────────────────────────────────────────────────────

  protected async scrapePage(
    _handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    // InvestorLift is not paginated — skip early before doing any IO
    if (pageNumber > 1) {
      logger.info("[investorlift] Non-paginated source — skipping page 2+");
      return [];
    }

    // Validate session — throws SessionExpiredError with instructions if stale
    await this.ensureSession();

    const browser = await this.launchBrowser();
    try {
      const context = await browser.newContext({
        storageState: SESSION_FILE,
        userAgent:    USER_AGENT,
      });

      const page = await context.newPage();

      const seenUrls:       Set<string>             = new Set();
      const apiListings:    RawListing[]             = [];
      const pendingParses:  Promise<void>[]          = [];

      // Intercept all /api/customer/api/properties XHR responses
      page.on("response", (response) => {
        if (!response.url().includes("/api/customer/api/properties")) return;
        logger.debug(`[investorlift] XHR intercepted: ${response.url()}`);

        const p = response
          .json()
          .then((json) => {
            const parsed = parseApiResponse(json, this.sourceName);
            if (parsed.length > 0) {
              logger.info(
                `[investorlift] ${parsed.length} listings from ${response.url()}`
              );
            }
            for (const listing of parsed) {
              if (!listing.url || seenUrls.has(listing.url)) continue;
              seenUrls.add(listing.url);
              apiListings.push(listing);
            }
          })
          .catch((err) => {
            logger.debug(`[investorlift] XHR parse error from ${response.url()}: ${err}`);
          });

        pendingParses.push(p);
      });

      try {
        logger.info("[investorlift] Loading marketplace…");
        await page.goto(MARKETPLACE_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });

        // ── Guard: session expiry / bot detection ────────────────────────
        const landedUrl = page.url();
        const pageTitle = (await page.title()).toLowerCase();

        if (
          landedUrl.includes("/login") ||
          landedUrl.includes("/signin") ||
          pageTitle.includes("sign in") ||
          pageTitle.includes("log in")
        ) {
          logger.warn("[investorlift] Redirected to login — session expired, deleting file");
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
          logger.error("[investorlift] IP blocked or CAPTCHA challenge detected");
          return [];
        }

        logger.info(`[investorlift] Landed on: ${landedUrl} | title: "${pageTitle}"`);

        // ── Wait for first XHR ───────────────────────────────────────────
        try {
          await page.waitForResponse(
            (r) => r.url().includes("/api/customer/api/properties") && r.status() === 200,
            { timeout: 15_000 }
          );
          logger.info("[investorlift] Properties XHR received");
        } catch {
          logger.warn("[investorlift] XHR timeout — scrolling to trigger lazy load");
        }

        await sleep(2000);
        await Promise.allSettled(pendingParses);

        // ── Scroll to trigger additional XHRs if first load was empty ───
        if (apiListings.length === 0) {
          logger.info("[investorlift] No listings yet — scrolling to trigger XHR");
          for (let i = 0; i < 5; i++) {
            await page.mouse.wheel(0, 5000);
            await sleep(2500);
          }
          await sleep(3000);
          await Promise.allSettled(pendingParses);
        }

        // ── Collect results ──────────────────────────────────────────────
        let listings: RawListing[];

        if (apiListings.length > 0) {
          logger.info(`[investorlift] ${apiListings.length} listings collected via XHR`);
          listings = apiListings;
        } else {
          logger.warn("[investorlift] No XHR data — falling back to DOM parse");
          const html = await page.content();
          this.saveDebugHtml(html, "no_api_data");
          listings = parseDomListings(html, this.sourceName);
        }

        logger.info(
          `[investorlift] Returning ${listings.length} listings for filtering ` +
          `(address enrichment deferred to post-filter)`
        );
        return listings;

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

  // ── Debug helpers ──────────────────────────────────────────────────────────

  private saveDebugHtml(html: string, label: string): void {
    try {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      fs.writeFileSync(path.join(DEBUG_DIR, `investorlift_${label}.html`), html);
      logger.info(`[investorlift] Debug HTML saved: logs/investorlift_${label}.html`);
    } catch {}
  }

}