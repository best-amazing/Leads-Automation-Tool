// src/scrapers/crexi/crexi.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// Crexi.com scraper
//
// Requires a RESIDENTIAL proxy — datacenter IPs are blocked by Cloudflare.
// Set CREXI_PROXY_URL in .env to override the global proxy for this scraper.
// If not set, falls back to the global config proxyUrl.
//
// Anti-bot approach:
//   • playwright-extra + stealth plugin (patches 20+ detection vectors)
//   • Cloudflare challenge auto-wait (waits up to 25s for JS challenge to pass)
//   • API response interception — captures Crexi's XHR JSON before Angular renders
//   • Realistic headers + navigator overrides
//   • Human-like timing with random jitter
//
// Pagination:
//   After the initial page load and scroll we click Crexi's Angular pagination
//   "next page" button (crx-pagination or [aria-label="Next page"]) and wait
//   for fresh api.crexi.com/assets/search XHR responses, repeating up to
//   CREXI_MAX_PAGES per URL.  This is the most reliable way to get >50 listings
//   per search URL without triggering extra CF checks.
//
// NOTE on Cloudflare detection:
//   We intentionally DO NOT treat bare <crx-app> as "Crexi content" — it is
//   always present as an empty Angular shell even on CF challenge pages.
//   Only rendered listing elements (tiles, price, header toolbar) count.
//
// NOTE on Angular hydration:
//   After CF clears we wait for networkidle before polling for tiles, giving
//   Angular time to bootstrap and fire its search XHR. The XHR responses are
//   also intercepted directly so we get JSON data even if tiles render slowly.
// ─────────────────────────────────────────────────────────────────────────────

import { chromium } from "playwright-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { Page, Browser, Response } from "playwright";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { parseCrxiListings } from "./crexi.parser";
import { config } from "../../config";
import * as fs from "fs";
import * as path from "path";

// Apply stealth plugin — must be done before any launch() call
chromium.use(StealthPlugin());

// ── Config ─────────────────────────────────────────────────────────────────

const CREXI_PROXY_URL =
  process.env.CREXI_PROXY_URL ||
  (config as any).crexiProxyUrl ||
  config.proxyUrl ||
  "";

const SEARCH_URLS: string[] = config.sources.crexi.searchUrls;

// Maximum pages to paginate per search URL (each page ≈ 50 listings)
const MAX_PAGES_PER_URL = Number(process.env.CREXI_MAX_PAGES ?? 5);

const SCROLL_PASSES   = 6;
const SCROLL_STEP     = 900;
const SCROLL_DELAY_MS = 1800;

// How long to wait for Cloudflare to auto-resolve (ms)
const CF_TIMEOUT_MS = 25_000;

// How long to wait for Angular listing tiles to appear after CF clears (ms)
const LISTINGS_WAIT_MS = 45_000;

// How long to wait after clicking "next page" for new API responses (ms)
const PAGINATION_WAIT_MS = 12_000;

// Crexi API URL substrings to intercept for JSON data
const CREXI_API_PATTERNS = [
  "api.crexi.com/assets/search",
  "api.crexi.com/properties/search",
  "/assets/search",
];

// Pagination button selectors — tried in order
const NEXT_PAGE_SELECTORS = [
  "button[aria-label='Next page']",
  "button[aria-label='next page']",
  "crx-pagination button:last-of-type",
  "cui-pagination button:last-of-type",
  ".pagination-next",
  "[data-cy='paginationNext']",
  "button.next-page",
  // Fallback: a button containing a right-arrow icon
  "button svg[data-icon='chevron-right']",
  "button svg[data-icon='angle-right']",
];

export class CrexiScraper extends BaseScraper {
  readonly sourceName = "crexi";

  constructor(options: ScraperOptions = {}) {
    super(options);
    logger.info(
      `[crexi] ${SEARCH_URLS.length} target URL(s):\n` +
        SEARCH_URLS.map((u) => `  • ${u}`).join("\n")
    );
    if (!CREXI_PROXY_URL) {
      logger.warn(
        "[crexi] No proxy configured. Crexi requires a RESIDENTIAL proxy to bypass Cloudflare.\n" +
          "  Set CREXI_PROXY_URL=http://user:pass@host:port in .env"
      );
    } else {
      const masked = CREXI_PROXY_URL.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
      logger.info(`[crexi] Using proxy: ${masked}`);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Launch a dedicated stealth browser for Crexi
  // ─────────────────────────────────────────────────────────────────────────

  private async launchBrowser(): Promise<Browser> {
    const launchOptions: any = {
      headless:       true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--disable-gpu",
        "--no-zygote",
        "--single-process",
        "--window-size=1440,900",
        "--disable-features=IsolateOrigins",
        "--disable-site-isolation-trials",
      ],
    };

    if (CREXI_PROXY_URL) {
      launchOptions.proxy = { server: CREXI_PROXY_URL };
    }

    return chromium.launch(launchOptions) as unknown as Browser;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Anti-detection page setup
  // ─────────────────────────────────────────────────────────────────────────

  private async setupPage(page: Page): Promise<void> {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver",  { get: () => undefined });
      Object.defineProperty(navigator, "plugins",    { get: () => [1, 2, 3, 4, 5] });
      Object.defineProperty(navigator, "languages",  { get: () => ["en-US", "en"] });
      (window as any).chrome = { runtime: {} };
      const origQuery = window.navigator.permissions?.query;
      if (origQuery) {
        window.navigator.permissions.query = (parameters: any) =>
          parameters.name === "notifications"
            ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
            : origQuery(parameters);
      }
    });

    await page.setExtraHTTPHeaders({
      "Accept-Language":           "en-US,en;q=0.9",
      "Accept":                    "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Encoding":           "gzip, deflate, br",
      "Sec-Fetch-Dest":            "document",
      "Sec-Fetch-Mode":            "navigate",
      "Sec-Fetch-Site":            "none",
      "Sec-Fetch-User":            "?1",
      "Upgrade-Insecure-Requests": "1",
      "Cache-Control":             "max-age=0",
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Wait for Cloudflare challenge to auto-resolve.
  // Bare <crx-app> is intentionally excluded — it is an empty Angular shell
  // present even on challenge pages, causing false "cleared" signals.
  // ─────────────────────────────────────────────────────────────────────────

  private async waitForCloudflare(page: Page): Promise<boolean> {
    const start = Date.now();

    while (Date.now() - start < CF_TIMEOUT_MS) {
      const title = await page.title().catch(() => "");
      const url   = page.url();

      const isCFTitle = [
        "Just a moment", "Attention Required", "Please wait", "Security check",
      ].some(s => title.includes(s));

      const hasCFContent = await page.evaluate(() => {
        const body = document.body?.innerHTML ?? "";
        return (
          body.includes("challenges.cloudflare.com") ||
          body.includes("Performing security verification") ||
          body.includes("cf-turnstile") ||
          document.querySelector("#challenge-form") !== null ||
          document.querySelector(".cf-browser-verification") !== null
        );
      }).catch(() => false);

      const hasCrexiContent = await page.evaluate(() => {
        return (
          document.querySelector("[data-cy='propertyPrice']") !== null ||
          document.querySelector("crx-sales-property-tile") !== null ||
          document.querySelector("crx-header-toolbar") !== null
        );
      }).catch(() => false);

      const urlHasCF   = url.includes("__cf_chl");
      const isChallenge = (isCFTitle || hasCFContent || urlHasCF) && !hasCrexiContent;

      if (!isChallenge) {
        const elapsed = Math.round((Date.now() - start) / 1000);
        logger.info(`[crexi] Cloudflare cleared after ${elapsed}s (hasCrexiContent: ${hasCrexiContent})`);
        return true;
      }

      logger.info(`[crexi] Cloudflare challenge active (${Math.round((Date.now() - start) / 1000)}s elapsed)…`);
      await sleep(2000);
    }

    logger.warn(`[crexi] Cloudflare challenge did not resolve after ${CF_TIMEOUT_MS / 1000}s`);
    return false;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Wait for Angular listing tiles to appear.
  // ─────────────────────────────────────────────────────────────────────────

  private async waitForListings(page: Page): Promise<boolean> {
    try {
      await page.waitForFunction(
        () =>
          document.querySelector("crx-sales-property-tile") !== null ||
          document.querySelector("[data-cy='propertyPrice']") !== null ||
          document.querySelector("[data-cy='propertyName']") !== null ||
          document.querySelector("crx-property-tile-aggregate") !== null,
        { timeout: LISTINGS_WAIT_MS, polling: 1000 }
      );
      logger.info("[crexi] Listings detected via waitForFunction");
      return true;
    } catch {
      logger.warn("[crexi] waitForFunction timed out — no listing tiles appeared");
      return false;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scroll to trigger lazy-loaded content
  // ─────────────────────────────────────────────────────────────────────────

  private async scrollToLoadMore(page: Page): Promise<void> {
    logger.info(`[crexi] Scrolling (${SCROLL_PASSES} passes)…`);
    for (let i = 0; i < SCROLL_PASSES; i++) {
      await page.evaluate(`window.scrollBy(0, ${SCROLL_STEP})`);
      await sleep(SCROLL_DELAY_MS + Math.random() * 600);
      try {
        await page.waitForLoadState("networkidle", { timeout: 4_000 });
      } catch { /* fine */ }
    }
    await page.evaluate("window.scrollTo(0, 0)");
    await sleep(600);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Try to click the "next page" pagination button.
  // Returns true if a button was found and clicked.
  // ─────────────────────────────────────────────────────────────────────────

  private async clickNextPage(page: Page): Promise<boolean> {
    for (const selector of NEXT_PAGE_SELECTORS) {
      try {
        const btn = page.locator(selector).first();
        const count = await btn.count();
        if (count === 0) continue;

        const isDisabled = await btn.evaluate(
          (el) => (el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true"
        ).catch(() => true);

        if (isDisabled) {
          logger.info(`[crexi] Next-page button found via "${selector}" but is disabled — last page`);
          return false;
        }

        await btn.scrollIntoViewIfNeeded();
        await sleep(400 + Math.random() * 300);
        await btn.click();
        logger.info(`[crexi] Clicked next-page button via "${selector}"`);
        return true;
      } catch {
        // selector didn't match — try the next one
      }
    }

    // Last-resort: evaluate in page context to find any "Next" text button
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll("button"));
      const nextBtn = buttons.find(
        (b) =>
          /next/i.test(b.textContent ?? "") ||
          b.getAttribute("aria-label")?.toLowerCase().includes("next")
      );
      if (nextBtn && !(nextBtn as HTMLButtonElement).disabled) {
        nextBtn.click();
        return true;
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      logger.info("[crexi] Clicked next-page via text/aria-label fallback");
    } else {
      logger.info("[crexi] No clickable next-page button found");
    }
    return clicked;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Wait for a fresh assets/search API response to arrive after a page turn.
  // Resolves with any new listings captured during the wait window.
  // ─────────────────────────────────────────────────────────────────────────

  private async waitForPageTurnResponse(
    page: Page,
    sourceUrl: string,
    source: string
  ): Promise<RawListing[]> {
    return new Promise<RawListing[]>((resolve) => {
      const collected: RawListing[] = [];
      let settled = false;

      const handler = async (response: Response) => {
        if (settled) return;
        const rUrl = response.url();
        if (!CREXI_API_PATTERNS.some(p => rUrl.includes(p))) return;
        try {
          const ct = response.headers()["content-type"] ?? "";
          if (!ct.includes("application/json")) return;
          const json = await response.json().catch(() => null);
          if (!json) return;
          const listings = parseCrxiListings("", json, sourceUrl, source);
          if (listings.length > 0) {
            logger.info(`[crexi] Page-turn API captured ${listings.length} listings`);
            collected.push(...listings);
          }
        } catch { /* ignore */ }
      };

      page.on("response", handler);

      setTimeout(() => {
        settled = true;
        page.off("response", handler);
        resolve(collected);
      }, PAGINATION_WAIT_MS);
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Scrape a single search URL with pagination
  // ─────────────────────────────────────────────────────────────────────────

  private async scrapeUrl(page: Page, searchUrl: string): Promise<RawListing[]> {
    logger.info(`[crexi] → ${searchUrl}`);

    const interceptedListings: RawListing[] = [];

    // Intercept API responses before navigation so we never miss early XHRs
    const responseHandler = async (response: Response) => {
      const rUrl = response.url();
      if (!CREXI_API_PATTERNS.some(p => rUrl.includes(p))) return;
      try {
        const ct = response.headers()["content-type"] ?? "";
        if (!ct.includes("application/json")) return;
        const json = await response.json().catch(() => null);
        if (!json) return;
        logger.debug(`[crexi] Intercepted API response: ${rUrl}`);
        const listings = parseCrxiListings("", json, searchUrl, "crexi");
        if (listings.length > 0) {
          logger.info(`[crexi] API interception captured ${listings.length} listings from ${rUrl}`);
          interceptedListings.push(...listings);
        }
      } catch { /* Non-JSON — ignore */ }
    };

    page.on("response", responseHandler);

    try {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });

      const cfCleared = await this.waitForCloudflare(page);
      if (!cfCleared) {
        this.saveDebug(await page.content(), `cf_timeout_${this.slugify(searchUrl)}`);
        logger.error(
          "[crexi] ✗ Cloudflare not bypassed. Ensure you are using a RESIDENTIAL proxy.\n" +
            "  Datacenter IPs (including most Webshare IPs) are blocked by Cloudflare."
        );
        return [];
      }

      // Wait for Angular's initial search XHR
      try {
        await page.waitForLoadState("networkidle", { timeout: 20_000 });
      } catch {
        logger.debug("[crexi] networkidle timeout after CF clear — proceeding anyway");
      }
      await sleep(1500 + Math.random() * 500);

      if (interceptedListings.length === 0) {
        const cardsFound = await this.waitForListings(page);
        if (!cardsFound) {
          this.saveDebug(await page.content(), `no_cards_${this.slugify(searchUrl)}`);
          logger.warn(`[crexi] No cards found for ${searchUrl} — will still attempt HTML parse`);
        }
      }

      await this.scrollToLoadMore(page);

      // ── Pagination loop ─────────────────────────────────────────────────
      // Page 1 is already loaded. We try to click "next page" up to
      // (MAX_PAGES_PER_URL - 1) additional times.
      for (let pageNum = 2; pageNum <= MAX_PAGES_PER_URL; pageNum++) {
        logger.info(`[crexi] Attempting pagination to page ${pageNum}…`);
        const clicked = await this.clickNextPage(page);
        if (!clicked) {
          logger.info(`[crexi] No more pages for ${searchUrl} (stopped at page ${pageNum - 1})`);
          break;
        }

        // Wait for new API responses triggered by the page turn
        const newListings = await this.waitForPageTurnResponse(page, searchUrl, "crexi");
        if (newListings.length > 0) {
          interceptedListings.push(...newListings);
          logger.info(`[crexi] Running total: ${interceptedListings.length} listings`);
        } else {
          logger.info(`[crexi] No new listings on page ${pageNum} — stopping pagination`);
          break;
        }

        // Scroll new content into view and let Angular settle
        await this.scrollToLoadMore(page);
        await sleep(1000 + Math.random() * 500);
      }

      // ── Return results ──────────────────────────────────────────────────
      if (interceptedListings.length > 0) {
        logger.info(`[crexi] Final intercepted count: ${interceptedListings.length}`);
        return this.dedupeListings(interceptedListings);
      }

      // Fall back to HTML parsing
      const html = await page.content();
      this.saveDebug(html, `page_${this.slugify(searchUrl)}`);
      const listings = parseCrxiListings(html, null, searchUrl, "crexi");
      logger.info(`[crexi] ${searchUrl} → ${listings.length} listings (HTML path)`);
      return listings;

    } catch (err: any) {
      logger.error(`[crexi] Error on ${searchUrl}: ${err.message}`);
      this.saveDebug(await page.content().catch(() => ""), `error_${Date.now()}`);
      return [];
    } finally {
      page.off("response", responseHandler);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Main scrape
  // ─────────────────────────────────────────────────────────────────────────

  protected async scrapePage(
    _handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    if (pageNumber !== 1) return [];

    let browser: Browser | undefined;

    try {
      browser = await this.launchBrowser();

      const context = await browser.newContext({
        viewport:   { width: 1440, height: 900 },
        locale:     "en-US",
        timezoneId: "America/New_York",
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      });

      const page = await context.newPage();
      await this.setupPage(page);

      const allListings: RawListing[] = [];

      for (let i = 0; i < SEARCH_URLS.length; i++) {
        const url = SEARCH_URLS[i];
        logger.info(`[crexi] URL ${i + 1}/${SEARCH_URLS.length}`);

        const listings = await this.scrapeUrl(page, url);
        allListings.push(...listings);

        if (i < SEARCH_URLS.length - 1) {
          const pause = 4000 + Math.random() * 3000;
          logger.info(`[crexi] Pausing ${Math.round(pause / 1000)}s before next URL…`);
          await sleep(pause);
        }
      }

      await context.close();

      const deduped = this.dedupeListings(allListings);
      logger.info(`[crexi] Total: ${deduped.length} unique listings`);
      return deduped;
    } finally {
      await browser?.close();
    }
  }

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= 1;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Helpers
  // ─────────────────────────────────────────────────────────────────────────

  private dedupeListings(listings: RawListing[]): RawListing[] {
    const seen = new Set<string>();
    return listings.filter((l) => {
      if (seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });
  }

  private slugify(url: string): string {
    return url
      .replace(/https?:\/\/[^/]+\/properties\//, "")
      .replace(/\//g, "_")
      .slice(0, 40);
  }

  private saveDebug(html: string, label: string) {
    try {
      const dir = path.resolve("logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `crexi_${label}.html`), html);
    } catch {}
  }
}