// src/scrapers/investorlift/investorlift.scraper.ts

import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { parseApiResponse, parseDomListings } from "./investorlift.parser";
import { chromium, BrowserContext, Page, Browser } from "playwright";
import * as fs from "fs";
import * as path from "path";

const MARKETPLACE_URL        = "https://investorlift.com/marketplace/";
const ADDRESS_INQUIRY_URL    = "https://investorlift.com/marketplace/api/customer/api/inquiry";
const ADDRESS_LIMIT_SENTINEL = "You have reached the daily address request limit";
const SESSION_FILE        = path.join(__dirname, "../../..", "investorlift-session.json");
const DEBUG_DIR           = path.resolve("logs");

const ADDRESS_REQUEST_DELAY_MS = 800;

// How long to wait for the user to fully log in and reach the marketplace
const MANUAL_LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

const BASE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Origin":  "https://investorlift.com",
  "Referer": "https://investorlift.com/marketplace/",
};

class DailyLimitReachedError extends Error {
  constructor() {
    super("Daily address request limit reached");
    this.name = "DailyLimitReachedError";
  }
}

export class InvestorLiftScraper extends BaseScraper {
  readonly sourceName = "investorlift";

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  protected getEffectiveProxy(): string | null {
    logger.info(
      "[investorlift] Proxy explicitly disabled — connecting direct to bypass proxy header detection"
    );
    return null;
  }

  // ── DEBUG HELPERS ──────────────────────────────────────────────────────────

  private saveDebugHtml(html: string, label: string): void {
    try {
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      fs.writeFileSync(path.join(DEBUG_DIR, `investorlift_${label}.html`), html);
      logger.info(`[investorlift] Debug HTML saved: logs/investorlift_${label}.html`);
    } catch {}
  }

  // ── SESSION PERSISTENCE ────────────────────────────────────────────────────

  private sessionExists(): boolean {
    try {
      if (!fs.existsSync(SESSION_FILE)) return false;
      const state = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      // A valid session has at least some cookies
      return Array.isArray(state.cookies) && state.cookies.length > 0;
    } catch {
      return false;
    }
  }

  private async saveSession(context: BrowserContext): Promise<void> {
    try {
      fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
      await context.storageState({ path: SESSION_FILE });
      const state = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      logger.info(
        `[investorlift] Session saved — ${state.cookies?.length ?? 0} cookies stored`
      );
    } catch (err) {
      logger.warn(`[investorlift] Could not save session: ${err}`);
    }
  }

  private async loadSession(context: BrowserContext): Promise<void> {
    // storageState is loaded at context creation time, not after.
    // This method is a no-op here — session is injected in newContext() below.
  }

  // ── CHECK IF SESSION IS STILL VALID ───────────────────────────────────────
  //
  // Navigate to the marketplace and see if we land on an authenticated page
  // or get redirected to login.

  private async isSessionValid(context: BrowserContext): Promise<boolean> {
    // Hit the properties API directly — fastest and most reliable auth check.
    // An unauthenticated request returns a non-200 or an error body.
    const page = await context.newPage();
    try {
      logger.info("[investorlift] Validating saved session via API…");

      // Navigate first so cookies are in scope for the fetch
      await page.goto(MARKETPLACE_URL, { waitUntil: "domcontentloaded", timeout: 20_000 });

      const result = await page.evaluate(async (url: string) => {
        try {
          const r = await fetch(url, { credentials: "include" });
          const body = await r.json().catch(() => null);
          return { status: r.status, hasData: !!(body?.data?.length) };
        } catch {
          return { status: 0, hasData: false };
        }
      }, "https://investorlift.com/marketplace/api/customer/api/properties?status=available&per_page=1");

      logger.info(
        `[investorlift] Session check — status: ${result.status}, hasData: ${result.hasData}`
      );

      return result.status === 200 && result.hasData;
    } catch (err) {
      logger.warn(`[investorlift] Session validation error: ${err}`);
      return false;
    } finally {
      await page.close();
    }
  }

    // ── MANUAL SESSION EXPORT ────────────────────────────────────────────────────────────────────────────
  //
  // InvestorLift uses a session cookie (.investorlift.com domain, not HttpOnly)
  // that cannot be captured by a Playwright-launched browser because the login
  // button does not work in sandboxed Chromium (no click handler fires).
  //
  // Instead, export your session from your real browser by running the snippet
  // in export-investorlift-session.js in the browser console, then saving the
  // output as investorlift-session.json in the project root.
  //
  // Run:  node scripts/export-investorlift-session.js
  // Or:   npm run session:investorlift
  //
  // The session is valid for ~30 days. Re-export when it expires.

  private runManualLoginFlow(): never {
    throw new Error(
      "\n\n" +
      "═".repeat(60) + "\n" +
      "  InvestorLift session not found or expired.\n\n" +
      "  To export your session:\n\n" +
      "  1. Log in to https://investorlift.com/marketplace/ in your browser\n" +
      "  2. Open DevTools console (F12)\n" +
      "  3. Run: node scripts/export-investorlift-session.js\n" +
      "     (it will print the command to open the right URL)\n" +
      "  4. Paste the console snippet it shows, copy the output\n" +
      "  5. Save it as investorlift-session.json in the project root\n\n" +
      "  Or run: npm run session:investorlift\n" +
      "═".repeat(60) + "\n"
    );
  }

    // ── ENSURE AUTHENTICATED SESSION ──────────────────────────────────────────

  private async ensureSession(): Promise<void> {
    if (this.sessionExists()) {
      // Validate the saved session with a quick browser check
      const testBrowser = await chromium.launch({ headless: true });
      try {
        const testContext = await testBrowser.newContext({
          storageState: SESSION_FILE,
          userAgent: BASE_HEADERS["User-Agent"],
        });
        const valid = await this.isSessionValid(testContext);
        await testContext.close();

        if (valid) {
          logger.info("[investorlift] Saved session is valid — skipping login");
          return;
        }

        logger.info("[investorlift] Saved session is invalid — deleting and re-logging in");
        fs.unlinkSync(SESSION_FILE);
      } finally {
        await testBrowser.close();
      }
    } else {
      logger.info("[investorlift] No saved session found");
    }

    // Run manual login — this only needs to happen once; session is reused after
    await this.runManualLoginFlow();
  }

  // ── ADDRESS ENRICHMENT ─────────────────────────────────────────────────────

  private buildCookieHeader(): string | null {
    // Read cookies from the saved session file and build a Cookie header string.
    // This lets Node fetch() send the same cookies as the browser would.
    try {
      if (!fs.existsSync(SESSION_FILE)) return null;
      const state = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
      const cookies: Array<{ name: string; value: string }> = state.cookies ?? [];
      if (cookies.length === 0) return null;
      return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    } catch (err) {
      logger.warn(`[investorlift] Could not read cookies for request: ${err}`);
      return null;
    }
  }

 private async fetchFullAddress(listingId: string): Promise<string | undefined> {
  try {
    const cookieHeader = this.buildCookieHeader();
    if (!cookieHeader) {
      logger.warn("[investorlift] No cookies available for address request");
      return undefined;
    }

    const response = await fetch(ADDRESS_INQUIRY_URL, {
      method: "POST",
      headers: {
        ...BASE_HEADERS,
        "Content-Type": "text/plain;charset=UTF-8",
        "Referer": `https://investorlift.com/marketplace/deal/${listingId}`,
        "Cookie": cookieHeader,
      },
      body: JSON.stringify({
        property_id: listingId,
        type: "address_request",
      }),
    });

    if (!response.ok) {
      logger.warn(`[investorlift] Address inquiry HTTP ${response.status} for listing ${listingId}`);
      return undefined;
    }

    const text    = await response.text();
    const address = text.trim().replace(/^"|"$/g, "");

    if (address.includes(ADDRESS_LIMIT_SENTINEL)) {
      throw new DailyLimitReachedError(); // ← thrown here, must NOT be caught below
    }

    if (address) {
      logger.debug(`[investorlift] Full address for ${listingId}: ${address}`);
    } else {
      logger.warn(`[investorlift] No address returned for listing ${listingId}`);
    }

    return address || undefined;
  } catch (err) {
    if (err instanceof DailyLimitReachedError) {
      throw err; // ← re-throw so enrichWithFullAddresses can catch and break
    }
    logger.warn(`[investorlift] Address fetch failed for ${listingId}: ${err}`);
    return undefined;
  }
}

  private async enrichWithFullAddresses(
  _context: BrowserContext,
  listings: RawListing[]
): Promise<RawListing[]> {
  if (listings.length === 0) return listings;

  const ADDRESS_FETCH_LIMIT = 5;

  logger.info(
    `[investorlift] Enriching up to ${ADDRESS_FETCH_LIMIT} listings with full addresses ` +
    `(${listings.length} candidates)`
  );

  const enriched: RawListing[] = [];

  for (const listing of listings) {
    // Hard stop once we've collected the maximum allowed addresses
    if (enriched.length >= ADDRESS_FETCH_LIMIT) {
      logger.info(
        `[investorlift] Address fetch limit of ${ADDRESS_FETCH_LIMIT} reached — stopping enrichment`
      );
      break;
    }

    const listingId = extractListingId(listing.url);
    if (!listingId) {
      logger.warn(`[investorlift] No listing ID in URL: ${listing.url}`);
      continue; // skip — no ID means we can't fetch, and we don't store without address
    }

    try {
      const fullAddress = await this.fetchFullAddress(listingId);

      if (fullAddress) {
        enriched.push({ ...listing, address: fullAddress });
      } else {
        logger.warn(
          `[investorlift] Skipping listing ${listingId} — no full address returned`
        );
        // intentionally not pushed — only store listings with confirmed addresses
      }

      await sleep(ADDRESS_REQUEST_DELAY_MS);
    } catch (err) {
      if (err instanceof DailyLimitReachedError) {
        logger.warn(
          `[investorlift] Daily address request limit reached after ${enriched.length} addresses — stopping.`
        );
        break; // stop immediately, don't process any more
      }
      logger.warn(`[investorlift] Address fetch failed for ${listingId}: ${err}`);
      // skip this listing — failed fetches are not stored
    }
  }

  logger.info(
    `[investorlift] Address enrichment complete — ` +
    `${enriched.length} listings stored (all with full addresses)`
  );

  return enriched;
}

  // ── MAIN SCRAPE ────────────────────────────────────────────────────────────

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    // Ensure we have a valid session before scraping (only runs login UI once)
    await this.ensureSession();

    // Create an authenticated browser context by loading the saved session
    const browser: Browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    try {
      const context: BrowserContext = await browser.newContext({
        storageState: SESSION_FILE, // restores all cookies + localStorage
        userAgent: BASE_HEADERS["User-Agent"],
      });

      const page: Page = await context.newPage();

      const seenUrls: Set<string>             = new Set();
      const apiListings: RawListing[]         = [];
      const responsePromises: Promise<void>[] = [];

      page.on("response", (response) => {
        const url = response.url();

        if (
          !url.includes("/api") &&
          !url.includes("properties") &&
          !url.includes("marketplace")
        ) return;

        const contentType = response.headers()["content-type"] || "";
        if (!contentType.includes("application/json")) return;
        if (url.includes("inquiry") || url.includes("login")) return;

        logger.debug(`[investorlift] Intercepted JSON response: ${url}`);

        const p = response
          .json()
          .then((json) => {
            const parsed = parseApiResponse(json, this.sourceName);
            if (parsed.length > 0) {
              logger.info(`[investorlift] API hit → ${parsed.length} listings from ${url}`);
            }
            for (const listing of parsed) {
              if (!listing.url || seenUrls.has(listing.url)) continue;
              seenUrls.add(listing.url);
              apiListings.push(listing);
            }
          })
          .catch((err) => {
            logger.debug(`[investorlift] Failed to parse from ${url}: ${err}`);
          });

        responsePromises.push(p);
      });

      try {
        logger.info(`[investorlift] Loading marketplace (page ${pageNumber})`);
        await page.goto(MARKETPLACE_URL, {
          waitUntil: "domcontentloaded",
          timeout: 30_000,
        });

        const landedUrl = page.url();
        const pageTitle = await page.title();
        logger.info(`[investorlift] Landed on: ${landedUrl} | title: "${pageTitle}"`);

        // Detect if session expired mid-run
        if (
          landedUrl.includes("/login") ||
          landedUrl.includes("/signin") ||
          pageTitle.toLowerCase().includes("sign in") ||
          pageTitle.toLowerCase().includes("log in")
        ) {
          logger.warn(
            "[investorlift] Session expired during scrape — deleting session file"
          );
          fs.unlinkSync(SESSION_FILE);
          throw new Error("[investorlift] Session expired — re-run to trigger re-login");
        }

        if (
          pageTitle.toLowerCase().includes("access denied") ||
          pageTitle.toLowerCase().includes("captcha") ||
          pageTitle.toLowerCase().includes("just a moment") ||
          landedUrl.includes("challenge") ||
          landedUrl.includes("blocked")
        ) {
          logger.error(`[investorlift] IP blocked or CAPTCHA — aborting page ${pageNumber}`);
          return [];
        }

        try {
          await page.waitForResponse(
            (r) => r.url().includes("properties") && r.status() === 200,
            { timeout: 15_000 }
          );
          logger.info("[investorlift] Properties XHR received");
        } catch {
          logger.warn("[investorlift] Properties XHR timed out — scrolling to trigger");
        }

        await sleep(2000);
        await Promise.allSettled([...responsePromises]);

        if (apiListings.length === 0) {
          logger.info("[investorlift] No listings on load — scrolling to trigger XHR");
          for (let i = 0; i < 5; i++) {
            await page.mouse.wheel(0, 5000);
            await sleep(2500);
          }
          await sleep(3000);
          await Promise.allSettled([...responsePromises]);
        }

        let listings: RawListing[];
        if (apiListings.length > 0) {
          logger.info(`[investorlift] Collected ${apiListings.length} listings via API`);
          listings = apiListings;
        } else {
          logger.warn("[investorlift] No API data — falling back to DOM parsing");
          const html = await page.content();
          this.saveDebugHtml(html, "no_api_data");
          listings = parseDomListings(html, this.sourceName);
        }

        listings = await this.enrichWithFullAddresses(context, listings);
        return listings;
      } finally {
        await page.close();
      }
    } finally {
      await browser.close();
    }
  }
}

// ── Utilities ──────────────────────────────────────────────────────────────

function extractListingId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/\/(?:deal|p)\/([^/?#]+)/);
  return m?.[1];
}