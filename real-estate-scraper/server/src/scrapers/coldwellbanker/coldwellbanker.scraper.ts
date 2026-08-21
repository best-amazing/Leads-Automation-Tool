// src/scrapers/coldwellbanker/coldwellbanker.scraper.ts
// ─────────────────────────────────────────────────────────────────────────────
// Coldwell Banker scraper — sitemap-driven inventory discovery + detail fetch.
//
// Why this design (validated 2026-08-21):
//   • CB search pages are dead ends: CloudFront WAF blocks Oxylabs and the SSR
//     route itself returns 500 ("problem with our servers") even for real
//     browsers on US residential IPs.
//   • robots.txt exposes open listing sitemaps:
//       sitemapindex-listings-new-day.xml   (~27 chunks × ~1000 fresh/day)
//       sitemapindex-listings-new-week.xml  (~120 chunks × ~1000/week)
//       sitemapindex-listings.xml           (full active inventory, state-keyed
//                                            chunks e.g. sitemap-listings-oh-NNN)
//   • Listing detail pages are openly fetchable. The Next.js data route
//     (_next/data/{buildId}/...json) returns the same pageProps JSON as the
//     page's __NEXT_DATA__ at ~1/4 the bandwidth.
//   • Fallback chain per detail: _next/data JSON → buildId refresh → direct
//     HTML → Oxylabs render:html (last resort, costs credits).
//
// Only ACTIVE listings are returned (standardStatus === "ACTIVE") — sitemaps
// carry current inventory only, and any non-active status is dropped here.
// ─────────────────────────────────────────────────────────────────────────────

import * as https from "https";
import { RawListing } from "../../types/listing";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { logger } from "../../utils/logger";
import { sleep, jitter } from "../../utils/browser";

const CB_BASE = "https://www.coldwellbanker.com";

const SITEMAP_INDEX: Record<CbInventoryMode, string> = {
  "new-day": `${CB_BASE}/xml-sitemap/states/sitemapindex-listings-new-day.xml`,
  "new-week": `${CB_BASE}/xml-sitemap/states/sitemapindex-listings-new-week.xml`,
  full: `${CB_BASE}/xml-sitemap/states/sitemapindex-listings.xml`,
};

export type CbInventoryMode = "new-day" | "new-week" | "full";

export const DEFAULT_CB_DELAY_MS = Number(process.env.CB_DELAY_MS ?? 1_000);
export const CB_CONCURRENCY = Math.max(1, Number(process.env.CB_CONCURRENCY ?? 3));
const FETCH_TIMEOUT_MS = Number(process.env.CB_FETCH_TIMEOUT_MS ?? 60_000);

// ── Low-level HTTP GET (no proxy — CB serves sitemaps/details openly) ───────

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = https.request(
      url,
      {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") })
        );
      }
    );
    req.on("timeout", () => {
      req.destroy(new Error(`timeout after ${FETCH_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    req.end();
  });
}

async function httpGetWithRetry(url: string, label: string, attempts = 2): Promise<string> {
  let lastErr = "";
  for (let i = 0; i < attempts; i++) {
    try {
      const { status, body } = await httpGet(url);
      if (status === 200) return body;
      lastErr = `HTTP ${status}`;
      // 403/429 → back off before retrying
      if (status === 403 || status === 429) {
        const waitMs = 5_000 * (i + 1);
        logger.warn(`[coldwellbanker] ${label}: ${lastErr} — backing off ${waitMs / 1000}s`);
        await sleep(waitMs);
      }
    } catch (err) {
      lastErr = err instanceof Error ? err.message : String(err);
    }
  }
  throw new Error(`${label} failed: ${lastErr}`);
}

// ── buildId resolution (rotates on CB deploys) ───────────────────────────────

let cachedBuildId: string | null = null;
let buildIdResolvedAt = 0;
const BUILD_ID_TTL_MS = 30 * 60_000;

export async function resolveBuildId(force = false): Promise<string> {
  if (!force && cachedBuildId && Date.now() - buildIdResolvedAt < BUILD_ID_TTL_MS) {
    return cachedBuildId;
  }
  const html = await httpGetWithRetry(CB_BASE, "buildId discovery");
  const m =
    html.match(/"buildId":"([^"]+)"/) ??
    html.match(/<script id="__NEXT_DATA__"[^>]*>\s*{"[^"]*"buildId":"([^"]+)"/);
  if (!m) throw new Error("Could not extract Next.js buildId from homepage");
  cachedBuildId = m[1];
  buildIdResolvedAt = Date.now();
  logger.info(`[coldwellbanker] Resolved buildId: ${cachedBuildId}`);
  return cachedBuildId;
}

// ── Sitemap discovery ────────────────────────────────────────────────────────

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
}

/**
 * Discover Coldwell Banker listing URLs for Ohio.
 *
 *  - "new-day"/"new-week": child sitemaps are brand-keyed, so every chunk is
 *    fetched and URLs filtered on "/oh/".
 *  - "full": child sitemaps are state-keyed (sitemap-listings-oh-NNN.xml), so
 *    only Ohio chunks are fetched — cheapest way to sweep all ~47K actives.
 */
export async function discoverOhioListingUrls(mode: CbInventoryMode): Promise<string[]> {
  const indexXml = await httpGetWithRetry(SITEMAP_INDEX[mode], `sitemap index (${mode})`);
  let childSitemaps = extractLocs(indexXml);
  logger.info(
    `[coldwellbanker] ${mode} index: ${childSitemaps.length} child sitemap(s)`
  );

  if (mode === "full") {
    childSitemaps = childSitemaps.filter((u) => /sitemap-listings-oh-\d+\.xml$/.test(u));
    logger.info(`[coldwellbanker] full mode: ${childSitemaps.length} Ohio chunk(s)`);
  }

  const urls = new Set<string>();
  let fetched = 0;
  for (const sm of childSitemaps) {
    try {
      const xml = await httpGetWithRetry(sm, `chunk ${sm.split("/").pop()}`);
      fetched++;
      for (const u of extractLocs(xml)) {
        if (/^https:\/\/www\.coldwellbanker\.com\/oh\/.+\/lid-/.test(u)) urls.add(u);
      }
    } catch (err) {
      logger.warn(`[coldwellbanker] Skipping unreadable sitemap ${sm}: ${err}`);
    }
    // Small politeness pause between chunk fetches
    await sleep(jitter(150));
  }

  logger.info(
    `[coldwellbanker] Discovery complete (${mode}): ${fetched}/${childSitemaps.length} chunks, ` +
      `${urls.size} unique OH listing URL(s)`
  );
  return [...urls];
}

// ── Detail parsing ───────────────────────────────────────────────────────────

interface CbPageProps {
  propertyDetails?: any;
  rawPropertyDetails?: any;
}

function parseNum(val: unknown): number | undefined {
  if (typeof val === "number" && Number.isFinite(val)) return val;
  if (typeof val === "string") {
    const n = Number(val.replace(/[$,\s]/g, ""));
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function parseDaysOnMarket(added: unknown, insertedDate: unknown): number | undefined {
  if (typeof added === "string") {
    const m = added.match(/(\d+)\s*day/i);
    if (m) return Number(m[1]);
  }
  if (typeof insertedDate === "string") {
    const t = Date.parse(insertedDate);
    if (Number.isFinite(t)) {
      return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
    }
  }
  return undefined;
}

/** Extract the stable listing id (lid-...) from a CB listing URL. */
export function extractLid(url: string): string {
  const m = url.match(/lid-([A-Za-z0-9]+)/);
  return m ? m[1] : url;
}

/**
 * Map CB pageProps → RawListing (+ zip). Returns null for non-ACTIVE
 * listings or pages missing the expected payload.
 */
export function parseCbProperty(pageProps: CbPageProps, url: string): (RawListing & { zip?: string }) | null {
  const pd = pageProps?.propertyDetails;
  const rawPd = pageProps?.rawPropertyDetails;
  if (!pd || !rawPd) return null;

  const summary = pd.summary ?? {};
  const status = String(summary.standardStatus ?? "").toUpperCase();

  // Active listings only (skip Pending, Contingent, Sold, etc.)
  if (status && status !== "ACTIVE") {
    logger.debug(`[coldwellbanker] Skipping non-ACTIVE (${status}): ${url}`);
    return null;
  }

  const addr = pd.address ?? {};
  const about = pd.about ?? {};
  const structure = rawPd?.property?.structure ?? {};
  const characteristics = rawPd?.property?.characteristics ?? {};

  const description: string =
    about.description ||
    rawPd?.property?.listing?.remarks?.publicRemarks ||
    (Array.isArray(rawPd?.propertyDescription)
      ? rawPd.propertyDescription.map((r: any) => r.remark ?? "").join("\n")
      : "") ||
    "";

  const price = parseNum(pd.price?.listPrice) ?? parseNum(about.priceSummary?.listPrice);

  const bedrooms = parseNum(structure.bedroomsTotal);
  const bathrooms =
    parseNum(structure.bathroomsTotalDecimal) ?? parseNum(structure.bathroomsTotalInteger);
  const squareFeet = parseNum(structure.livingArea) ?? parseNum(structure.buildingAreaTotal);
  const yearBuilt = parseNum(structure.yearBuilt) ?? parseNum(about.homeFacts?.yearBuilt);

  // Lot size: prefer sqft; fall back to acres → sqft
  let lotSqft = parseNum(characteristics.lotSizeSquareFeet);
  if (lotSqft == null) {
    const acres = parseNum(characteristics.lotSizeAcres) ?? parseNum(pd.lot?.lotSizeAcres);
    if (acres != null) lotSqft = Math.round(acres * 43_560);
  }
  if (lotSqft == null) lotSqft = parseNum(pd.lot?.lotSizeSquareFeet);

  const city = addr.city ?? "";
  const state = addr.stateOrProvince ?? "";
  const zip = addr.postalCode ?? "";
  const street = addr.unparsedAddress ?? summary.addressLine1 ?? "";
  const address = [street, city, state, zip].filter(Boolean).join(", ");

  const geo = rawPd?.property?.location ?? {};
  const latitude = parseNum(geo.latitude);
  const longitude = parseNum(geo.longitude);

  return {
    url,
    source: "coldwellbanker",
    title: address || url,
    address,
    city,
    state,
    zip,
    price,
    description,
    bedrooms: bedrooms && bedrooms > 0 ? bedrooms : undefined,
    bathrooms: bathrooms && bathrooms > 0 ? bathrooms : undefined,
    squareFeet,
    lotSqft,
    yearBuilt,
    daysOnMarket: parseDaysOnMarket(about.added, rawPd?.insertedDate),
    status: status || undefined,
    latitude,
    longitude,
  };
}

function extractNextDataJson(html: string): CbPageProps | null {
  const idx = html.indexOf("__NEXT_DATA__");
  if (idx === -1) return null;
  const start = html.indexOf(">", idx) + 1;
  const end = html.indexOf("</script>", start);
  if (start === 0 || end === -1) return null;
  try {
    const json = JSON.parse(html.slice(start, end));
    return json?.props?.pageProps ?? null;
  } catch {
    return null;
  }
}

// ── Scraper ──────────────────────────────────────────────────────────────────

export class ColdwellBankerScraper extends BaseScraper {
  readonly sourceName: string = "coldwellbanker";

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  /**
   * Fetch one listing's structured data.
   * Chain: _next/data JSON → buildId refresh retry → direct HTML → Oxylabs.
   */
  async fetchListingDetail(url: string): Promise<RawListing | null> {
    // 1. Fast path: Next.js data route (pure JSON, no rendering)
    try {
      const buildId = await resolveBuildId();
      const jsonUrl = `${CB_BASE}/_next/data/${buildId}${new URL(url).pathname}.json`;
      const body = await httpGetWithRetry(jsonUrl, `detail json ${extractLid(url)}`);
      if (body.startsWith("{")) {
        const pageProps = JSON.parse(body)?.pageProps;
        const parsed = parseCbProperty(pageProps, url);
        if (parsed) return parsed;
        // Non-ACTIVE or empty payload — not a transport failure, don't fall through
        return null;
      }
      logger.debug(`[coldwellbanker] JSON route returned non-JSON for ${url} — refreshing buildId`);
      await resolveBuildId(true);
    } catch (err) {
      logger.debug(`[coldwellbanker] JSON route failed for ${url}: ${err}`);
      await resolveBuildId(true).catch(() => {});
    }

    // 2. Direct HTML
    try {
      const html = await httpGetWithRetry(url, `detail html ${extractLid(url)}`);
      const pageProps = extractNextDataJson(html);
      const parsed = parseCbProperty(pageProps ?? {}, url);
      if (parsed) return parsed;
      return null;
    } catch (err) {
      logger.debug(`[coldwellbanker] Direct HTML failed for ${url}: ${err}`);
    }

    // 3. Last resort: Oxylabs (costs credits — keep rare)
    try {
      const { oxylabsFetch } = await import("../zillow/zillow.scraper");
      const html = await oxylabsFetch(url);
      if (html) {
        const pageProps = extractNextDataJson(html);
        return parseCbProperty(pageProps ?? {}, url);
      }
    } catch (err) {
      logger.warn(`[coldwellbanker] Oxylabs fallback failed for ${url}: ${err}`);
    }

    return null;
  }

  // BaseScraper abstract members — unused: this source is sitemap-driven,
  // not page-walking like the browser scrapers.
  protected async scrapePage(_handle: unknown, _pageNumber: number): Promise<RawListing[]> {
    return [];
  }

  /**
   * Generic run(): discover current OH inventory and fetch details.
   * The ADU wrapper overrides run() with dedup/filters/onMatch.
   */
  override async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting sitemap-based scrape`);
    this.visited.clear();
    this.results = [];

    const mode = (process.env.CB_INVENTORY_MODE as CbInventoryMode) || "new-week";
    const urls = await discoverOhioListingUrls(mode);

    for (const url of urls) {
      if (this.results.length >= this.options.maxListings) break;
      const listing = await this.fetchListingDetail(url);
      if (listing) {
        this.visited.add(extractLid(url));
        this.results.push(listing);
      }
      await sleep(jitter(DEFAULT_CB_DELAY_MS));
    }

    logger.info(`[${this.sourceName}] Finished — ${this.results.length} ACTIVE listing(s)`);
    return this.results;
  }
}
