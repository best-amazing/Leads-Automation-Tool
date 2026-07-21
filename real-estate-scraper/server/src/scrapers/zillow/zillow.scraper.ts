// src/scrapers/zillow/zillow.scraper.ts
//
// Off-market refactor — what changed:
//
//   1. Multi-market loop: scraper now iterates config.sources.zillow.markets[]
//      (one entry per state × listing-type combination) exactly like Redfin/
//      Propwire do. The old single-string baseUrl is gone.
//
//   2. buildPageUrl() sets filterState flags to target ONLY off-market types:
//        fore=true / pf=false  → bank-owned REO / foreclosure
//        pf=true   / fore=false → pre-foreclosure
//      All on-market types (fsba, fsbo, nc, cmsn, auc) are disabled.
//
//   3. passesFilterOffMarket() replaces the inherited passesFilter():
//        - ZESTIMATE REQUIRED: all stored listings must have a Zestimate value.
//        - Price is optional; pre-foreclosures frequently have no list price.
//        - Falls back to zestimate for the min/max range check.
//
//   4. listingType is stamped onto every RawListing so the scorer/DB can
//      distinguish "pre_foreclosure" from "foreclosure" at a glance.
//
//   5. visited set is shared across markets so cross-market duplicates
//      (same zpid appearing in both OH pre-foreclosure and OH foreclosure)
//      are deduplicated automatically.
//
//   6. Per-market debug files: zillow_html_p1_ohio_pre_foreclosure.html etc.
//      so logs stay organised when running multiple markets.
// ─────────────────────────────────────────────────────────────────────────────

import * as https from "https";
import * as http  from "http";
import * as zlib  from "zlib";
import * as fs    from "fs";
import * as path  from "path";

import { BaseScraper, ScraperOptions } from "../base.scraper";
import { RawListing }                  from "../../types/listing";
import { logger }                      from "../../utils/logger";
import { sleep, jitter }               from "../../utils/browser";
import { parseZillowResults, MAX_DAYS_OLD } from "./zillow.parser";
import { config }                      from "../../config";

// ── Constants ─────────────────────────────────────────────────────────────────

const OXYLABS_ENDPOINT   = "realtime.oxylabs.io";
const OXYLABS_PATH       = "/v1/queries";
const OXYLABS_USERNAME   = process.env.OXYLABS_USERNAME ?? "";
const OXYLABS_PASSWORD   = process.env.OXYLABS_PASSWORD ?? "";

const REQUEST_TIMEOUT_MS = 120_000;
const BETWEEN_PAGE_MS    = 3_000;
const BETWEEN_MARKET_MS  = 5_000;   // extra pause between markets
const DEBUG_PAGES        = 3;       // save raw HTML/JSON for first N pages per market
const MAX_DETAIL_SAVES   = 3;       // how many detail-page __NEXT_DATA__ files to save

// ── Types ─────────────────────────────────────────────────────────────────────

export type OffMarketType = "pre_foreclosure" | "foreclosure" | "active";

interface MarketConfig {
  name:        string;
  baseUrl:     string;
  listingType: OffMarketType;
}

// ── URL builder ───────────────────────────────────────────────────────────────
//
// Zillow filterState flag reference:
//   fsba  — for sale by agent    → false  (exclude all on-market)
//   fsbo  — for sale by owner    → false
//   nc    — new construction     → false
//   cmsn  — coming soon          → false
//   auc   — auctions             → false  (separate workflow if needed)
//   fore  — bank-owned / REO     → true   when listingType === "foreclosure"
//   pf    — pre-foreclosure      → true   when listingType === "pre_foreclosure"
//
// Zillow's UI only allows one of fore/pf active at a time — we honour that by
// having separate market entries per type rather than combining them.

function buildPageUrl(
  baseUrl:     string,
  listingType: OffMarketType,
  pageNumber:  number,
  ignorePriceFilter: boolean = false
): string {
  const [basePath] = baseUrl.split("?");

  const filterState: Record<string, any> = {
    // Disable on-market listing types unless active is requested
    fsba: { value: listingType === "active" },
    fsbo: { value: listingType === "active" },
    nc:   { value: false }, // new construction
    cmsn: { value: false }, // coming soon
    auc:  { value: false }, // auctions
    // Enable exactly the requested off-market type
    fore: { value: listingType === "foreclosure" },
    pf:   { value: listingType === "pre_foreclosure" },
  };

  if (!ignorePriceFilter) {
    filterState.price = { max: config.filter.maxPrice };
  }

  const state: Record<string, any> = {
    filterState,
    sortSelection: { value: "globalrelevanceex" },
  };

  if (pageNumber > 1) state.pagination = { currentPage: pageNumber };

  return `${basePath}?searchQueryState=${encodeURIComponent(JSON.stringify(state))}`;
}

// ── Off-market listing filter ─────────────────────────────────────────────────
//
// Key differences vs the inherited passesFilter():
//
//   1. ZESTIMATE REQUIRED: Only listings with a Zestimate are accepted.
//      This ensures all stored listings have an estimate value for enrichment.
//
//   2. Price is OPTIONAL.  Pre-foreclosures on Zillow often have no list price
//      — only a loan balance or nothing.  We fall back to zestimate for the
//      range check rather than rejecting the listing outright.
//
//   3. We still require url + address for deduplication and downstream use.

function passesFilterOffMarket(listing: RawListing): boolean {
  if (!listing.url)     return false;
  if (!listing.address) return false;

  // ZESTIMATE REQUIRED
  const zestimate = (listing as any).zestimate;
  if (zestimate == null) return false;

  // Check price range (use zestimate since price may be null)
  const effectivePrice = listing.price ?? zestimate;

  if (effectivePrice < config.filter.minPrice) return false;
  if (effectivePrice > config.filter.maxPrice) return false;

  return true;
}

// ── Slug helper ───────────────────────────────────────────────────────────────

function marketSlug(market: MarketConfig): string {
  return market.name.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

// ── Oxylabs HTTP client ───────────────────────────────────────────────────────

interface OxylabsPayload {
  source:          string;
  url:             string;
  render:          string;
  geo_location:    string;
  user_agent_type: string;
  session_id?:     string;
}

interface OxylabsResponse {
  results: Array<{
    content:     string;
    status_code: number;
    url:         string;
    job_id:      string;
  }>;
}

export function oxylabsFetch(targetUrl: string, sessionId?: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
      logger.error(
        "[zillow] Oxylabs credentials missing — add to .env:\n" +
        "[zillow]   OXYLABS_USERNAME=your_api_user\n" +
        "[zillow]   OXYLABS_PASSWORD=your_api_password"
      );
      resolve(null);
      return;
    }

    const payload: OxylabsPayload = {
      source:          "universal",
      url:             targetUrl,
      render:          "html",
      geo_location:    "United States",
      user_agent_type: "desktop",
      ...(sessionId ? { session_id: sessionId } : {}),
    };

    const bodyStr = JSON.stringify(payload);
    const authStr = Buffer.from(`${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`).toString("base64");

    const req = https.request(
      {
        hostname: OXYLABS_ENDPOINT,
        path:     OXYLABS_PATH,
        method:   "POST",
        family:   4,
        headers:  {
          "Content-Type":   "application/json",
          "Authorization":  `Basic ${authStr}`,
          "Content-Length": Buffer.byteLength(bodyStr).toString(),
        },
      },
      (res: http.IncomingMessage) => {
        const enc    = (res.headers["content-encoding"] ?? "").toLowerCase();
        const chunks: Buffer[] = [];
        const stream =
          enc === "gzip"    ? res.pipe(zlib.createGunzip())           :
          enc === "deflate" ? res.pipe(zlib.createInflate())          :
          enc === "br"      ? res.pipe(zlib.createBrotliDecompress()) :
          res as any;

        (stream as NodeJS.ReadableStream).on("data", (c: Buffer) => chunks.push(c));
        (stream as NodeJS.ReadableStream).on("end", () => {
          const raw    = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;

          if (status === 401) { logger.error("[zillow] Oxylabs 401 — bad credentials"); resolve(null); return; }
          if (status === 429) { logger.warn("[zillow] Oxylabs 429 — rate limited");      resolve(null); return; }
          if (status !== 200) {
            logger.warn(`[zillow] Oxylabs HTTP ${status}`);
            logger.debug(`[zillow] Body snippet: ${raw.slice(0, 300)}`);
            resolve(null); return;
          }

          let parsed: OxylabsResponse;
          try { parsed = JSON.parse(raw); } catch {
            logger.warn("[zillow] Could not parse Oxylabs envelope");
            resolve(null); return;
          }

          const result      = parsed?.results?.[0];
          const content     = result?.content ?? "";
          const innerStatus = result?.status_code ?? 0;

          if (innerStatus === 403 || innerStatus === 429) {
            logger.warn(`[zillow] Zillow HTTP ${innerStatus} via Oxylabs`);
            resolve(null); return;
          }
          if (!content || content.length < 5_000) {
            logger.warn(`[zillow] Short content (${content.length} chars) — possible block`);
            resolve(null); return;
          }

          logger.debug(`[zillow] Oxylabs OK — ${content.length} chars, inner ${innerStatus}`);
          resolve(content);
        });

        (stream as NodeJS.ReadableStream).on("error", (err: any) => {
          logger.warn(`[zillow] Stream error: ${err.message}`);
          resolve(null);
        });
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      logger.warn(`[zillow] Oxylabs timed out after ${REQUEST_TIMEOUT_MS / 1_000}s`);
      req.destroy(); resolve(null);
    });

    req.on("error", (err: any) => {
      logger.error(`[zillow] Request error: [${err.code ?? "?"}] ${err.message}`);
      resolve(null);
    });

    req.write(bodyStr);
    req.end();
  });
}

// ── __NEXT_DATA__ extractor ───────────────────────────────────────────────────

export function extractNextData(html: string): any | null {
  const match = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!match?.[1]) return null;
  try { return JSON.parse(match[1]); } catch (err) {
    logger.warn(`[zillow] Failed to parse __NEXT_DATA__: ${err}`);
    return null;
  }
}

// ── Block detection ───────────────────────────────────────────────────────────

const BLOCK_TITLES = [
  "access to this page has been denied",
  "access denied",
  "attention required",
  "just a moment",
  "security check",
];

const BLOCK_BODY_SIGNALS = [
  'id="px-captcha"',
  'id="_pxCaptcha"',
  "challenges.cloudflare.com",
  "cf-browser-verification",
  "errors.edgesuite.net",
  "Enable JavaScript and cookies to continue",
  "Verifying you are human. Please stand by",
];

function detectBlock(html: string): { blocked: boolean; reason: string } {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").toLowerCase().trim();
  if (BLOCK_TITLES.some(t => title.includes(t)))
    return { blocked: true, reason: `block title: "${title}"` };

  const sig = BLOCK_BODY_SIGNALS.find(s => html.includes(s));
  if (sig)
    return { blocked: true, reason: `body signal: ${sig}` };

  if (html.length < 3_000 && !html.includes("__NEXT_DATA__") && !html.includes("zillowstatic.com"))
    return { blocked: true, reason: `too short (${html.length} chars)` };

  return { blocked: false, reason: "" };
}

// ── File helpers ──────────────────────────────────────────────────────────────

function ensureLogDir(): string {
  const dir = path.resolve("logs");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function saveFile(filename: string, content: string): void {
  try {
    const file = path.join(ensureLogDir(), filename);
    fs.writeFileSync(file, content, "utf-8");
    logger.info(`[zillow] Saved → logs/${filename}`);
  } catch (err) {
    logger.warn(`[zillow] Could not save ${filename}: ${err}`);
  }
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class ZillowScraper extends BaseScraper {
  readonly sourceName: string = "zillow";

  // visited is inherited from BaseScraper and shared across all markets
  // so we automatically deduplicate the same zpid appearing in multiple markets.
  private allListings: RawListing[] = [];
  private readonly sessionId = `zillow_${Date.now()}_${Math.floor(Math.random() * 9_999)}`;

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  // ── run() — iterates every market in config.sources.zillow.markets ────────

  override async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting off-market scrape (Oxylabs)`);

    this.visited.clear();
    this.results     = [];
    this.allListings = [];

    const zillowCfg = config.sources.zillow;
    const markets   = zillowCfg.markets;

    const rejected: Array<{ listing: RawListing; reason: string }> = [];

    for (const market of markets) {
      if (this.results.length >= this.options.maxListings) {
        logger.info(`[${this.sourceName}] maxListings (${this.options.maxListings}) reached — stopping`);
        break;
      }

      logger.info(`[${this.sourceName}] ── Market: ${market.name} (${market.listingType}) ──`);

      let stopPaging = false;

      for (let page = 1; page <= zillowCfg.maxPagesPerMarket; page++) {
        if (stopPaging)                                    break;
        if (this.results.length >= this.options.maxListings) break;

        logger.info(`[${this.sourceName}] ${market.name} — page ${page}/${zillowCfg.maxPagesPerMarket}`);

        let pageListings: RawListing[] = [];
        try {
          const result = await this.scrapeMarketPage(market, page);
          pageListings = result.listings;
          if (result.stop) stopPaging = true;
        } catch (err) {
          logger.error(`[${this.sourceName}] ${market.name} page ${page} error: ${err}`);
          continue;
        }

        logger.info(`[${this.sourceName}] ${market.name} page ${page}: ${pageListings.length} raw listing(s)`);

        this.allListings.push(...pageListings);

        for (const listing of pageListings) {
          if (this.results.length >= this.options.maxListings) break;

          if (!listing.url) {
            rejected.push({ listing, reason: "no_url" }); continue;
          }
          if (this.visited.has(listing.url)) {
            rejected.push({ listing, reason: "already_seen" }); continue;
          }

          // Use off-market-aware filter (tolerates missing price)
          if (!passesFilterOffMarket(listing)) {
            rejected.push({ listing, reason: "filtered" });
            logger.debug(
              `[${this.sourceName}] ✗ Filtered: ${listing.address} ` +
              `@ ${listing.price ?? "no price"} (zestimate: ${(listing as any).zestimate ?? "none"})`
            );
            continue;
          }

          this.visited.add(listing.url);
          this.results.push(listing);
          logger.info(
            `[${this.sourceName}] ✓ [${this.results.length}/${this.options.maxListings}] ` +
            `[] ${listing.address ?? listing.title} ` +
            `@ ${listing.price != null ? "$" + listing.price.toLocaleString() : "no price"} ` +
            ((listing as any).zestimate ? `| Zestimate $${(listing as any).zestimate.toLocaleString()}` : "| no Zestimate")
          );
        }

        if (pageListings.length === 0) {
          logger.info(`[${this.sourceName}] ${market.name} — no listings on page ${page}, stopping`);
          break;
        }

        await sleep(jitter(BETWEEN_PAGE_MS));
      }

      logger.info(
        `[${this.sourceName}] ${market.name} done — ` +
        `${this.results.length} total accepted so far`
      );

      // Pause between markets to avoid hammering Oxylabs
      if (markets.indexOf(market) < markets.length - 1) {
        await sleep(jitter(BETWEEN_MARKET_MS));
      }
    }

    logger.info(
      `[${this.sourceName}] Finished all markets — ` +
      `${this.results.length} accepted, ${rejected.length} rejected`
    );

    // Write full debug JSON
    saveFile(
      `${this.sourceName}.json`,
      JSON.stringify(
        {
          accepted:    this.results,
          rejected,
          allListings: this.allListings,
          generatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    return this.results;
  }

  // ── scrapeMarketPage ──────────────────────────────────────────────────────

  protected async scrapeMarketPage(
    market:     MarketConfig,
    pageNumber: number,
    ignorePriceFilter: boolean = false
  ): Promise<{ listings: RawListing[]; stop: boolean }> {

    const pageUrl = buildPageUrl(market.baseUrl, market.listingType, pageNumber, ignorePriceFilter);
    const slug    = marketSlug(market);

    logger.info(`[zillow] ${market.name} page ${pageNumber} → ${pageUrl}`);

    const html = await oxylabsFetch(pageUrl, this.sessionId);
    if (!html) {
      logger.warn(`[zillow] No HTML for ${market.name} page ${pageNumber} — stopping market`);
      return { listings: [], stop: true };
    }

    if (pageNumber <= DEBUG_PAGES) {
      saveFile(`zillow_html_p${pageNumber}_${slug}.html`, html);
    }

    const { blocked, reason } = detectBlock(html);
    if (blocked) {
      logger.error(`[zillow] Blocked on ${market.name} page ${pageNumber}: ${reason}`);
      saveFile(`zillow_blocked_p${pageNumber}_${slug}.html`, html);
      return { listings: [], stop: true };
    }

    if (!html.includes("zillowstatic.com") && !html.includes("__NEXT_DATA__")) {
      logger.error(`[zillow] ${market.name} page ${pageNumber} doesn't look like Zillow`);
      saveFile(`zillow_unexpected_p${pageNumber}_${slug}.html`, html);
      return { listings: [], stop: true };
    }

    const json = extractNextData(html);
    if (!json) {
      logger.warn(`[zillow] No __NEXT_DATA__ on ${market.name} page ${pageNumber}`);
      saveFile(`zillow_no_next_data_p${pageNumber}_${slug}.html`, html);
      return { listings: [], stop: true };
    }

    if (pageNumber <= DEBUG_PAGES) {
      saveFile(`zillow_json_p${pageNumber}_${slug}.json`, JSON.stringify(json, null, 2));
    }

    const searchJson             = json?.props?.pageProps?.searchPageState ?? json;
    const { listings, allStale } = parseZillowResults(searchJson);

    logger.info(
      `[zillow] ${market.name} page ${pageNumber}: ` +
      `${listings.length} listing(s) within ${MAX_DAYS_OLD} days` +
      (allStale ? " — all stale" : "")
    );

    const withZestimate = listings.filter(l => (l as any).zestimate != null).length;
    logger.info(
      `[zillow] ${market.name} page ${pageNumber}: ` +
      `${withZestimate}/${listings.length} listings have a Zestimate`
    );

    // Stamp listingType onto every result so the scorer/DB knows what it is
    const stamped = listings.map(l => ({
      ...l,
      source:      this.sourceName,
      listingType: market.listingType,
    }));

    return { listings: stamped, stop: allStale };
  }

  // scrapePage is not used in this override-based scraper but must satisfy
  // the abstract base class contract.
  protected async scrapePage(_handle: any, _pageNumber: number): Promise<RawListing[]> {
    return [];
  }

  /**
   * Fetch the Zillow detail page for a single listing and extract its
   * full text description from __NEXT_DATA__. Returns an empty string
   * if the page cannot be fetched or the description is not found.
   */
  protected async fetchListingDescription(listingUrl: string): Promise<string> {
    try {
      const html = await oxylabsFetch(listingUrl, this.sessionId);
      if (!html) return "";

      const json = extractNextData(html);
      if (!json) return "";

      // ── Save raw __NEXT_DATA__ for inspection ──────────────────────────────
      // Open logs/zillow_detail_nextdata_<n>.json and search for your listing's
      // description text. The correct JSON path will tell you what to update
      // in the extraction below. Look inside props.pageProps at:
      //   componentProps, gdpClientCache, initialReduxState, apiCache, etc.
      if (!this._detailSaveCount) this._detailSaveCount = 0;
      if (this._detailSaveCount < MAX_DETAIL_SAVES) {
        this._detailSaveCount++;
        const saveN = this._detailSaveCount;
        try {
          const dir = path.resolve("logs");
          fs.mkdirSync(dir, { recursive: true });
          const filename = path.join(dir, `zillow_detail_nextdata_${saveN}.json`);
          fs.writeFileSync(filename, JSON.stringify(json, null, 2), "utf-8");
          logger.info(`[zillow] Detail __NEXT_DATA__ saved → logs/zillow_detail_nextdata_${saveN}.json`);

          // Also log the immediate keys of pageProps so you can see what
          // top-level buckets are available without opening the file.
          const pageProps = json?.props?.pageProps;
          if (pageProps) {
            logger.info(
              `[zillow] detail pageProps keys: ${Object.keys(pageProps).join(", ")}`
            );
            // If gdpClientCache exists, log its first entry's keys too
            const cache = pageProps.gdpClientCache;
            if (cache && typeof cache === "object") {
              const firstCacheKey = Object.keys(cache)[0];
              if (firstCacheKey) {
                logger.info(
                  `[zillow] gdpClientCache["${firstCacheKey}"] keys: ` +
                  `${Object.keys(cache[firstCacheKey] ?? {}).join(", ")}`
                );
                const prop = cache[firstCacheKey]?.property;
                if (prop) {
                  logger.info(
                    `[zillow] gdpClientCache.property keys: ${Object.keys(prop).join(", ")}`
                  );
                }
              }
            }
          }
        } catch (saveErr) {
          logger.warn(`[zillow] Could not save detail __NEXT_DATA__: ${saveErr}`);
        }
      }
      // ───────────────────────────────────────────────────────────────────────

      // Zillow embeds the description in several known locations inside __NEXT_DATA__
      const props = json?.props?.pageProps;
      
      let description = props?.componentProps?.description ?? "";

      // Sometimes gdpClientCache is directly under pageProps, sometimes under componentProps
      // and sometimes it is a JSON string rather than an object.
      if (!description) {
        const rawCache = props?.gdpClientCache ?? props?.componentProps?.gdpClientCache;
        if (rawCache) {
          try {
            const cache = typeof rawCache === "string" ? JSON.parse(rawCache) : rawCache;
            for (const key of Object.keys(cache ?? {})) {
              if (cache[key]?.property?.description) {
                description = cache[key].property.description;
                break;
              }
            }
          } catch {
            // ignore
          }
        }
      }

      return typeof description === "string" ? description : "";
    } catch (err) {
      logger.warn(`[zillow] Could not fetch description for ${listingUrl}: ${err}`);
      return "";
    }
  }

  // Counter for how many detail __NEXT_DATA__ files have been saved this run
  private _detailSaveCount = 0;

  protected hasMorePages(_pageNumber: number, lastPageResults: RawListing[]): boolean {
    return lastPageResults.length > 0;
  }
}