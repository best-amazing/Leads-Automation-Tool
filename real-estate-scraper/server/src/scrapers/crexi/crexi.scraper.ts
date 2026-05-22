// src/scrapers/crexi/crexi.scraper.ts

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

chromium.use(StealthPlugin());

// ── Config ─────────────────────────────────────────────────────────────────

// Proxy pool: CREXI_PROXY_URL wins if set, otherwise fall back to PROXY_URLS rotation
const CREXI_PROXY_POOL: string[] = (() => {
  if (process.env.CREXI_PROXY_URL) return [process.env.CREXI_PROXY_URL];
  const urls = (config as any).proxyUrls;
  if (Array.isArray(urls) && urls.length > 0) return urls;
  if (config.proxyUrl) return [config.proxyUrl];
  return [];
})();

const SEARCH_URLS: string[] = config.sources.crexi.searchUrls;
const MAX_PAGES_PER_URL = Number(process.env.CREXI_MAX_PAGES ?? 5);

const SCROLL_PASSES   = 6;
const SCROLL_STEP     = 900;
const SCROLL_DELAY_MS = 1800;
const CF_TIMEOUT_MS   = 25_000;
const LISTINGS_WAIT_MS = 45_000;
const PAGINATION_WAIT_MS = 12_000;

const CREXI_API_PATTERNS = [
  "api.crexi.com/assets/search",
  "api.crexi.com/properties/search",
  "/assets/search",
];

const NEXT_PAGE_SELECTORS = [
  "button[aria-label='Next page']",
  "button[aria-label='next page']",
  "crx-pagination button:last-of-type",
  "cui-pagination button:last-of-type",
  ".pagination-next",
  "[data-cy='paginationNext']",
  "button.next-page",
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
    if (CREXI_PROXY_POOL.length === 0) {
      logger.warn(
        "[crexi] No proxy configured. Crexi requires a RESIDENTIAL proxy to bypass Cloudflare.\n" +
          "  Set CREXI_PROXY_URL=http://user:pass@host:port in .env"
      );
    } else {
      logger.info(`[crexi] Proxy pool: ${CREXI_PROXY_POOL.length} proxy(ies) available`);
    }
  }

  // ── Launch browser with a specific proxy ──────────────────────────────────

  private async launchBrowser(proxyUrl?: string): Promise<Browser> {
    const launchOptions: any = {
      headless: true,
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

    if (proxyUrl) {
      launchOptions.proxy = { server: proxyUrl };
      const masked = proxyUrl.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
      logger.debug(`[crexi] Browser proxy: ${masked}`);
    }

    return chromium.launch(launchOptions) as unknown as Browser;
  }

  // ── Anti-detection page setup ─────────────────────────────────────────────

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

  // ── Cloudflare wait ───────────────────────────────────────────────────────

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

      const urlHasCF    = url.includes("__cf_chl");
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

  // ── Wait for Angular listing tiles ───────────────────────────────────────

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

  // ── Scroll to load lazy content ───────────────────────────────────────────

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

  // ── Click next page button ────────────────────────────────────────────────

  private async clickNextPage(page: Page): Promise<boolean> {
    for (const selector of NEXT_PAGE_SELECTORS) {
      try {
        const btn   = page.locator(selector).first();
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
      } catch { /* try next selector */ }
    }

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

    if (clicked) logger.info("[crexi] Clicked next-page via text/aria-label fallback");
    else         logger.info("[crexi] No clickable next-page button found");
    return clicked;
  }

  // ── Wait for page-turn XHR response ──────────────────────────────────────

  private async waitForPageTurnResponse(
    page: Page,
    previousCount: number,
    getIntercepted: () => number
  ): Promise<boolean> {
    try {
      await page.waitForLoadState("networkidle", { timeout: 8_000 });
    } catch { /* fine */ }

    const deadline = Date.now() + PAGINATION_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(600);
      if (getIntercepted() > previousCount) return true;
    }

    const hasTiles = await page.evaluate(() =>
      document.querySelectorAll("crx-sales-property-tile").length > 0
    ).catch(() => false);
    return hasTiles;
  }

  // ── Scrape one URL (pagination included) ─────────────────────────────────

  private async scrapeUrl(page: Page, searchUrl: string): Promise<RawListing[]> {
    logger.info(`[crexi] → ${searchUrl}`);

    const interceptedListings: RawListing[] = [];

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
      } catch { /* non-JSON */ }
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

      for (let pageNum = 2; pageNum <= MAX_PAGES_PER_URL; pageNum++) {
        logger.info(`[crexi] Attempting pagination to page ${pageNum}…`);
        const clicked = await this.clickNextPage(page);
        if (!clicked) {
          logger.info(`[crexi] No more pages for ${searchUrl} (stopped at page ${pageNum - 1})`);
          break;
        }

        const countBefore = interceptedListings.length;
        const gotNew = await this.waitForPageTurnResponse(
          page, countBefore, () => interceptedListings.length
        );

        if (!gotNew) {
          logger.info(`[crexi] No new listings on page ${pageNum} — stopping pagination`);
          break;
        }

        logger.info(
          `[crexi] Page ${pageNum}: +${interceptedListings.length - countBefore} listings ` +
          `(running total: ${interceptedListings.length})`
        );

        await this.scrollToLoadMore(page);
        await sleep(1000 + Math.random() * 500);
      }

      if (interceptedListings.length > 0) {
        logger.info(`[crexi] Final intercepted count: ${interceptedListings.length}`);
        return this.dedupeListings(interceptedListings);
      }

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

  // ── Main scrape — fresh browser + rotated proxy per URL ───────────────────

  protected async scrapePage(
    _handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    if (pageNumber !== 1) return [];

    const allListings: RawListing[] = [];

    for (let i = 0; i < SEARCH_URLS.length; i++) {
      const url      = SEARCH_URLS[i];
      const proxyUrl = CREXI_PROXY_POOL.length > 0
        ? CREXI_PROXY_POOL[i % CREXI_PROXY_POOL.length]
        : undefined;

      logger.info(`[crexi] URL ${i + 1}/${SEARCH_URLS.length}`);

      let browser: Browser | undefined;
      try {
        browser = await this.launchBrowser(proxyUrl);

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

        const listings = await this.scrapeUrl(page, url);
        allListings.push(...listings);

        await context.close();
      } catch (err: any) {
        logger.error(`[crexi] Browser error on URL ${i + 1}: ${err.message}`);
      } finally {
        await browser?.close(); // Full teardown — clean slate for next URL
      }

      if (i < SEARCH_URLS.length - 1) {
        const pause = 12_000 + Math.random() * 8_000; // 12–20s between URLs
        logger.info(`[crexi] Pausing ${Math.round(pause / 1000)}s before next URL…`);
        await sleep(pause);
      }
    }

    const deduped = this.dedupeListings(allListings);
    logger.info(`[crexi] Total: ${deduped.length} unique listings`);
    return deduped;
  }

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= 1;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

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