// src/scrapers/realtor/realtor.scraper.ts
//
// ── Transport ─────────────────────────────────────────────────────────────────
//
// Calls Realtor.com's internal GraphQL API directly — no browser rendering,
// no Oxylabs. The same endpoint the Realtor.com frontend uses.
//
//   POST https://www.realtor.com/api/v1/hulk
//   Content-Type: application/json
//   User-Agent: <desktop Chrome UA>
//
// The API accepts a GraphQL query and returns JSON. No auth token required —
// the endpoint is public and unauthenticated on the same session cookies the
// browser would have (none needed for search).
//
// ── Pagination ────────────────────────────────────────────────────────────────
//
// The API uses offset pagination via `offset` (0-based) and `limit` fields
// inside the GraphQL variables. Each page returns up to RESULTS_PER_PAGE
// listings. We increment offset by RESULTS_PER_PAGE until we hit maxPages,
// run out of results, or exceed maxListings.
//
// ── Estimate fetching ─────────────────────────────────────────────────────────
//
// A second GraphQL query fetches property details (including the Realtor
// Estimate / AVM) for each accepted listing. Controlled by REALTOR_FETCH_ESTIMATES.
//
// ── Required .env ─────────────────────────────────────────────────────────────
//   (none — no credentials required)
//
// ── Optional .env ─────────────────────────────────────────────────────────────
//   REALTOR_SEARCH_URLS       — comma-separated search URLs (city + filters)
//   REALTOR_MAX_PAGES         — per-URL page cap (default 10)
//   REALTOR_MAX_LISTINGS      — hard cap per run (default 200)
//   REALTOR_FETCH_ESTIMATES   — set "false" to skip detail fetches
//   REALTOR_FETCH_TIMEOUT     — ms timeout per request (default 30000)
//   PROXY_URL                 — optional residential proxy (http://user:pass@host:port)
//                               Set if Realtor.com returns 403 from datacenter IPs.
//

import * as https from "https";
import * as http  from "http";
import * as tls   from "tls";
import * as zlib  from "zlib";
import * as fs    from "fs";
import * as path  from "path";

import { BaseScraper, ScraperOptions }  from "../base.scraper";
import { BrowserHandle, sleep, jitter } from "../../utils/browser";
import { RawListing }                   from "../../types/listing";
import { logger }                       from "../../utils/logger";
import {
  parseRealtorGraphQL,
  parseRealtorDetailGraphQL,
  MAX_DAYS_OLD,
} from "./realtor.parser";
import { config } from "../../config";

// ── Config ────────────────────────────────────────────────────────────────────

const FETCH_ESTIMATES    = process.env.REALTOR_FETCH_ESTIMATES !== "false";
const REQUEST_TIMEOUT_MS = Number(process.env.REALTOR_FETCH_TIMEOUT) || 30_000;
const PROXY_URL          = process.env.PROXY_URL ?? "";
const BETWEEN_PAGE_MS    = 1_500;
const DETAIL_CONCURRENCY = 4;
const DEBUG_PAGES        = 3;
const RESULTS_PER_PAGE   = 42;

const REALTOR_HOST = "www.realtor.com";
const HULK_PATH    = "/api/v1/hulk";

// ── Browser-like headers sent with every request ──────────────────────────────

const BASE_HEADERS: Record<string, string> = {
  "accept":           "application/json",
  "accept-language":  "en-US,en;q=0.9",
  "accept-encoding":  "gzip, deflate, br",
  "content-type":     "application/json",
  "origin":           "https://www.realtor.com",
  "referer":          "https://www.realtor.com/",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/124.0.0.0 Safari/537.36",
  "sec-ch-ua":
    '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  "sec-ch-ua-mobile":   "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest":  "empty",
  "sec-fetch-mode":  "cors",
  "sec-fetch-site":  "same-origin",
};

// ── Default search URLs ───────────────────────────────────────────────────────

const DEFAULT_SEARCH_URLS: string[] = [
  "https://www.realtor.com/realestateandhomes-search/Columbus_OH/?price_max=300000&type=single_family,multi_family",
  "https://www.realtor.com/realestateandhomes-search/Cleveland_OH/?price_max=300000&type=single_family,multi_family",
  "https://www.realtor.com/realestateandhomes-search/Toledo_OH/?price_max=300000&type=single_family,multi_family",
  "https://www.realtor.com/realestateandhomes-search/Milwaukee_WI/?price_max=300000&type=single_family,multi_family",
];

function getSearchUrls(): string[] {
  const env     = process.env.REALTOR_SEARCH_URLS ?? "";
  const fromEnv = env.split(",").map((u) => u.trim()).filter(Boolean);
  return fromEnv.length > 0 ? fromEnv : DEFAULT_SEARCH_URLS;
}

// ── URL → search params ───────────────────────────────────────────────────────
//
// Parses a standard realtor.com search URL into the variables we need for
// the GraphQL query. Handles both path-encoded and query-string filters.

interface SearchParams {
  city:          string;
  stateCode:     string;
  priceMax?:     number;
  priceMin?:     number;
  propertyTypes: string[];   // e.g. ["single_family", "multi_family"]
}

function parseSearchUrl(url: string): SearchParams {
  let u: URL;
  try { u = new URL(url); }
  catch { return { city: "Columbus", stateCode: "OH", propertyTypes: ["single_family"] }; }

  // Path: /realestateandhomes-search/Columbus_OH/...
  const pathMatch = u.pathname.match(/\/realestateandhomes-search\/([^/]+)/);
  const slug      = pathMatch?.[1] ?? "";
  const slugMatch = slug.match(/^(.+?)_([A-Z]{2})$/);
  const city      = slugMatch ? slugMatch[1].replace(/-/g, " ") : "Columbus";
  const stateCode = slugMatch ? slugMatch[2] : "OH";

  const priceMax = u.searchParams.get("price_max");
  const priceMin = u.searchParams.get("price_min");

  const typeParam  = u.searchParams.get("type") ?? "";
  const propTypes  = typeParam
    ? typeParam.split(",").map((t) => t.trim()).filter(Boolean)
    : ["single_family", "multi_family"];

  return {
    city,
    stateCode,
    priceMax:      priceMax ? parseInt(priceMax, 10) : undefined,
    priceMin:      priceMin ? parseInt(priceMin, 10) : undefined,
    propertyTypes: propTypes,
  };
}

// ── GraphQL query bodies ──────────────────────────────────────────────────────
//
// These mirror exactly what the Realtor.com frontend sends.
// Captured via DevTools → Network → Filter: hulk

function buildSearchQuery(params: SearchParams, offset: number): string {
  const propTypeFilter = params.propertyTypes
    .map((t) => `"${t}"`)
    .join(", ");

  const priceFilters = [
    params.priceMin != null ? `list_price: { min: ${params.priceMin} }` : "",
    params.priceMax != null ? `list_price: { max: ${params.priceMax} }` : "",
  ]
    .filter(Boolean)
    .join(", ");

  // We also apply the global maxPrice from config as a safety cap
  const effectivePriceMax = params.priceMax ?? config.filter.maxPrice;

  return JSON.stringify({
    query: `
      query ConsumerSearchQuery(
        $query: HomeSearchCriteria!
        $limit: Int
        $offset: Int
        $sort: [SortClause]
      ) {
        home_search: home_search(
          query: $query
          sort: $sort
          limit: $limit
          offset: $offset
        ) {
          count
          total
          results {
            property_id
            list_price
            list_date
            status
            permalink
            price_reduced_amount
            flags {
              is_price_reduced
              is_new_listing
            }
            location {
              address {
                line
                city
                state_code
                postal_code
                coordinate {
                  lat
                  lon
                }
              }
            }
            description {
              beds
              baths_consolidated
              baths_full
              baths_half
              sqft
              lot_sqft
              year_built
              type
              text
            }
            primary_photo {
              href
            }
            photos {
              href
            }
            agents {
              full_name
              phones { number type }
            }
            branding {
              name
              type
            }
            estimates {
              estimate
              estimate_high
              estimate_low
              provider_url
            }
          }
        }
      }
    `,
    variables: {
      query: {
        primary_search: {
          location: {
            city_state: `${params.city}, ${params.stateCode}`,
          },
        },
        list_price:     { max: effectivePriceMax },
        prop_type:      params.propertyTypes,
        status:         ["for_sale"],
      },
      limit:  RESULTS_PER_PAGE,
      offset,
      sort:   [{ field: "list_date", direction: "desc" }],
    },
  });
}

function buildDetailQuery(propertyId: string): string {
  return JSON.stringify({
    query: `
      query PropertyDetails($property_id: ID!) {
        property(id: $property_id) {
          property_id
          estimates {
            estimate
            estimate_high
            estimate_low
            provider_url
          }
        }
      }
    `,
    variables: { property_id: propertyId },
  });
}

// ── Decompression ─────────────────────────────────────────────────────────────

async function decompress(buf: Buffer, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const enc = encoding.toLowerCase().trim();
    if (enc === "gzip" || enc === "x-gzip") {
      zlib.gunzip(buf, (e, r) => (e ? reject(e) : resolve(r)));
    } else if (enc === "deflate") {
      zlib.inflate(buf, (e, r) => {
        if (e) zlib.inflateRaw(buf, (e2, r2) => (e2 ? reject(e2) : resolve(r2)));
        else resolve(r);
      });
    } else if (enc === "br") {
      zlib.brotliDecompress(buf, (e, r) => (e ? reject(e) : resolve(r)));
    } else {
      resolve(buf);
    }
  });
}

// ── HTTPS POST via proxy CONNECT tunnel ───────────────────────────────────────

async function httpsPostViaProxy(
  hostname:  string,
  reqPath:   string,
  headers:   Record<string, string>,
  body:      string,
  timeoutMs: number
): Promise<{ status: number; body: string } | null> {
  let proxyHost: string;
  let proxyPort: number;
  let proxyAuth: string | null = null;

  try {
    const u   = new URL(PROXY_URL);
    proxyHost = u.hostname;
    proxyPort = parseInt(u.port || "8080", 10);
    if (u.username && u.password) {
      proxyAuth = Buffer.from(
        `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`
      ).toString("base64");
    }
  } catch {
    logger.error(`[realtor] Invalid PROXY_URL: ${PROXY_URL}`);
    return null;
  }

  return new Promise((resolve) => {
    const connectHeaders: Record<string, string> = {
      "Host":       `${hostname}:443`,
      "User-Agent": "Mozilla/5.0",
    };
    if (proxyAuth) connectHeaders["Proxy-Authorization"] = `Basic ${proxyAuth}`;

    const connectReq = http.request({
      host:    proxyHost,
      port:    proxyPort,
      method:  "CONNECT",
      path:    `${hostname}:443`,
      headers: connectHeaders,
    });

    const timer = setTimeout(() => {
      connectReq.destroy();
      logger.warn("[realtor] Proxy CONNECT timeout");
      resolve(null);
    }, timeoutMs);

    connectReq.on("error", (err: any) => {
      clearTimeout(timer);
      logger.error(`[realtor] Proxy CONNECT error: ${err.message}`);
      resolve(null);
    });

    connectReq.on("connect", (res: any, socket: any) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        logger.error(`[realtor] Proxy CONNECT rejected: HTTP ${res.statusCode}`);
        socket.destroy();
        resolve(null);
        return;
      }

      const tlsSocket = tls.connect({
        host:               hostname,
        socket,
        servername:         hostname,
        rejectUnauthorized: true,
      });

      tlsSocket.on("error", (err: any) => {
        clearTimeout(timer);
        resolve(null);
      });

      tlsSocket.on("secureConnect", () => {
        const bodyBuf  = Buffer.from(body, "utf-8");
        const allHdrs  = { ...headers, "Content-Length": bodyBuf.length.toString() };
        const reqLines =
          `POST ${reqPath} HTTP/1.1\r\n` +
          `Host: ${hostname}\r\n` +
          Object.entries(allHdrs).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
          "\r\n\r\n";

        tlsSocket.write(reqLines);
        tlsSocket.write(bodyBuf);

        const chunks: Buffer[] = [];
        tlsSocket.on("data",  (c: Buffer) => chunks.push(c));
        tlsSocket.on("end",   () => {
          clearTimeout(timer);
          try {
            const raw        = Buffer.concat(chunks).toString("binary");
            const headerEnd  = raw.indexOf("\r\n\r\n");
            if (headerEnd === -1) { resolve(null); return; }

            const headerSection = raw.slice(0, headerEnd);
            const statusMatch   = headerSection.match(/^HTTP\/\d\.?\d? (\d+)/);
            const status        = statusMatch ? parseInt(statusMatch[1], 10) : 0;
            let   rawBodyStr    = raw.slice(headerEnd + 4);

            const isChunked = /transfer-encoding:\s*chunked/i.test(headerSection);
            if (isChunked) {
              let result = "";
              let rem    = rawBodyStr;
              while (rem.length > 0) {
                const crlf = rem.indexOf("\r\n");
                if (crlf === -1) break;
                const sz = parseInt(rem.slice(0, crlf), 16);
                if (isNaN(sz) || sz === 0) break;
                result += rem.slice(crlf + 2, crlf + 2 + sz);
                rem     = rem.slice(crlf + 2 + sz + 2);
              }
              rawBodyStr = result;
            }

            const encMatch = headerSection.match(/content-encoding:\s*(\S+)/i);
            const enc      = encMatch?.[1]?.trim() ?? "";
            if (enc === "gzip" || enc === "br" || enc === "deflate") {
              decompress(Buffer.from(rawBodyStr, "binary"), enc)
                .then((buf) => resolve({ status, body: buf.toString("utf-8") }))
                .catch(() => resolve({ status, body: rawBodyStr }));
            } else {
              resolve({ status, body: rawBodyStr });
            }
          } catch (err: any) {
            logger.warn(`[realtor] Response parse error: ${err.message}`);
            resolve(null);
          }
        });
        tlsSocket.on("error", () => { clearTimeout(timer); resolve(null); });
      });

      connectReq.end();
    });

    connectReq.end();
  });
}

// ── Direct HTTPS POST ─────────────────────────────────────────────────────────

async function httpsPostDirect(
  hostname:  string,
  reqPath:   string,
  headers:   Record<string, string>,
  body:      string,
  timeoutMs: number
): Promise<{ status: number; body: string } | null> {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname, path: reqPath, method: "POST", family: 4, headers },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        const enc = (res.headers["content-encoding"] ?? "").trim();
        const stream: NodeJS.ReadableStream =
          enc === "gzip"    ? res.pipe(zlib.createGunzip())           :
          enc === "deflate" ? res.pipe(zlib.createInflate())          :
          enc === "br"      ? res.pipe(zlib.createBrotliDecompress()) :
          res as any;

        stream.on("data",  (c: Buffer) => chunks.push(c));
        stream.on("end",   () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") })
        );
        stream.on("error", (err: any) => {
          logger.warn(`[realtor] stream error: ${err.message}`);
          resolve(null);
        });
      }
    );
    req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    req.on("error", (err: any) => {
      logger.error(`[realtor] request error [${err.code ?? "?"}]: ${err.message}`);
      resolve(null);
    });
    req.write(body);
    req.end();
  });
}

// ── Unified POST ──────────────────────────────────────────────────────────────

async function httpsPost(
  hostname:  string,
  reqPath:   string,
  headers:   Record<string, string>,
  body:      string,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<{ status: number; body: string } | null> {
  if (PROXY_URL) {
    return httpsPostViaProxy(hostname, reqPath, headers, body, timeoutMs);
  }
  return httpsPostDirect(hostname, reqPath, headers, body, timeoutMs);
}

// ── GraphQL API call ──────────────────────────────────────────────────────────

async function graphqlPost(body: string): Promise<any | null> {
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    "Content-Length": Buffer.byteLength(body).toString(),
  };

  const result = await httpsPost(REALTOR_HOST, HULK_PATH, headers, body);

  if (!result) return null;

  const { status, body: rawBody } = result;

  if (status === 403) {
    logger.warn(
      "[realtor] API 403 — bot check. " +
      "Set PROXY_URL to a residential proxy to bypass."
    );
    return null;
  }
  if (status === 429) {
    logger.warn("[realtor] API 429 — rate limited");
    return null;
  }
  if (status !== 200) {
    logger.warn(`[realtor] API HTTP ${status}: ${rawBody.slice(0, 200)}`);
    return null;
  }

  try   { return JSON.parse(rawBody); }
  catch {
    logger.warn(`[realtor] Could not parse API JSON. Body: ${rawBody.slice(0, 200)}`);
    return null;
  }
}

// ── File helpers ──────────────────────────────────────────────────────────────

function saveFile(filename: string, content: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, "utf-8");
    logger.debug(`[realtor] Saved → logs/${filename}`);
  } catch (e) {
    logger.warn(`[realtor] Could not save ${filename}: ${e}`);
  }
}

function urlSlug(url: string): string {
  return url
    .replace(/https?:\/\/[^/]+\/[^/]+\//, "")
    .replace(/\W+/g, "_")
    .slice(0, 40)
    .toLowerCase();
}

// ── Estimate fetcher ──────────────────────────────────────────────────────────

async function attachEstimates(listings: RawListing[]): Promise<void> {
  if (!FETCH_ESTIMATES || listings.length === 0) return;

  logger.info(
    `[realtor] Fetching estimates for ${listings.length} listing(s) ` +
    `(concurrency=${DETAIL_CONCURRENCY})…`
  );

  let hit = 0, miss = 0;

  for (let i = 0; i < listings.length; i += DETAIL_CONCURRENCY) {
    const batch = listings.slice(i, i + DETAIL_CONCURRENCY);

    await Promise.all(
      batch.map(async (listing) => {
        const propId = (listing as any)._realtorPropertyId as string | undefined;
        if (!propId) { miss++; return; }

        const body = buildDetailQuery(propId);
        const data = await graphqlPost(body);
        if (!data) { miss++; return; }

        const est = parseRealtorDetailGraphQL(data, listing.address ?? propId);
        if (est) {
          (listing as any).zestimate      = est.estimate;
          (listing as any).zestimateLow   = est.estimateLow;
          (listing as any).zestimateHigh  = est.estimateHigh;
          (listing as any).estimateSource = est.provider ?? "realtor";
          hit++;
          logger.info(
            `[realtor] ✓ Estimate ${listing.address}: ` +
            `$${est.estimate.toLocaleString()}` +
            (est.estimateLow
              ? ` ($${est.estimateLow.toLocaleString()} – $${est.estimateHigh?.toLocaleString()})`
              : "")
          );
        } else {
          miss++;
        }
      })
    );

    if (i + DETAIL_CONCURRENCY < listings.length) {
      await sleep(400 + Math.random() * 300);
    }
  }

  logger.info(
    `[realtor] Estimates: ${hit} found, ${miss} missing / ${listings.length}`
  );
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class RealtorScraper extends BaseScraper {
  readonly sourceName = "realtor";
  private allListings: RawListing[] = [];

  constructor(options: ScraperOptions = {}) {
    super(options);

    const urls = getSearchUrls();
    logger.info(
      `[realtor] ${urls.length} search URL(s), up to ${this.options.maxPages} page(s) each\n` +
      urls.map((u) => `  • ${u}`).join("\n")
    );
    logger.info(
      `[realtor] Transport: direct GraphQL (${REALTOR_HOST}${HULK_PATH}) | ` +
      `proxy: ${PROXY_URL ? PROXY_URL.replace(/:[^:@]+@/, ":***@") : "none"} | ` +
      `timeout: ${REQUEST_TIMEOUT_MS / 1_000}s | ` +
      `fetchEstimates: ${FETCH_ESTIMATES}`
    );
  }

  override async run(): Promise<RawListing[]> {
    logger.info("[realtor] Starting");
    this.visited.clear();
    this.results     = [];
    this.allListings = [];

    const searchUrls = getSearchUrls();
    const rejected: Array<{ listing: RawListing; reason: string }> = [];

    for (let urlIdx = 0; urlIdx < searchUrls.length; urlIdx++) {
      const baseUrl = searchUrls[urlIdx];
      const params  = parseSearchUrl(baseUrl);

      logger.info(
        `[realtor] ── URL ${urlIdx + 1}/${searchUrls.length}: ` +
        `${params.city}, ${params.stateCode} | ` +
        `types=[${params.propertyTypes.join(",")}] | ` +
        `price_max=$${(params.priceMax ?? config.filter.maxPrice).toLocaleString()}`
      );

      if (this.results.length >= this.options.maxListings) {
        logger.info("[realtor] maxListings reached — skipping remaining URLs");
        break;
      }

      let totalKnown = 0;

      for (let page = 1; page <= this.options.maxPages; page++) {
        if (this.results.length >= this.options.maxListings) break;

        const offset = (page - 1) * RESULTS_PER_PAGE;
        logger.info(
          `[realtor] ${params.city}, ${params.stateCode} ` +
          `page ${page}/${this.options.maxPages} (offset ${offset})`
        );

        const body = buildSearchQuery(params, offset);
        const data = await graphqlPost(body);

        if (!data) {
          logger.warn(`[realtor] No data for ${params.city} p${page} — stopping`);
          break;
        }

        if (page <= DEBUG_PAGES) {
          saveFile(
            `realtor_api_${urlSlug(baseUrl)}_p${page}.json`,
            JSON.stringify(data, null, 2)
          );
        }

        const { listings, total, hasMore } = parseRealtorGraphQL(data);

        if (page === 1 && total > 0) {
          totalKnown = total;
          logger.info(
            `[realtor] ${params.city}: ${total} total results ` +
            `(~${Math.ceil(total / RESULTS_PER_PAGE)} pages)`
          );
        }

        logger.info(
          `[realtor] ${params.city} p${page}: ${listings.length} listings | hasMore=${hasMore}`
        );

        this.allListings.push(...listings);

        // Fetch estimates for this page's listings before filtering
        await attachEstimates(listings);

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
          if (!this.passesFilter(listing)) {
            rejected.push({ listing, reason: "filtered" });
            logger.debug(`[realtor] ✗ filtered: ${listing.address} @ $${listing.price}`);
            continue;
          }

          this.visited.add(listing.url);
          this.results.push(listing);

          const est = (listing as any).zestimate as number | undefined;
          logger.info(
            `[realtor] ✓ [${this.results.length}/${this.options.maxListings}] ` +
            `${listing.address} @ $${listing.price?.toLocaleString() ?? "?"} ` +
            (est ? `| est $${est.toLocaleString()}` : "| no estimate")
          );
        }

        if (!hasMore || listings.length === 0) {
          logger.info(`[realtor] ${params.city}: no more pages`);
          break;
        }

        // Stop if we've clearly exhausted results
        if (totalKnown > 0 && offset + listings.length >= totalKnown) {
          logger.info(`[realtor] ${params.city}: reached end of results (${totalKnown})`);
          break;
        }

        await sleep(jitter(BETWEEN_PAGE_MS));
      }

      if (urlIdx < searchUrls.length - 1) {
        await sleep(2_000 + Math.random() * 1_000);
      }
    }

    logger.info(
      `[realtor] Done — ${this.results.length} accepted, ${rejected.length} rejected`
    );

    const withEst = this.results.filter((l) => (l as any).zestimate != null).length;
    logger.info(
      `[realtor] Estimates: ${withEst}/${this.results.length} listings have one`
    );

    saveFile(
      "realtor.json",
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

  protected async scrapePage(_h: BrowserHandle, _p: number): Promise<RawListing[]> {
    return [];
  }

  protected shouldContinue(_p: number): boolean {
    return false;
  }
}