// src/scrapers/offmarket/offmarket.scraper.ts

import { Page } from "playwright";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import {
  parseOffmarketSearchPage,
  parseOffmarketDetailPage,
  extractPaginationInfo,
  extractStateFromUrl,
  OffmarketDetail,
} from "./offmarket.parser";
import * as fs from "fs";
import * as path from "path";

const HOME_URL = "https://www.offmarket.com";
const AJAX_URL = "https://www.offmarket.com/wp-admin/admin-ajax.php";

// ── State abbreviation → full lowercase name map ───────────────────────────
//
// Used to build the &lp_s_loc= query param that offmarket.com requires
// alongside ?state=XX for proper state-level filtering.
// e.g. https://www.offmarket.com/listing-category/residential/?state=OH&lp_s_loc=ohio

const STATE_FULL_NAME: Record<string, string> = {
  AL: "alabama",      AK: "alaska",       AZ: "arizona",      AR: "arkansas",
  CA: "california",   CO: "colorado",     CT: "connecticut",  DE: "delaware",
  FL: "florida",      GA: "georgia",      HI: "hawaii",       ID: "idaho",
  IL: "illinois",     IN: "indiana",      IA: "iowa",         KS: "kansas",
  KY: "kentucky",     LA: "louisiana",    ME: "maine",        MD: "maryland",
  MA: "massachusetts",MI: "michigan",     MN: "minnesota",    MS: "mississippi",
  MO: "missouri",     MT: "montana",      NE: "nebraska",     NV: "nevada",
  NH: "new hampshire",NJ: "new jersey",   NM: "new mexico",   NY: "new york",
  NC: "north carolina",ND: "north dakota",OH: "ohio",         OK: "oklahoma",
  OR: "oregon",       PA: "pennsylvania", RI: "rhode island", SC: "south carolina",
  SD: "south dakota", TN: "tennessee",    TX: "texas",        UT: "utah",
  VT: "vermont",      VA: "virginia",     WA: "washington",   WV: "west virginia",
  WI: "wisconsin",    WY: "wyoming",      DC: "district of columbia",
};

// ── State-specific search URLs ─────────────────────────────────────────────
//
// offmarket.com requires BOTH params for reliable state filtering:
//   ?state=OH        — uppercase 2-letter abbreviation
//   &lp_s_loc=ohio   — lowercase full state name
//
// Without &lp_s_loc= the server ignores the state filter and returns all US
// listings.  Without ?state= the location sidebar won't highlight correctly.
//
// Fallback: if OFFMARKET_SEARCH_URL is set explicitly, honour it (single-URL
// mode).  Otherwise, derive one URL per entry in this.filterStates (from
// constructor options or OFFMARKET_STATES env).

const FILTER_STATES_DEFAULT: string[] = ["OH", "WI"];

const FILTER_CITIES_DEFAULT: string[] = [];

// Build state-filtered search URLs using both ?state=XX and &lp_s_loc=name.
function buildSearchUrls(states: string[]): string[] {
  if (process.env.OFFMARKET_SEARCH_URL) {
    return [process.env.OFFMARKET_SEARCH_URL];
  }

  return states.map((st) => {
    const abbr     = st.toUpperCase();
    const fullName = STATE_FULL_NAME[abbr];

    if (!fullName) {
      logger.warn(
        `[offmarket] No full-name mapping for state "${abbr}" — ` +
        `&lp_s_loc= will be omitted; results may not be filtered correctly`
      );
      return `https://www.offmarket.com/listing-category/residential/?state=${abbr}`;
    }

    // Both params required for proper server-side filtering
    const encodedName = encodeURIComponent(fullName); // handles "new jersey" etc.
    return (
      `https://www.offmarket.com/listing-category/residential/` +
      `?state=${abbr}&lp_s_loc=${encodedName}`
    );
  });
}

const DETAIL_DELAY_MS = 4_000;
const MAX_RETRIES     = 3;
const THIRTY_DAYS_MS  = 30 * 24 * 60 * 60 * 1000;

// ── 30-day date filter ─────────────────────────────────────────────────────
//
// Fail-open: if we can't determine a date we don't discard potentially valid
// listings.  The real filtering is the state-level URL param above.

function isWithinThirtyDays(dateVal: string | number | undefined): boolean {
  if (dateVal === undefined || dateVal === "") return true;
  const parsed = typeof dateVal === "number" ? new Date(dateVal) : new Date(dateVal);
  if (isNaN(parsed.getTime())) return true;
  return Date.now() - parsed.getTime() <= THIRTY_DAYS_MS;
}

// ── Location filter ────────────────────────────────────────────────────────

function passesLocationFilter(
  listing: Partial<RawListing> & { url: string },
  filterStates: string[],
  filterCities: string[],
): boolean {
  const state =
    (listing as any).state ??
    extractStateFromUrl(listing.url);

  if (!state) {
    logger.debug(`[offmarket] Location unknown (fail-open): ${listing.url}`);
    return true;
  }

  if (!filterStates.includes(state.toUpperCase())) return false;

  if (filterCities.length === 0) return true;

  const haystack = [
    (listing as any).city,
    listing.address,
    (listing as any).location,
    listing.url,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return filterCities.some((city) => haystack.includes(city));
}

// ── Per-state scrape session ───────────────────────────────────────────────

interface StateSession {
  searchUrl:     string;
  pagInfo:       any;
  ajaxPage:      Page | null;
  totalFetched:  number;
  done:          boolean;
}

// ── Scraper ────────────────────────────────────────────────────────────────

export class OffmarketScraper extends BaseScraper {
  readonly sourceName: string = "offmarket";

  private cookiesWarmed = false;

  private _sessions: StateSession[] = [];
  private _sessionsInitialized = false;

  protected filterStates: string[];
  protected filterCities: string[];
  protected searchUrls: string[];

  constructor(options: ScraperOptions = {}) {
    super(options);

    this.filterStates = (
      options.states ??
      (process.env.OFFMARKET_STATES
        ? process.env.OFFMARKET_STATES.split(",").map((s) => s.trim().toUpperCase())
        : FILTER_STATES_DEFAULT)
    ).map((s: string) => s.toUpperCase());

    this.filterCities = (
      options.cities ??
      (process.env.OFFMARKET_CITIES
        ? process.env.OFFMARKET_CITIES.split(",").map((s) => s.trim().toLowerCase())
        : FILTER_CITIES_DEFAULT)
    ).map((s: string) => s.toLowerCase());

    this.searchUrls = buildSearchUrls(this.filterStates);

    if (!process.env.PROXY_URL) {
      logger.warn(
        "[offmarket] ⚠️  No PROXY_URL — offmarket.com may geo-block non-US IPs.\n" +
          "  Add: PROXY_URL=http://user:pass@us-host:port"
      );
    }

    logger.info(`[offmarket] State filter:  ${this.filterStates.join(", ")}`);
    logger.info(`[offmarket] Search URLs:   ${this.searchUrls.join(" | ")}`);
    if (this.filterCities.length) {
      logger.info(`[offmarket] City filter:   ${this.filterCities.join(", ")}`);
    }
  }

  // ── hasMorePages ──────────────────────────────────────────────────────────

  protected hasMorePages(_pageNumber: number, _lastPageResults: RawListing[]): boolean {
    if (!this._sessionsInitialized) return true;
    return this._sessions.some((s) => !s.done);
  }

  // ── Session warm-up ───────────────────────────────────────────────────────

  private async warmSession(page: Page): Promise<void> {
    logger.info("[offmarket] Warming session…");
    try {
      await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(4000 + Math.random() * 2000);
      for (const y of [300, 600, 400, 0]) {
        await page.evaluate(`window.scrollTo(0, ${y})`);
        await sleep(300 + Math.random() * 200);
      }
      try {
        await page.goto(
          "https://www.offmarket.com/listing-category/real-estate/",
          { waitUntil: "domcontentloaded", timeout: 30_000 }
        );
        await sleep(3000 + Math.random() * 2000);
      } catch {}
      await sleep(8000 + Math.random() * 5000);
      this.cookiesWarmed = true;
      logger.debug("[offmarket] Session warmed");
    } catch (err) {
      logger.warn(`[offmarket] Warm failed (non-fatal): ${err}`);
    }
  }

  // ── Block detection ───────────────────────────────────────────────────────

  private detectBlock(
    html: string
  ): "wordfence" | "rate_limit" | "challenge" | "none" {
    const lower = html.toLowerCase();
    if (lower.includes("too many requests") || lower.includes("rate-limited"))
      return "rate_limit";
    if (
      lower.includes("wordfence") ||
      lower.includes("your access to this site has been limited") ||
      lower.includes("access from your area has been temporarily limited")
    )
      return "wordfence";
    if (
      lower.includes("checking your browser") ||
      (lower.includes("cf-chl-") &&
        (lower.includes("challenge") || lower.includes("turnstile"))) ||
      lower.includes("cf-chl-opt")
    )
      return "challenge";
    return "none";
  }

  // ── Fetch search page ─────────────────────────────────────────────────────

  private async fetchSearchPage(page: Page, url: string): Promise<string | null> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
        try {
          await page.waitForSelector("[data-posturl]", { timeout: 15_000 });
        } catch {}

        for (const y of [400, 900, 1400, 900, 400]) {
          await page.evaluate(`window.scrollTo(0, ${y})`);
          await sleep(250 + Math.random() * 250);
        }
        await sleep(1500);

        const html      = await page.content();
        const blockType = this.detectBlock(html);

        if (blockType === "wordfence") {
          logger.error(
            "[offmarket] ❌ Wordfence block. Use a US residential proxy.\n" +
              "  Fix: PROXY_URL=http://user:pass@us-residential-host:port"
          );
          this.saveDebug(html, "wordfence_block");
          return null;
        }

        if (blockType === "rate_limit") {
          const wait = 90_000 * attempt;
          logger.warn(`[offmarket] 429 on attempt ${attempt}. Waiting ${wait / 1000}s…`);
          this.saveDebug(html, `rate_limit_${attempt}`);
          if (attempt < MAX_RETRIES) await sleep(wait);
          continue;
        }

        if (blockType === "challenge") {
          logger.warn(
            `[offmarket] Cloudflare bot-check on attempt ${attempt}. Waiting for it to clear (max 45s)…`
          );
          this.saveDebug(html, `cf_challenge_${attempt}`);
          // The interstitial auto-resolves client-side; poll until the listing
          // cards render in place instead of tearing down the page.
          let resolved = false;
          for (let i = 0; i < 45; i++) {
            await sleep(1000);
            try {
              await page.waitForSelector("[data-posturl]", { timeout: 1000 });
              resolved = true;
              break;
            } catch {}
          }
          if (!resolved && attempt < MAX_RETRIES) {
            await sleep(10_000 * attempt);
            continue;
          }
          if (resolved) {
            const resolvedHtml = await page.content();
            if (this.detectBlock(resolvedHtml) !== "none") {
              if (attempt < MAX_RETRIES) continue;
            }
            return resolvedHtml;
          }
        }

        return html;
      } catch (err) {
        logger.warn(`[offmarket] Fetch attempt ${attempt}/${MAX_RETRIES}: ${err}`);
        if (attempt < MAX_RETRIES) await sleep(5000 * attempt);
      }
    }
    return null;
  }

  // ── AJAX Load More ────────────────────────────────────────────────────────
  //
  // The server's "Load More" button carries data-page="2" after page 1 loads
  // (i.e. "next page to fetch is 2").  We store that in pagInfo.loadMorePage.
  //
  // Correct page numbering:
  //   → call 1: loadMorePage + 0   (e.g. 2)
  //   → call 2: loadMorePage + 1   (e.g. 3)

  private async fetchLoadMore(
    session: StateSession,
    ajaxPageNum: number,
    termId: string
  ): Promise<string | null> {
    if (!session.ajaxPage) {
      logger.warn("[offmarket] AJAX: no stored page — cannot load more");
      return null;
    }

    logger.info(
      `[offmarket] AJAX Load More — server page ${ajaxPageNum} (${session.searchUrl})`
    );

    try {
      const result = await session.ajaxPage.evaluate(
        async ({ ajaxUrl, ajaxPageNum, termId }) => {
          const btn   = document.querySelector(".loadMoreListing") as HTMLElement | null;
          const nonce = btn?.getAttribute("data-rand-number") ?? "";

          const listedInput =
            (document.getElementById("listed_listing_id") as HTMLInputElement | null) ??
            (document.querySelector("input[name='listed_listing_id']") as HTMLInputElement | null);
          const listedIds = listedInput?.value ?? "";

          if (!nonce) console.warn("[offmarket] AJAX: no nonce found in DOM");

          const body = new URLSearchParams({
            action:            "ajax_listing_load_more",
            nonce,
            listed_listing_id: listedIds,
            page:              String(ajaxPageNum),
            term_id:           termId,
          });

          try {
            const res = await fetch(ajaxUrl, {
              method:  "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body:    body.toString(),
            });
            return res.ok ? await res.text() : null;
          } catch {
            return null;
          }
        },
        { ajaxUrl: AJAX_URL, ajaxPageNum, termId }
      );

      if (!result || result.trim() === "" || result.trim() === "0") {
        logger.warn(`[offmarket] AJAX Load More returned empty for server page ${ajaxPageNum}`);
        session.done = true;
        return null;
      }

      logger.debug(`[offmarket] AJAX response length: ${result.length} chars`);
      return result;
    } catch (err) {
      logger.warn(`[offmarket] AJAX Load More error: ${err}`);
      return null;
    }
  }

  // ── Update hasMore after each AJAX load ────────────────────────────────────

  private async refreshHasMore(session: StateSession): Promise<void> {
    if (!session.ajaxPage) return;

    const btnGone = !(await session.ajaxPage
      .evaluate(() => !!document.querySelector(".loadMoreListing"))
      .catch(() => false));

    const allFetched =
      session.pagInfo?.totalRecords > 0 &&
      session.totalFetched >= session.pagInfo.totalRecords;

    if (btnGone || allFetched) {
      logger.info(
        `[offmarket] Session done — btnGone:${btnGone} allFetched:${allFetched} ` +
        `(${session.totalFetched}/${session.pagInfo?.totalRecords}) URL:${session.searchUrl}`
      );
      session.done = true;
    }
  }

  // ── scrapePage ────────────────────────────────────────────────────────────

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {

    // ── Initialise sessions on first call ────────────────────────────────
    if (!this._sessionsInitialized) {
      this._sessions = this.searchUrls.map((url) => ({
        searchUrl:    url,
        pagInfo:      null,
        ajaxPage:     null,
        totalFetched: 0,
        done:         false,
      }));
      this._sessionsInitialized = true;
    }

    // Drain completed sessions
    while (this._sessions.length > 0 && this._sessions[0].done) {
      const s = this._sessions.shift()!;
      if (s.ajaxPage) {
        await s.ajaxPage.close().catch(() => {});
        s.ajaxPage = null;
        logger.debug(`[offmarket] Closed page for ${s.searchUrl}`);
      }
    }

    if (this._sessions.length === 0) {
      logger.info("[offmarket] All state sessions complete");
      return [];
    }

    const session = this._sessions[0];

    // ── First page of this session ────────────────────────────────────────
    if (!session.pagInfo) {
      const page = await handle.newPage();
      session.ajaxPage = page;

      if (!this.cookiesWarmed) await this.warmSession(page);

      logger.info(`[offmarket] Fetching first page: ${session.searchUrl}`);
      await sleep(3000 + Math.random() * 2000);

      const stateTag = this.stateTagFromUrl(session.searchUrl);
      const html = await this.fetchSearchPage(page, session.searchUrl);
      if (!html) {
        session.done = true;
        return [];
      }

      this.saveDebug(html, `page_1_${stateTag}`);

      const items   = parseOffmarketSearchPage(html);
      const pagInfo = extractPaginationInfo(html);

      logger.info(
        `[offmarket] ${stateTag} page 1: ${items.length} listings | ` +
        `Total: ${pagInfo.totalRecords} | hasMore: ${pagInfo.hasMore} | ` +
        `loadMorePage: ${pagInfo.loadMorePage}`
      );

      session.pagInfo      = pagInfo;
      session.totalFetched = items.length;

      // Initialise AJAX call counter
      session.pagInfo._ajaxCallCount = 0;

      if (!pagInfo.hasMore) session.done = true;

      return this.enrichAndFilter(items, session);
    }

    // ── Subsequent AJAX pages for this session ────────────────────────────
    if (session.done) return [];

    // Correct AJAX page numbering:
    //   loadMorePage = next page server wants (e.g. 2 after initial page loads)
    //   _ajaxCallCount starts at 0
    //   → call 1: loadMorePage + 0 = 2  ✓
    //   → call 2: loadMorePage + 1 = 3  ✓
    const ajaxCallCount = session.pagInfo._ajaxCallCount as number;
    const ajaxPageNum   = session.pagInfo.loadMorePage + ajaxCallCount;
    session.pagInfo._ajaxCallCount = ajaxCallCount + 1;

    const termId   = this.termIdFromUrl(session.searchUrl);
    const stateTag = this.stateTagFromUrl(session.searchUrl);

    logger.info(
      `[offmarket] ${stateTag} requesting AJAX page ${ajaxPageNum} ` +
      `(call #${ajaxCallCount + 1}, loadMorePage=${session.pagInfo.loadMorePage})`
    );

    const ajaxHtml = await this.fetchLoadMore(session, ajaxPageNum, termId);

    if (!ajaxHtml) {
      session.done = true;
      return [];
    }

    this.saveDebug(ajaxHtml, `ajax_${stateTag}_page_${ajaxPageNum}`);

    const wrapped = `<html><body><div id="content-grids">${ajaxHtml}</div></body></html>`;
    const items   = parseOffmarketSearchPage(wrapped);

    logger.info(
      `[offmarket] ${stateTag} AJAX server-page ${ajaxPageNum}: ${items.length} listings`
    );

    session.totalFetched += items.length;
    await this.refreshHasMore(session);

    return this.enrichAndFilter(items, session);
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /** Extract a short tag for log/debug labels from the search URL */
  private stateTagFromUrl(url: string): string {
    const m = url.match(/[?&]state=([A-Z]{2})/i);
    return m ? m[1].toUpperCase() : "ALL";
  }

  /**
   * Derive the term_id (WordPress category ID) from the search URL.
   * offmarket.com uses term_id=53 for Residential.
   */
  private termIdFromUrl(_url: string): string {
    return "53"; // Residential
  }

  // ── Enrich + filter ────────────────────────────────────────────────────────

  private async enrichAndFilter(
    rawItems: Omit<RawListing, "source">[],
    session: StateSession
  ): Promise<RawListing[]> {
    const enriched: RawListing[] = [];

    for (const item of rawItems) {
      let detail: OffmarketDetail = {};

      try {
        await sleep(DETAIL_DELAY_MS + Math.random() * 2000);

        if (!session.ajaxPage) throw new Error("no ajax page");

        const detailPage = await session.ajaxPage.context().newPage();

        try {
          await detailPage.goto(item.url, {
            waitUntil: "domcontentloaded",
            timeout:   45_000,
          });
          await sleep(1500);
          let detailHtml = await detailPage.content();

          if (this.detectBlock(detailHtml) === "challenge") {
            logger.warn(`[offmarket] CF challenge on detail page — waiting…`);
            for (let i = 0; i < 25; i++) {
              await sleep(1000);
              try {
                await detailPage.waitForSelector(
                  "main, article, .wp-post-image, img",
                  { timeout: 1000 }
                );
                break;
              } catch {}
            }
            detailHtml = await detailPage.content();
          }

          if (this.detectBlock(detailHtml) === "none") {
            detail = parseOffmarketDetailPage(detailHtml, item.url);
            logger.debug(`[offmarket] Enriched: ${item.url}`);
          }
        } finally {
          await detailPage.close().catch(() => {});
        }
      } catch (err) {
        logger.debug(`[offmarket] Detail failed for ${item.url}: ${err}`);
      }

      const merged: RawListing = {
        source: this.sourceName,
        ...item,
        ...detail,
        listedDate: detail.listedDate ?? (item as any).listedDate,
        state: detail.state ?? (item as any).state ?? extractStateFromUrl(item.url),
        city:  detail.city  ?? (item as any).city,
      };

      // ── Location filter (cheapest check — runs first) ─────────────────
      if (!passesLocationFilter(merged, this.filterStates, this.filterCities)) {
        logger.debug(
          `[offmarket] ✗ Location (state:${(merged as any).state}): ${item.url}`
        );
        continue;
      }

      // ── 30-day date filter ────────────────────────────────────────────
      if (!isWithinThirtyDays(merged.listedDate)) {
        logger.debug(
          `[offmarket] ✗ Date too old (${merged.listedDate}): ${item.url}`
        );
        continue;
      }

      logger.debug(
        `[offmarket] ✓ Kept (state:${(merged as any).state} city:${(merged as any).city} date:${merged.listedDate}): ${item.url}`
      );
      enriched.push(merged);
    }

    logger.info(
      `[offmarket] ${enriched.length} / ${rawItems.length} listings passed filters`
    );

    return enriched;
  }

  // ── Debug ─────────────────────────────────────────────────────────────────

  private saveDebug(html: string, label: string): void {
    try {
      const logDir = path.resolve(process.cwd(), "logs");
      fs.mkdirSync(logDir, { recursive: true });
      fs.writeFileSync(
        path.join(logDir, `offmarket_${label}.html`),
        html,
        "utf-8"
      );
      logger.debug(`[offmarket] Debug → logs/offmarket_${label}.html`);
    } catch {}
  }
}