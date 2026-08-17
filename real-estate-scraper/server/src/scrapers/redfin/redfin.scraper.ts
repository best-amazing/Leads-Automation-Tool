// src/scrapers/redfin/redfin.scraper.ts
//
// Uses Redfin's internal GIS JSON API instead of scraping HTML pages.
//
// WHY:  Redfin's HTML search pages are behind AWS WAF (CAPTCHA challenge).
//       All Oxylabs source types — universal, universal_ecommerce,
//       universal_chromium — either get HTTP 400 (not supported on this plan)
//       or inner 405 from Redfin's WAF.
//
// THE FIX: Hit /stingray/api/gis directly.  This is the XHR endpoint the
//       Redfin React app calls for search results.  It has no WAF challenge,
//       returns plain JSON, and does not need render:"html".
//       We use Oxylabs source:"universal" with render:false — a plain HTTP
//       GET that Oxylabs forwards without spinning up a browser.
//
// GIS endpoint:
//   GET https://www.redfin.com/stingray/api/gis
//     ?al=1
//     &region_id=<regionId>      ← numeric city ID from Redfin city URL:
//                                    redfin.com/city/<regionId>/<state>/<city>
//     &region_type=<regionType>  ← 6=city, 2=state
//     &uipt=1,4                  ← property types: 1=house, 4=multi-family
//     &max_price=300000
//     &num_homes=50              ← page size (max 350 but 50 is stable)
//     &start=<offset>            ← 0-based pagination offset
//     &status=1                  ← for-sale only
//     &sold_within_days=30       ← freshness filter
//
// Pagination: increment start by num_homes until homes.length === 0 or
//             start >= totalCount.
//
// Response: "{}&&" + JSON  (XSSI guard — stripped in parser)
//
// ── Phase 2: AVM enrichment via JSON API (replaces blocked HTML pages) ────────
//
// The HTML detail pages return HTTP 405 through Oxylabs because Redfin's
// WAF blocks browser-rendered requests on those URLs.  The stingray JSON
// endpoints have NO WAF protection — same as the GIS API.
//
// Strategy (two-step, both via render:false):
//
//   Step A — avmHistoricalData:
//     GET /stingray/api/home/details/avmHistoricalData
//         ?propertyId=<id>&accessLevel=1
//     No render needed.  Returns current Redfin Estimate + history.
//     This covers ~80% of active listings.
//
//   Step B — belowTheFold (fallback):
//     GET /stingray/api/home/details/belowTheFold
//         ?propertyId=<id>&accessLevel=1&pageType=1
//     No render needed.  Richer payload; slower response.
//     Used only when Step A yields no estimate.
//
//   Step C — HTML detail page (emergency fallback):
//     Only attempted if both API steps fail AND the listing URL is available.
//     Returns 405 in production Oxylabs — kept for local/alternative proxy use.
//
// The propertyId required for Steps A & B comes directly from the GIS
// response (home.propertyId — raw number, not enveloped).  It is stored on
// each listing as _redfinPropertyId during Phase 1 parsing.
//
// Debug artefacts → logs/
//   redfin_gis_<market>_p<N>.json          — raw GIS JSON per page
//   redfin_avm_<propertyId>.json           — raw avmHistoricalData response
//   redfin_btf_<propertyId>.json           — raw belowTheFold response
//   redfin_detail_<slug>.html              — HTML detail page (if attempted)
//   redfin.json                            — final accepted + rejected dump
//
// FIX (location mismatch): Redfin's GIS API sometimes returns listings from
//   entirely different states than the queried market. We extract the
//   two-letter state code from each listing URL and reject any that don't
//   match the market's state abbreviation.
//
// NOTE (region_id): Region IDs are the numeric city IDs embedded in Redfin's
//   city page URLs: https://www.redfin.com/city/<id>/<state>/<city-name>
//   These must be looked up manually by navigating to the city on redfin.com
//   and reading the ID from the URL. The autocomplete API
//   (/stingray/api/location-autocomplete) returns 404 and is not usable.
//
//   Verified IDs (from browser URL bar, April 2026):
//     Cleveland, OH  → 4145   (redfin.com/city/4145/OH/Cleveland)
//     Columbus, OH   → 4664   (redfin.com/city/4664/OH/Columbus)
//     Toledo, OH     → 19458  (redfin.com/city/19458/OH/Toledo)
//     Milwaukee, WI  → 35759  (redfin.com/city/35759/WI/Milwaukee)

import * as https from "https";
import * as http  from "http";
import * as zlib  from "zlib";
import * as fs    from "fs";
import * as path  from "path";

import { BaseScraper, ScraperOptions }  from "../base.scraper";
import { RawListing }                   from "../../types/listing";
import { logger }                       from "../../utils/logger";
import { sleep, jitter }                from "../../utils/browser";
import {
  parseRedfinApiResponse,
  parseRedfinDetailPage,
  parseAvmHistoricalData,
  parseBelowTheFold,
  buildAvmUrl,
  buildBelowTheFoldUrl,
  MAX_DAYS_OLD,
}                                       from "./redfin.parser";
import { config }                       from "../../config";

// ── Constants ─────────────────────────────────────────────────────────────────

const OXYLABS_ENDPOINT   = "realtime.oxylabs.io";
const OXYLABS_PATH       = "/v1/queries";
const OXYLABS_USERNAME   = process.env.OXYLABS_USERNAME ?? "";
const OXYLABS_PASSWORD   = process.env.OXYLABS_PASSWORD ?? "";

const REQUEST_TIMEOUT_MS  = 60_000;   // GIS + AVM calls are fast
const BETWEEN_PAGE_MS     = 1_500;    // delay between GIS pages
const BETWEEN_AVM_MS      = 800;      // delay between AVM API calls (no browser spin-up)
const BETWEEN_DETAIL_MS   = 2_000;    // delay for HTML fallback (if ever used)
const DEBUG_PAGES         = 3;        // save raw GIS JSON for first N pages per market

const GIS_BASE            = "https://www.redfin.com/stingray/api/gis";
const PAGE_SIZE           = 50;       // homes per request (max Redfin allows is 350)

// ── Types ─────────────────────────────────────────────────────────────────────

interface Market {
  name:       string;   // e.g. "Cleveland, OH"
  regionId:   number;
  regionType: number;
}

// Resolved market includes the two-letter state abbreviation extracted from
// the market name, used for URL-based location validation.
interface ResolvedMarket extends Market {
  stateAbbr: string;   // e.g. "OH"
}

// Extended listing type that carries the Redfin propertyId through Phase 1
// so Phase 2 AVM lookups can use the JSON API instead of the HTML page.
type ListingWithPid = RawListing & { _redfinPropertyId?: number };

// ── State abbreviation extractor ──────────────────────────────────────────────

function extractStateAbbr(marketName: string): string {
  const m = marketName.match(/,\s*([A-Z]{2})\s*$/);
  return m ? m[1] : "";
}

// ── GIS URL builder ───────────────────────────────────────────────────────────

function buildGisUrl(
  market:    ResolvedMarket,
  uipt:      number[],
  maxPrice:  number,
  start:     number,
  pageSize:  number
): string {
  const params = new URLSearchParams({
    al:               "1",
    region_id:        String(market.regionId),
    region_type:      String(market.regionType),
    uipt:             uipt.join(","),
    max_price:        String(maxPrice),
    num_homes:        String(pageSize),
    start:            String(start),
    status:           "1",
    sold_within_days: String(MAX_DAYS_OLD),
    sf:               "1,2,3,5,6,7",
    ord:              "time-on-redfin-asc",
  });
  return `${GIS_BASE}?${params.toString()}`;
}

// ── Location validator ────────────────────────────────────────────────────────

function listingMatchesMarket(listingUrl: string, market: ResolvedMarket): boolean {
  if (!market.stateAbbr) return true;
  const m = listingUrl.match(/redfin\.com\/([A-Z]{2})\//);
  if (!m) return true;
  return m[1] === market.stateAbbr;
}

// ── Oxylabs client ────────────────────────────────────────────────────────────

async function decompressBuffer(buf: Buffer, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const enc = encoding.toLowerCase().trim();
    if (enc === "gzip" || enc === "x-gzip") {
      zlib.gunzip(buf, (err, r) => (err ? reject(err) : resolve(r)));
    } else if (enc === "deflate") {
      zlib.inflate(buf, (err, r) => {
        if (err) zlib.inflateRaw(buf, (e2, r2) => (e2 ? reject(e2) : resolve(r2)));
        else resolve(r);
      });
    } else if (enc === "br") {
      zlib.brotliDecompress(buf, (err, r) => (err ? reject(err) : resolve(r)));
    } else {
      resolve(buf);
    }
  });
}

function oxylabsPost(bodyStr: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const authStr = Buffer.from(
      `${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`
    ).toString("base64");

    const req = https.request(
      {
        hostname: OXYLABS_ENDPOINT,
        path:     OXYLABS_PATH,
        method:   "POST",
        family:   4,
        headers:  {
          "Content-Type":    "application/json",
          "Authorization":   `Basic ${authStr}`,
          "Content-Length":  Buffer.byteLength(bodyStr).toString(),
          "Accept-Encoding": "gzip, deflate, br",
        },
      },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", async () => {
          const buf      = Buffer.concat(chunks);
          const encoding = (res.headers["content-encoding"] ?? "").trim();
          let dec: Buffer;
          try {
            dec = encoding ? await decompressBuffer(buf, encoding) : buf;
          } catch {
            dec = buf;
          }
          resolve({ status: res.statusCode ?? 0, body: dec.toString("utf-8") });
        });
        res.on("error", reject);
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => req.destroy(new Error("Timeout")));
    req.on("error", reject);
    req.write(bodyStr);
    req.end();
  });
}

/**
 * Fetches a URL via Oxylabs.
 *
 * @param targetUrl   URL to fetch
 * @param renderHtml  If true, spins up a browser (render:"html").
 *                    Keep false for all stingray JSON endpoints — they need
 *                    no JavaScript execution and the WAF ignores plain GETs.
 */
async function oxylabsFetch(
  targetUrl: string,
  renderHtml = false
): Promise<string | null> {
  if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
    logger.error("[redfin] OXYLABS_USERNAME / OXYLABS_PASSWORD not set in .env");
    return null;
  }

  const payload: Record<string, any> = {
    source:          "universal",
    url:             targetUrl,
    geo_location:    "United States",
    user_agent_type: "desktop_chrome",
  };

  if (renderHtml) {
    payload.render  = "html";
    payload.context = [{ key: "follow_redirects", value: true }];
  }

  const bodyStr = JSON.stringify(payload);
  logger.debug(`[redfin] Oxylabs → render=${renderHtml} url=${targetUrl}`);

  let resp: { status: number; body: string };
  try {
    resp = await oxylabsPost(bodyStr);
  } catch (err: any) {
    logger.error(`[redfin] Transport error: ${err.message}`);
    return null;
  }

  if (resp.status === 401) {
    logger.error("[redfin] Oxylabs 401 — check credentials");
    throw new Error("OXYLABS_AUTH_FAILED");
  }
  if (resp.status === 429) {
    logger.warn("[redfin] Oxylabs 429 — waiting 10s");
    await sleep(10_000);
    return null;
  }
  if (resp.status !== 200) {
    logger.warn(`[redfin] Oxylabs HTTP ${resp.status}`);
    logger.debug(`[redfin] Body snippet: ${resp.body.slice(0, 300)}`);
    return null;
  }

  let envelope: any;
  try {
    envelope = JSON.parse(resp.body);
  } catch {
    logger.warn("[redfin] Could not parse Oxylabs envelope");
    return null;
  }

  const result0     = envelope?.results?.[0];
  const innerStatus = result0?.status_code ?? result0?.statusCode ?? 200;
  const content: string = result0?.content ?? result0?.html ?? "";

  logger.debug(
    `[redfin] inner=${innerStatus} content=${content.length}ch url=${targetUrl}`
  );

  if (innerStatus === 401) throw new Error("OXYLABS_AUTH_FAILED");
  if (innerStatus === 403 || innerStatus === 405 || innerStatus === 613) {
    logger.warn(`[redfin] Inner ${innerStatus} for ${targetUrl}`);
    return null;
  }
  if (innerStatus === 429) {
    logger.warn("[redfin] Inner 429 — waiting 10s");
    await sleep(10_000);
    return null;
  }
  if (!content) {
    logger.warn(`[redfin] Empty content for ${targetUrl}`);
    return null;
  }

  return content;
}

// ── Block detection (for HTML fallback path only) ─────────────────────────────

const BLOCK_SIGNALS = [
  "awsWafCookieDomainList",
  "CaptchaScript.renderCaptcha",
  "amzn-captcha-verify-button",
  'id="px-captcha"',
  "challenges.cloudflare.com",
];

function isBlockedHtml(html: string): boolean {
  const title = (
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ""
  ).toLowerCase();
  if (
    ["access denied", "human verification", "just a moment"].some(t =>
      title.includes(t)
    )
  ) {
    return true;
  }
  return BLOCK_SIGNALS.some(s => html.includes(s));
}

// ── File helpers ──────────────────────────────────────────────────────────────

function saveFile(filename: string, content: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, "utf-8");
    logger.info(`[redfin] Saved → logs/${filename}`);
  } catch (err) {
    logger.warn(`[redfin] Could not save ${filename}: ${err}`);
  }
}

function slugify(s: string): string {
  return s
    .replace(/https?:\/\/[^/]+/i, "")
    .replace(/[^a-z0-9]+/gi, "_")
    .slice(0, 60);
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class RedfinScraper extends BaseScraper {
  readonly sourceName: string = "redfin";

  private readonly markets:          readonly Market[];
  private readonly uipt:             readonly number[];
  private readonly pageSize:         number;
  private readonly detailFetchLimit: number;

  private allListings: RawListing[] = [];

  constructor(options: ScraperOptions = {}) {
    super(options);

    const rc = config.sources.redfin;
    this.markets           = rc.markets;
    this.uipt              = rc.uipt;
    this.pageSize          = rc.pageSize;
    this.detailFetchLimit  = rc.detailFetchLimit;

    logger.info(
      `[redfin] ${this.markets.length} market(s) | ` +
      `up to ${this.options.maxPages} page(s)/market | ` +
      `pageSize=${this.pageSize} | ` +
      `${this.detailFetchLimit} detail fetch(es)`
    );
    logger.info(`[redfin] Using GIS JSON API — no HTML rendering`);
    logger.info(`[redfin] Phase 2 AVM: avmHistoricalData → belowTheFold → HTML fallback`);

    if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
      logger.error("[redfin] OXYLABS_USERNAME / OXYLABS_PASSWORD missing in .env");
    }
  }

  override async run(): Promise<RawListing[]> {
    this.visited.clear();
    this.results     = [];
    this.allListings = [];
    const rejected: Array<{ listing: RawListing; reason: string }> = [];

    const maxPrice = config.filter.maxPrice;

    const resolvedMarkets: ResolvedMarket[] = this.markets.map(market => ({
      ...market,
      stateAbbr: extractStateAbbr(market.name),
    }));

    for (const market of resolvedMarkets) {
      logger.info(
        `[redfin] Market: ${market.name} ` +
        `(region_id=${market.regionId}, state=${market.stateAbbr})`
      );
    }

    // ── Phase 1: GIS API pages per market ────────────────────────────────

    for (const market of resolvedMarkets) {
      if (this.results.length >= this.options.maxListings) {
        logger.info(`[redfin] maxListings reached — skipping remaining markets`);
        break;
      }

      logger.info(
        `[redfin] Scraping market: ${market.name} ` +
        `(region_id=${market.regionId}, state=${market.stateAbbr})`
      );
      let totalCount = Infinity;

      for (let page = 0; page < this.options.maxPages; page++) {
        if (this.results.length >= this.options.maxListings) break;

        const start = page * this.pageSize;
        if (start >= totalCount) {
          logger.info(`[redfin] ${market.name}: all ${totalCount} results fetched`);
          break;
        }

        const gisUrl = buildGisUrl(
          market,
          [...this.uipt],
          maxPrice,
          start,
          this.pageSize
        );

        logger.info(
          `[redfin] ${market.name} page ${page + 1}/${this.options.maxPages} ` +
          `(start=${start}) → ${gisUrl}`
        );

        let raw: string | null = null;
        try {
          raw = await oxylabsFetch(gisUrl, false);
        } catch (err: any) {
          if (err?.message === "OXYLABS_AUTH_FAILED") {
            logger.error("[redfin] Auth failed — aborting run");
            return this.results;
          }
          logger.error(`[redfin] GIS fetch error: ${err}`);
        }

        if (!raw) {
          logger.warn(`[redfin] No response for ${market.name} page ${page + 1}`);
          break;
        }

        if (page < DEBUG_PAGES) {
          const slug = market.name.replace(/\s+/g, "_").toLowerCase();
          saveFile(`redfin_gis_${slug}_p${page + 1}.json`, raw);
        }

        const { listings, totalCount: tc, allStale } =
          parseRedfinApiResponse(raw, market.name);

        if (isFinite(tc) && tc > 0) totalCount = tc;

        logger.info(
          `[redfin] ${market.name} p${page + 1}: ` +
          `${listings.length} listing(s) ≤ ${MAX_DAYS_OLD}d | ` +
          `totalCount=${tc}` +
          (allStale ? " — all stale" : "")
        );

        this.allListings.push(...listings);

        for (const listing of listings) {
          if (this.results.length >= this.options.maxListings) break;

          if (!listing.url) {
            rejected.push({ listing, reason: "no_url" });
            continue;
          }
          if (this.visited.has(listing.url)) {
            rejected.push({ listing, reason: "duplicate" });
            continue;
          }

          if (!listingMatchesMarket(listing.url, market)) {
            const urlState =
              listing.url.match(/redfin\.com\/([A-Z]{2})\//)?.[1] ?? "??";
            logger.debug(
              `[redfin] ✗ Wrong state — expected ${market.stateAbbr}, got ${urlState}: ${listing.url}`
            );
            rejected.push({ listing, reason: "wrong_location" });
            continue;
          }

          if (!this.passesFilter(listing)) {
            rejected.push({ listing, reason: "filtered" });
            logger.debug(`[redfin] ✗ ${listing.address} @ ${listing.price}`);
            continue;
          }

          this.visited.add(listing.url);
          this.results.push(listing);
          logger.info(
            `[redfin] ✓ [${this.results.length}/${this.options.maxListings}] ` +
            `${listing.address} @ $${listing.price?.toLocaleString()}` +
            (listing.zestimate
              ? ` | AVM $${listing.zestimate.toLocaleString()}`
              : "")
          );
        }

        if (listings.length === 0 || allStale) break;

        if (page + 1 < this.options.maxPages) {
          await sleep(jitter(BETWEEN_PAGE_MS));
        }
      }
    }

    logger.info(
      `[redfin] Phase 1 done — ` +
      `${this.results.length} accepted, ${rejected.length} rejected`
    );

    // ── Phase 2: AVM enrichment via stingray JSON APIs ────────────────────
    //
    // For each accepted listing that has no zestimate, we try three steps:
    //
    //   Step A: avmHistoricalData — plain JSON, no WAF, fast (~800ms delay)
    //   Step B: belowTheFold      — plain JSON, no WAF, slower (bigger payload)
    //   Step C: HTML detail page  — render:true, hits WAF (405 in prod),
    //                               kept as emergency fallback for other proxies
    //
    // Raw API responses are always saved to logs/ regardless of whether an
    // estimate was found.  This lets you inspect the actual payload structure
    // when debugging a new market or a listing that returns no estimate.

    const needsEstimate = (this.results as ListingWithPid[])
      .filter(l => l.zestimate == null)
      .slice(0, this.detailFetchLimit);

    if (needsEstimate.length > 0) {
      logger.info(
        `[redfin] Phase 2 AVM enrichment for ` +
        `${needsEstimate.length} listing(s) without estimate`
      );

      for (let i = 0; i < needsEstimate.length; i++) {
        const listing = needsEstimate[i];

        if (!listing.address) continue;

        const propertyId  = listing._redfinPropertyId;
        const label       = `[${i + 1}/${needsEstimate.length}]`;

        logger.info(`[redfin] ${label} AVM lookup: ${listing.address} (pid=${propertyId ?? "none"})`);

        let estimateFound = false;

        // ── Step A: avmHistoricalData ──────────────────────────────────

        if (propertyId != null) {
          const avmUrl = buildAvmUrl(propertyId);
          logger.debug(`[redfin] ${label} Step A → ${avmUrl}`);

          try {
            const raw = await oxylabsFetch(avmUrl, false);  // render:false — no WAF

            if (raw) {
              // Always save the raw response so we can inspect structure
              saveFile(`redfin_avm_${propertyId}.json`, raw);

              const { redfinEstimate, rawPayload } =
                parseAvmHistoricalData(raw, listing.address!);

              // Save parsed payload as pretty JSON for readability
              if (rawPayload != null) {
                saveFile(
                  `redfin_avm_${propertyId}_parsed.json`,
                  JSON.stringify(rawPayload, null, 2)
                );
              }

              if (redfinEstimate) {
                listing.zestimate = redfinEstimate;
                estimateFound     = true;
                logger.info(
                  `[redfin] ${label} ✓ AVM $${redfinEstimate.toLocaleString()} ` +
                  `via avmHistoricalData for ${listing.address}`
                );
              } else {
                logger.debug(
                  `[redfin] ${label} avmHistoricalData: no estimate — ` +
                  `payload keys: ${Object.keys(rawPayload ?? {}).join(", ")}`
                );
              }
            } else {
              logger.warn(`[redfin] ${label} No response from avmHistoricalData`);
            }
          } catch (err: any) {
            if (err?.message === "OXYLABS_AUTH_FAILED") {
              logger.error("[redfin] Auth failed during AVM enrichment");
              break;
            }
            logger.warn(`[redfin] ${label} Step A error: ${err}`);
          }

          if (!estimateFound) {
            await sleep(jitter(BETWEEN_AVM_MS));
          }
        } else {
          logger.debug(`[redfin] ${label} No propertyId — skipping Step A`);
        }

        // ── Step B: belowTheFold (fallback) ───────────────────────────

        if (!estimateFound && propertyId != null) {
          const btfUrl = buildBelowTheFoldUrl(propertyId);
          logger.debug(`[redfin] ${label} Step B → ${btfUrl}`);

          try {
            const raw = await oxylabsFetch(btfUrl, false);  // render:false — no WAF

            if (raw) {
              // Always save raw belowTheFold response
              saveFile(`redfin_btf_${propertyId}.json`, raw);

              const { redfinEstimate, rawPayload } =
                parseBelowTheFold(raw, listing.address!);

              if (rawPayload != null) {
                saveFile(
                  `redfin_btf_${propertyId}_parsed.json`,
                  JSON.stringify(rawPayload, null, 2)
                );
              }

              if (redfinEstimate) {
                listing.zestimate = redfinEstimate;
                estimateFound     = true;
                logger.info(
                  `[redfin] ${label} ✓ AVM $${redfinEstimate.toLocaleString()} ` +
                  `via belowTheFold for ${listing.address}`
                );
              } else {
                logger.debug(
                  `[redfin] ${label} belowTheFold: no estimate — ` +
                  `payload keys: ${Object.keys(rawPayload ?? {}).join(", ")}`
                );
              }
            } else {
              logger.warn(`[redfin] ${label} No response from belowTheFold`);
            }
          } catch (err: any) {
            if (err?.message === "OXYLABS_AUTH_FAILED") {
              logger.error("[redfin] Auth failed during belowTheFold enrichment");
              break;
            }
            logger.warn(`[redfin] ${label} Step B error: ${err}`);
          }

          if (!estimateFound) {
            await sleep(jitter(BETWEEN_AVM_MS));
          }
        }

        // ── Step C: HTML detail page (emergency fallback) ─────────────
        //
        // Returns 405 through Oxylabs in production because Redfin's WAF
        // blocks browser-rendered requests on detail pages.
        //
        // This path is retained for:
        //   - Local testing with direct HTTP (no proxy)
        //   - Alternative proxy providers that support the "redfin" source type
        //   - Future compatibility if WAF rules change
        //
        // In production, expect this to log "Inner 405" and skip silently.

        if (!estimateFound && listing.url) {
          logger.debug(
            `[redfin] ${label} Step C (HTML fallback) → ${listing.url}`
          );

          try {
            const html = await oxylabsFetch(listing.url, true);  // render:true

            if (!html) {
              logger.debug(`[redfin] ${label} No HTML from detail page (expected 405)`);
            } else {
              if (i < DEBUG_PAGES) {
                saveFile(`redfin_detail_${slugify(listing.url)}.html`, html);
              }

              if (isBlockedHtml(html)) {
                logger.debug(
                  `[redfin] ${label} HTML detail page blocked for ${listing.address}`
                );
              } else {
                const { redfinEstimate, monthlyPayment } =
                  parseRedfinDetailPage(html, listing.address!);

                if (redfinEstimate) {
                  listing.zestimate = redfinEstimate;
                  estimateFound     = true;
                  logger.info(
                    `[redfin] ${label} ✓ AVM $${redfinEstimate.toLocaleString()} ` +
                    `via HTML detail page for ${listing.address}`
                  );
                }
                if (monthlyPayment) {
                  (listing as any).monthlyPayment = monthlyPayment;
                }
              }
            }
          } catch (err: any) {
            if (err?.message === "OXYLABS_AUTH_FAILED") {
              logger.error("[redfin] Auth failed during HTML detail fetch");
              break;
            }
            logger.debug(`[redfin] ${label} Step C error (expected): ${err}`);
          }

          await sleep(jitter(BETWEEN_DETAIL_MS));
        } else if (!estimateFound) {
          // No propertyId and no URL — nothing more to try
          logger.debug(`[redfin] ${label} No estimate source available for ${listing.address}`);
          await sleep(jitter(BETWEEN_AVM_MS));
        }

        if (!estimateFound) {
          logger.debug(`[redfin] ${label} No AVM estimate found for ${listing.address}`);
        }
      }

      const withEst = this.results.filter(l => l.zestimate != null).length;
      logger.info(
        `[redfin] Phase 2 done — AVM coverage: ${withEst}/${this.results.length}`
      );
    }

    // ── JSON dump ─────────────────────────────────────────────────────────

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

    // ── Filter: Only return listings with zestimate (AVM estimate) ────────────

    const withEstimate = this.results.filter(l => l.zestimate != null);
    const withoutEstimate = this.results.filter(l => l.zestimate == null);

    logger.info(
      `[redfin] Final filter: ${withEstimate.length} with estimates, ` +
      `${withoutEstimate.length} without estimates — returning only with estimates`
    );

    if (withoutEstimate.length > 0) {
      logger.debug(
        `[redfin] Dropped ${withoutEstimate.length} listing(s) without estimates:\n` +
        withoutEstimate
          .map(l => `  • ${l.address} ($${l.price?.toLocaleString()})`)
          .join("\n")
      );
    }

    logger.info(`[redfin] Finished — ${withEstimate.length} listings with estimates`);
    return withEstimate;
  }

  protected async scrapePage(_h: any, _p: number): Promise<RawListing[]> {
    return [];
  }
  protected hasMorePages(_p: number, _r: RawListing[]): boolean {
    return false;
  }
}