import { chromium, Browser, Page } from "playwright";
import * as fs from "fs";
import * as path from "path";
import axios from "axios";

import { BaseScraper, ScraperOptions } from "../../base.scraper";
import { RawListing } from "../../../types/listing";
import { logger } from "../../../utils/logger";
import { sleep, BrowserHandle } from "../../../utils/browser";
import {
  loadSeenListings as loadSeenFromDb,
  saveSeenListings as saveSeenToDb,
} from "../../../utils/backfill-store";
import {
  AduResearchListing,
  parseAduApiResponse,
} from "../core/adu-research.parser";
import { ADU_KEYWORDS } from "../core/adu-keywords";
import {
  passesLocationFilter,
  passesKeywordFilter,
  passesPropertyCriteria,
} from "../filters/adu-research.scraper";

// ── Constants ──────────────────────────────────────────────────────────────

const MARKETPLACE_URL = "https://investorlift.com/marketplace/";
const PROPERTIES_API_URL =
  "https://investorlift.com/marketplace/api/customer/api/properties";
const ADDRESS_INQUIRY_URL =
  "https://investorlift.com/marketplace/api/customer/api/inquiry";

const ADDRESS_LIMIT_SENTINEL =
  "You have reached the daily address request limit";
const ADDRESS_FETCH_LIMIT = 5;
const ADDRESS_REQUEST_DELAY = 800;

const SERVER_ROOT = path.resolve(__dirname, "../../../..");
const SESSION_FILE_DEFAULT = process.env.INVESTORLIFT_SESSION_FILE
  ? path.resolve(process.env.INVESTORLIFT_SESSION_FILE)
  : path.join(SERVER_ROOT, "investorlift-session.json");
const SESSION_FILE_FALLBACK = path.join(SERVER_ROOT, "investor-session.json");
const SESSION_FILE =
  fs.existsSync(SESSION_FILE_FALLBACK) && !fs.existsSync(SESSION_FILE_DEFAULT)
    ? SESSION_FILE_FALLBACK
    : SESSION_FILE_DEFAULT;
const DEBUG_DIR = path.resolve("logs");

const BACKFILL_BATCH_SIZE = Number(process.env.IL_BACKFILL_BATCH_SIZE ?? 500);
const IL_LOOKBACK_DAYS = Number(process.env.IL_LOOKBACK_DAYS ?? 90);

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": USER_AGENT,
  Origin: "https://investorlift.com",
  Referer: "https://investorlift.com/marketplace/",
};

const CHROMIUM_ARGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

// ── Errors ─────────────────────────────────────────────────────────────────

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

function extractListingId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/\/(?:deal|p)\/([^/?#]+)/);
  return m?.[1];
}

// ── Scraper ──────────────────────────────────────────────────────────────────

export class InvestorLiftAduScraper extends BaseScraper {
  readonly sourceName: string = "investorlift-adu";

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  // Always connect direct — InvestorLift blocks proxy headers
  protected getEffectiveProxy(): string | null {
    logger.info("[investorlift-adu] Proxy disabled — connecting direct");
    return null;
  }

  protected passesFilter(listing: RawListing): boolean {
    return passesLocationFilter(listing as AduResearchListing);
  }

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
        logger.info("[investorlift-adu] Validating saved session…");
        await page.goto(MARKETPLACE_URL, {
          waitUntil: "domcontentloaded",
          timeout: 20_000,
        });

        const result = await page.evaluate(async (url: string) => {
          try {
            const r = await fetch(url, { credentials: "include" });
            const body = await r.json().catch(() => null);
            return { status: r.status, hasData: !!body?.data?.length };
          } catch {
            return { status: 0, hasData: false };
          }
        }, `${PROPERTIES_API_URL}?per_page=1`);

        logger.info(
          `[investorlift-adu] Session check — HTTP ${result.status}, hasData: ${result.hasData}`,
        );
        return result.status === 200 && result.hasData;
      } finally {
        await page.close();
        await context.close();
      }
    } catch (err) {
      logger.warn(`[investorlift-adu] Session validation error: ${err}`);
      return false;
    } finally {
      await browser.close();
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.sessionExists()) {
      const valid = await this.isSessionValid();
      if (valid) {
        logger.info("[investorlift-adu] Session is valid");
      } else {
        logger.warn(
          "[investorlift-adu] Session validation failed or timed out — keeping file to try anyway",
        );
      }
      return;
    } else {
      logger.info("[investorlift-adu] No session file found");
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
      const cookies = (state.cookies ?? []) as Array<{
        name: string;
        value: string;
      }>;
      if (cookies.length === 0) return null;
      return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    } catch (err) {
      logger.warn(`[investorlift-adu] Could not read session cookies: ${err}`);
      return null;
    }
  }

  private async fetchFullAddress(
    listingId: string,
  ): Promise<string | undefined> {
    const cookieHeader = this.buildCookieHeader();
    if (!cookieHeader) {
      logger.warn("[investorlift-adu] No session cookies — cannot fetch address");
      return undefined;
    }

    let text: string;
    let status: number;
    try {
      const response = await axios.post(
        ADDRESS_INQUIRY_URL,
        JSON.stringify({ property_id: listingId, type: "address_request" }),
        {
          headers: {
            ...BASE_HEADERS,
            "Content-Type": "text/plain;charset=UTF-8",
            Referer: `https://investorlift.com/marketplace/deal/${listingId}`,
            Cookie: cookieHeader,
          },
          validateStatus: () => true,
        },
      );
      status = response.status;
      text = response.data;
    } catch (err: any) {
      logger.warn(
        `[investorlift-adu] Network error fetching address for ${listingId}: ${err.message}`,
      );
      return undefined;
    }

    if (status !== 200) {
      logger.warn(
        `[investorlift-adu] Address inquiry returned HTTP ${status} for ${listingId}`,
      );
      return undefined;
    }

    const address = text.trim().replace(/^"|"$/g, "");

    if (address.includes(ADDRESS_LIMIT_SENTINEL)) {
      throw new DailyLimitReachedError();
    }

    if (!address) {
      logger.warn(`[investorlift-adu] Empty address returned for ${listingId}`);
      return undefined;
    }

    logger.debug(`[investorlift-adu] Address for ${listingId}: ${address}`);
    return address;
  }

  // ── Post-filter enrichment ─────────────────────────────────────────────

  protected async enrichAfterFilter(
    listings: RawListing[],
  ): Promise<RawListing[]> {
    if (listings.length === 0) return listings;

    const passed = listings.filter((l) => this.passesFilter(l));
    logger.info(
      `[investorlift-adu] ${passed.length} passed location filter (out of ${listings.length}).`,
    );

    logger.info(
      `[investorlift-adu] Reverse-processing to enrich newest properties first.`,
    );

    const toEnrich = [...passed].reverse();

    let enriched = 0;
    for (const listing of toEnrich) {
      if (enriched >= ADDRESS_FETCH_LIMIT) {
        logger.info(
          `[investorlift-adu] Reached address fetch limit (${ADDRESS_FETCH_LIMIT}). Skipping remaining.`,
        );
        break;
      }

      const listingId = extractListingId(listing.url);

      if (listingId && (!listing.address || listing.address.length < 5)) {
        try {
          const address = await this.fetchFullAddress(listingId);
          if (address) {
            listing.address = address;
            enriched++;
            logger.info(
              `[investorlift-adu] 📍 Resolved address: ${address} [Daily total: ${enriched}/${ADDRESS_FETCH_LIMIT}]`,
            );
            await sleep(ADDRESS_REQUEST_DELAY);
          }
        } catch (err: any) {
          if (err.name === "DailyLimitReachedError") {
            logger.warn(
              "[investorlift-adu] Daily address limit reached from API. Stopping enrichment.",
            );
            break;
          }
          if (err.name === "SessionExpiredError") {
            logger.warn("[investorlift-adu] Session expired during address fetch.");
            break;
          }
          logger.error(`[investorlift-adu] Failed to fetch address: ${err}`);
        }
      } else {
        logger.debug(
          `[investorlift-adu] Skipping address fetch (already has address or missing ID)`,
        );
      }
    }

    logger.info(`[investorlift-adu] Evaluating ADU criteria...`);

    const aduListings: AduResearchListing[] = passed.map((l) => {
      const titlePart = l.title ?? "";
      const descriptionPart = l.description ?? "";
      const addressPart = l.address ?? "";

      const haystack = [titlePart, descriptionPart, addressPart]
        .join(" ")
        .toLowerCase();

      const matchedKeyword = ADU_KEYWORDS.find((kw) => {
        const regex = new RegExp(
          `\\b${kw.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}\\b`,
          "i",
        );
        return regex.test(haystack);
      });

      let zip: string | undefined;
      if (l.address) {
        const match = l.address.match(/\b\d{5}(-\d{4})?\b/);
        if (match) zip = match[0];
      }

      return {
        ...l,
        source: this.sourceName,
        totalBedrooms: l.bedrooms,
        matchedKeyword,
        zip,
      } as AduResearchListing;
    });

    const finalFiltered = aduListings.filter(
      (l) => passesKeywordFilter(l) && passesPropertyCriteria(l),
    );

    logger.info(
      `[investorlift-adu] ✓ ${finalFiltered.length} passed ADU criteria.`,
    );

    if (this.options.onMatch) {
      for (const item of finalFiltered) {
        await this.options.onMatch(item);
      }
    }

    return finalFiltered;
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
    if (pageNumber > 1) {
      logger.info("[investorlift-adu] Non-paginated source — skipping page 2+");
      return [];
    }

    await this.ensureSession();

    const browser = await this.launchBrowser();
    try {
      const context = await browser.newContext({
        storageState: SESSION_FILE,
        userAgent: USER_AGENT,
      });

      const page = await context.newPage();

      try {
        logger.info("[investorlift-adu] Loading marketplace to pass Cloudflare…");
        try {
          await page.goto(MARKETPLACE_URL, {
            waitUntil: "domcontentloaded",
            timeout: 30_000,
          });
        } catch (gotoErr) {
          logger.warn(
            `[investorlift-adu] page.goto failed or timed out: ${gotoErr} — continuing anyway`,
          );
        }

        const landedUrl = page.url();
        const pageTitle = (await page.title()).toLowerCase();

        if (
          landedUrl.includes("/login") ||
          landedUrl.includes("/signin") ||
          pageTitle.includes("sign in") ||
          pageTitle.includes("log in")
        ) {
          logger.warn("[investorlift-adu] Redirected to login — session expired");
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
          logger.error(
            "[investorlift-adu] IP blocked or CAPTCHA challenge detected",
          );
          return [];
        }

        logger.info(`[investorlift-adu] Landed on: ${landedUrl}`);
        logger.info("[investorlift-adu] Fetching properties directly via API...");
        
        const cookies = await context.cookies();
        const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

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
          logger.error(`[investorlift-adu] Axios fetch failed: ${err.message}`);
          return [];
        }

        const parsed = parseAduApiResponse(json, this.sourceName);
        logger.info(
          `[investorlift-adu] Fetched ${parsed.length} total listings from API.`,
        );

        parsed.sort((a, b) => {
          const dateA = a.publishedAt ?? "";
          const dateB = b.publishedAt ?? "";
          return dateA.localeCompare(dateB);
        });

        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - IL_LOOKBACK_DAYS);
        const lookbackListings = parsed.filter((l) => {
          if (!l.publishedAt) return true;
          return new Date(l.publishedAt) >= cutoff;
        });

        logger.info(
          `[investorlift-adu] Retained ${lookbackListings.length} listings published in the last ${IL_LOOKBACK_DAYS} days.`,
        );

        const previouslySeen = await loadSeenFromDb(this.sourceName);
        const allSeenIds = new Set(previouslySeen);

        const seenUrls: Set<string> = new Set();
        const apiListings: AduResearchListing[] = [];
        const rawStateCounts: Map<string, number> = new Map();

        let skippedAsSeen = 0;
        let processedThisBatch = 0;
        let oldestInBatch = "N/A";
        let newestInBatch = "N/A";

        for (const listing of lookbackListings) {
          if (!listing.url || seenUrls.has(listing.url)) continue;
          seenUrls.add(listing.url);

          const listingId = extractListingId(listing.url);

          if (listingId && previouslySeen.has(listingId)) {
            skippedAsSeen++;
            continue;
          }

          if (oldestInBatch === "N/A")
            oldestInBatch = listing.publishedAt ?? "N/A";
          newestInBatch = listing.publishedAt ?? "N/A";

          processedThisBatch++;
          if (listingId) allSeenIds.add(listingId);

          if (passesLocationFilter(listing)) {
            const addressUpper = (listing.address ?? "").toUpperCase();
            const stateUpper = (listing.state ?? "").toUpperCase();
            // We don't have TARGET_STATES from config here directly, but we can rely on passesLocationFilter
            // to do the exact same check. We'll just push if it passes.
            
            // Note: old code did a state count check here against this.options.maxListings.
            // We'll skip the strict state count for simplicity in the backfill loop unless we want to reinvent it,
            // or we can just push it.
            if (passesPropertyCriteria(listing)) {
              apiListings.push(listing);
            }
          }

          if (processedThisBatch >= BACKFILL_BATCH_SIZE) {
            logger.info(
              `[investorlift-adu] Reached backfill batch limit of ${BACKFILL_BATCH_SIZE}. Stopping processing.`,
            );
            break;
          }
        }

        await saveSeenToDb(this.sourceName, allSeenIds, processedThisBatch);
        logger.info(
          `[investorlift-adu] Batch date range: ${oldestInBatch} to ${newestInBatch}`,
        );

        logger.info(
          `[investorlift-adu] Processed ${processedThisBatch} new listings, skipped ${skippedAsSeen} already-seen`,
        );
        if (apiListings.length > 0) {
          logger.info(
            `[investorlift-adu] ${apiListings.length} NEW passing ADU listings collected via API`,
          );
        } else {
          logger.warn("[investorlift-adu] No new matching listings collected");
        }

        return apiListings;
      } finally {
        await page.close();
        await context.close();
      }
    } catch (err) {
      logger.error(`[investorlift-adu] Playwright execution failed: ${err}`);
      return [];
    } finally {
      await browser.close();
    }
  }

  protected extractListings(_page: Page): Promise<RawListing[]> {
    return Promise.resolve([]);
  }
}