// src/scrapers/creativelisting/creativelisting.scraper.ts
//
// Scrapes CreativeListing.com — a React SPA creative-finance marketplace
// built by Pace Morby's SubTo community.
//
// ── Authentication strategy ───────────────────────────────────────────────────
//
// CreativeListing uses AWS Cognito for authentication. Auth lives entirely in
// localStorage as JWT tokens. This scraper bypasses the React SPA entirely and
// calls the internal REST API directly:
//
//   GET https://www.creativelisting.com/api/deals
//       ?page=1&limit=9&state=OH&status=active&sort=age-desc
//   Authorization: Bearer <idToken>
//
// Tokens are auto-refreshed before every run using CL_REFRESH_TOKEN (30-day TTL).
// You should never need to manually update CL_AUTH_TOKEN again unless the
// refresh token itself expires (30 days of inactivity).
//
// Initial setup (one-time):
//   1. Log in to creativelisting.com in a real browser.
//   2. Open DevTools → Network → filter for "/api/deals"
//   3. Copy the Authorization: Bearer <token> header value into .env as CL_AUTH_TOKEN
//   4. Open DevTools → Application → Local Storage → https://www.creativelisting.com
//   5. Copy the following values into .env:
//        CL_REFRESH_TOKEN  ← awsCognitoRefreshToken (or CognitoIdentityServiceProvider...refreshToken)
//        CL_COGNITO_CLIENT_ID  ← the alphanumeric segment in any
//                                CognitoIdentityServiceProvider.<THIS>.xxx key
//        CL_COGNITO_USERNAME   ← value of CognitoIdentityServiceProvider.<id>.LastAuthUser
//   6. Also set:
//        CL_USER_POOL_REGION=us-east-2
//        CL_USER_POOL_ID=us-east-2_JntngCwuB
//
// ── API endpoint (verified from DevTools Network tab) ────────────────────────
//
//   Base:      https://www.creativelisting.com/api/deals
//   Params:    page, limit, state, status, sort=age-desc
//   Auth:      Authorization: Bearer <idToken>
//   Response:  { deals: [...], pagination: { total, totalPages, currentPage, limit, hasMore } }
//
// ── Why direct API instead of Oxylabs ────────────────────────────────────────
//
//   The React SPA fetches data from this internal API, which accepts Bearer
//   tokens directly. No browser rendering required — we just call the API,
//   bypassing all the React hydration / RequireAuth / Oxylabs timing issues.

import * as https from "https";
import * as http  from "http";
import * as zlib  from "zlib";
import * as fs    from "fs";
import * as path  from "path";
import HttpsProxyAgent from "https-proxy-agent";

import { BaseScraper, ScraperOptions }       from "../base.scraper";
import { RawListing }                        from "../../types/listing";
import { logger }                            from "../../utils/logger";
import { sleep, jitter }                     from "../../utils/browser";
import {
  cardToRawListing,
  extractStateFromAddress,
}                                            from "./creative-listing.parser";
import { config }                            from "../../config";

// ── Constants ─────────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;
const BETWEEN_PAGE_MS    = 2_000;

const BASE_URL           = "https://www.creativelisting.com";
const API_PATH           = "/api/deals";
const PAGE_LIMIT         = 9;
const SORT               = "age-desc";

// ── Cognito Auth ──────────────────────────────────────────────────────────────

const clTokens = {
  authToken:   process.env.CL_AUTH_TOKEN   ?? "",
  accessToken: process.env.CL_ACCESS_TOKEN ?? "",
};

const CL_REFRESH_TOKEN     = process.env.CL_REFRESH_TOKEN      ?? "";
const CL_COGNITO_CLIENT_ID = process.env.CL_COGNITO_CLIENT_ID  ?? "";
const CL_COGNITO_USERNAME  = process.env.CL_COGNITO_USERNAME   ?? "";
const CL_USER_POOL_REGION  = process.env.CL_USER_POOL_REGION   ?? "us-east-2";

// ── URL builder ───────────────────────────────────────────────────────────────

interface ApiUrlOptions {
  state?:  string;
  page?:   number;
  status?: string;
}

function buildApiUrl({ state, page = 1, status = "active" }: ApiUrlOptions): string {
  const params = new URLSearchParams();
  params.set("page",   String(page));
  params.set("limit",  String(PAGE_LIMIT));
  if (state)  params.set("state",  state);
  params.set("status", status);
  params.set("sort",   SORT);
  return `${BASE_URL}${API_PATH}?${params.toString()}`;
}

// ── Cognito token auto-refresh ────────────────────────────────────────────────

async function refreshCognitoTokens(): Promise<boolean> {
  if (!CL_REFRESH_TOKEN) {
    logger.warn("[cl] Cannot refresh — CL_REFRESH_TOKEN not set in .env");
    return false;
  }
  if (!CL_COGNITO_CLIENT_ID) {
    logger.warn("[cl] Cannot refresh — CL_COGNITO_CLIENT_ID not set in .env");
    return false;
  }

  const body = JSON.stringify({
    AuthFlow:       "REFRESH_TOKEN_AUTH",
    ClientId:       CL_COGNITO_CLIENT_ID,
    AuthParameters: { REFRESH_TOKEN: CL_REFRESH_TOKEN },
  });

  logger.debug("[cl] Calling Cognito InitiateAuth (REFRESH_TOKEN_AUTH)…");

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: `cognito-idp.${CL_USER_POOL_REGION}.amazonaws.com`,
        path:     "/",
        method:   "POST",
        family:   4,
        headers:  {
          "Content-Type":   "application/x-amz-json-1.1",
          "X-Amz-Target":  "AWSCognitoIdentityProviderService.InitiateAuth",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf-8");
            const json = JSON.parse(text);

            if (json?.__type === "NotAuthorizedException") {
              logger.error(
                "[cl] Cognito refresh rejected — refresh token is expired or revoked. " +
                "Re-login to creativelisting.com and update CL_REFRESH_TOKEN in .env"
              );
              resolve(false);
              return;
            }

            const result = json?.AuthenticationResult;
            if (!result?.IdToken) {
              logger.error(`[cl] Token refresh unexpected response: ${text.slice(0, 300)}`);
              resolve(false);
              return;
            }

            clTokens.authToken   = result.IdToken;
            clTokens.accessToken = result.AccessToken ?? clTokens.accessToken;

            logger.info(
              `[cl] Cognito tokens refreshed — expires in ${result.ExpiresIn ?? "?"}s`
            );
            logger.debug(
              `[cl] New authToken length: ${clTokens.authToken.length} | ` +
              `accessToken length: ${clTokens.accessToken.length}`
            );
            resolve(true);
          } catch (err) {
            logger.error(`[cl] Token refresh parse error: ${err}`);
            resolve(false);
          }
        });
        res.on("error", (err: Error) => {
          logger.error(`[cl] Token refresh response error: ${err.message}`);
          resolve(false);
        });
      }
    );

    req.setTimeout(15_000, () => {
      req.destroy(new Error("Cognito refresh timeout"));
      resolve(false);
    });
    req.on("error", (err: Error) => {
      logger.error(`[cl] Token refresh request error: ${err.message}`);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

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

// ── Direct API fetch ──────────────────────────────────────────────────────────
//
// Calls the CreativeListing internal REST API directly with a Bearer token.
// No Oxylabs, no browser rendering — just a plain HTTPS GET request.

interface ApiResponse {
  deals:      CLDeal[];
  pagination: {
    total:       number;
    totalPages:  number;
    currentPage: number;
    limit:       number;
    hasMore:     boolean;
  };
}

// Minimal shape — we only type what we actually use. The full JSON is richer.
interface CLDeal {
  id:               string;
  streetAddress:    string;
  city:             string;
  state:            string;
  zipCode:          string;
  fullAddress?:     string;
  purchasePrice:    number;
  bedrooms?:        number;
  bathrooms?:       number;
  squareFootage?:   number;
  lotSize?:         number;
  lotSizeUnit?:     string;
  yearBuilt?:       number;
  listingType?:     string;
  assetCategory?:   string;
  dealCategory?:    string;
  purchaseType?:    string;
  story?:           string;
  photos?:          string[];
  coordinates?:     { lat: number; lng: number };
  status?:          string;
  monthlyCost?:     number;
  downPayment?:     number;
  emd?:             number;
  tags?:            string[];
  hideAddress?:     boolean;
  originator?: {
    name?:            string;
    email?:           string;
    phoneNumber?:     string;
    callBookingLink?: string | null;
  };
  subjectToLoans?: Array<{
    interestRate?:  number;
    loanBalance?:   number | null;
    piti?:          number;
    loanType?:      string;
    loanMaturity?:  string;
  }>;
  sellerFinanceLoans?: Array<{
    sellerLoanAmount?:    number;
    sellerInterestRate?:  number;
    pi?:                  number;
    sellerLoanMaturity?:  string;
  }>;
  [key: string]: unknown;
}

async function apiFetch(url: string): Promise<ApiResponse | null> {
  if (!clTokens.authToken) {
    logger.error("[cl] No auth token — cannot call API. Set CL_AUTH_TOKEN or CL_REFRESH_TOKEN in .env");
    return null;
  }

  logger.debug(`[cl] API GET → ${url}`);

  return new Promise((resolve) => {
    const parsed = new URL(url);
    // Proxy selection priority:
    //  1. PROXY_URL (explicit single proxy)
    //  2. PROXY_URLS (comma-separated list in .env) — pick one at random
    //  3. config.proxyUrl (global config)
    const proxiesEnv = process.env.PROXY_URLS ?? "";
    const proxies = proxiesEnv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);

    let proxyUrl = process.env.PROXY_URL ?? (config as any).proxyUrl ?? "";
    if (!proxyUrl && proxies.length > 0) {
      proxyUrl = proxies[Math.floor(Math.random() * proxies.length)];
    }

    let agent: any = undefined;
    if (proxyUrl) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        agent = new (HttpsProxyAgent as any)(proxyUrl);
        const masked = proxyUrl.replace(/:\/\/([^:]+):([^@]+)@/, "://$1:***@");
        logger.info(`[cl] Using proxy for API requests: ${masked}`);
      } catch (err) {
        logger.warn(`[cl] Could not create proxy agent: ${err}`);
        agent = undefined;
      }
    }

    const req = https.request(
      {
        hostname: parsed.hostname,
        path:     parsed.pathname + parsed.search,
        method:   "GET",
        family:   4,
        agent,
        headers:  {
          "Accept":          "application/json, */*",
          "Accept-Encoding": "gzip, deflate, br",
          "Authorization":   `Bearer ${clTokens.authToken}`,
          "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
          "Sec-Fetch-Mode":  "cors",
          "Sec-Fetch-Site":  "same-origin",
          "Referer":         "https://www.creativelisting.com/deals",
          "Origin":          "https://www.creativelisting.com",
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

          const text = dec.toString("utf-8");
          logger.debug(`[cl] API response: HTTP ${res.statusCode} | ${text.length} chars`);

          if (res.statusCode === 401 || res.statusCode === 403) {
            logger.warn(`[cl] API returned ${res.statusCode} — token may be expired`);
            logger.warn(`[cl] Body: ${text.slice(0, 1000)}`);
            resolve(null);
            return;
          }
          if (res.statusCode === 429) {
            logger.warn("[cl] API rate-limited (429)");
            resolve(null);
            return;
          }
          if (res.statusCode !== 200) {
            logger.warn(`[cl] API HTTP ${res.statusCode} for ${url}`);
            logger.warn(`[cl] Body: ${text.slice(0, 1000)}`);
            resolve(null);
            return;
          }

          try {
            const json = JSON.parse(text) as ApiResponse;
            resolve(json);
          } catch (err) {
            logger.error(`[cl] Failed to parse API response: ${err}`);
            logger.debug(`[cl] Raw: ${text.slice(0, 500)}`);
            resolve(null);
          }
        });
        res.on("error", (err: Error) => {
          logger.error(`[cl] API response error: ${err.message}`);
          resolve(null);
        });
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("API request timeout"));
      resolve(null);
    });
    req.on("error", (err: Error) => {
      logger.error(`[cl] API request error: ${err.message}`);
      resolve(null);
    });
    req.end();
  });
}

// ── Deal → RawListing mapper ──────────────────────────────────────────────────
//
// Maps a CLDeal from the API response directly to a RawListing.
// This replaces the HTML card parser path entirely.

function dealToRawListing(deal: CLDeal): RawListing {
  const address = deal.hideAddress
    ? `${deal.city}, ${deal.state} ${deal.zipCode}`
    : `${deal.streetAddress}, ${deal.city}, ${deal.state} ${deal.zipCode}`;

  const url = deal.hideAddress
    ? `https://www.creativelisting.com/deals`
    : `https://www.creativelisting.com/listing/${deal.fullAddress ?? deal.id}`;

  // Derive property type
  let propertyType: RawListing["propertyType"] = "unknown";
  const lt = (deal.listingType ?? "").toLowerCase();
  if (lt.includes("single") || lt.includes("family")) propertyType = "single_family";
  else if (lt.includes("multi"))                        propertyType = "multi_family";
  else if (lt.includes("condo"))                        propertyType = "condo";

  return {
    source:        "creativelisting",
    url,
    address,
    city:          deal.city ?? "",
    state:         deal.state ?? "",
    zip:           deal.zipCode ?? "",
    price:         deal.purchasePrice ?? 0,
    bedrooms:      deal.bedrooms      ?? null,
    bathrooms:     deal.bathrooms     ?? null,
    squareFeet:    deal.squareFootage ?? null,
    lotSize:       deal.lotSize       ?? null,
    yearBuilt:     deal.yearBuilt     ?? null,
    propertyType,
    description:   deal.story         ?? "",
    photos:        deal.photos        ?? [],
    lat:           deal.coordinates?.lat ?? null,
    lng:           deal.coordinates?.lng ?? null,

    // Creative-finance extras stored on the raw object for downstream use
    _clDealId:       deal.id,
    _clDealCategory: deal.dealCategory  ?? null,   // "creative" | "cash"
    _clPurchaseType: deal.purchaseType  ?? null,   // "SubTo" | "SellerFinance" | "LeaseOption"
    _clMonthlyCost:  deal.monthlyCost   ?? null,
    _clDownPayment:  deal.downPayment   ?? null,
    _clEmd:          deal.emd           ?? null,
    _clTags:         deal.tags          ?? [],
    _clOriginator:   deal.originator    ?? null,
    _clSubToLoans:   deal.subjectToLoans    ?? [],
    _clSellerLoans:  deal.sellerFinanceLoans ?? [],
  } as unknown as RawListing;
}

// ── File helpers ──────────────────────────────────────────────────────────────

function saveFile(filename: string, content: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, "utf-8");
    logger.info(`[cl] Saved → logs/${filename}`);
  } catch (err) {
    logger.warn(`[cl] Could not save ${filename}: ${err}`);
  }
}

// ── Market config ─────────────────────────────────────────────────────────────

interface CLMarket {
  name:      string;
  stateAbbr: string;
}

// ── Scraper ───────────────────────────────────────────────────────────────────

export class CreativeListingScraper extends BaseScraper {
  readonly sourceName = "creativelisting";

  private readonly markets: readonly CLMarket[];

  constructor(options: ScraperOptions = {}) {
    super(options);

    const rc = (config.sources as any).creativelisting ?? {
      markets: [
        { name: "Ohio",      stateAbbr: "OH" },
        { name: "Wisconsin", stateAbbr: "WI" },
      ],
    };

    this.markets = rc.markets;

    logger.info(
      `[cl] ${this.markets.length} market(s) | ` +
      `up to ${this.options.maxPages} page(s)/market`
    );

    if (!CL_REFRESH_TOKEN) {
      logger.warn(
        "[cl] CL_REFRESH_TOKEN not set — tokens will not auto-refresh. " +
        "Grab awsCognitoRefreshToken from DevTools → Application → Local Storage."
      );
    }

    if (!clTokens.authToken && !CL_REFRESH_TOKEN) {
      logger.error(
        "[cl] Neither CL_AUTH_TOKEN nor CL_REFRESH_TOKEN are set — scraper will fail.\n" +
        "Steps to fix:\n" +
        "  1. Log in at creativelisting.com\n" +
        "  2. DevTools → Network → filter for /api/deals\n" +
        "  3. Copy the Authorization: Bearer <token> value into .env as CL_AUTH_TOKEN\n" +
        "  4. DevTools → Application → Local Storage\n" +
        "  5. Also copy into .env:\n" +
        "       CL_REFRESH_TOKEN  ← awsCognitoRefreshToken\n" +
        "       CL_COGNITO_CLIENT_ID  ← segment in CognitoIdentityServiceProvider.<THIS>.xxx\n" +
        "       CL_COGNITO_USERNAME   ← CognitoIdentityServiceProvider.<id>.LastAuthUser\n" +
        "       CL_USER_POOL_REGION=us-east-2"
      );
    }
  }

  override async run(): Promise<RawListing[]> {
    this.visited.clear();
    this.results = [];
    const rejected: Array<{ listing: RawListing; reason: string }> = [];

    const maxPrice = config.filter.maxPrice;

    // ── Token refresh ─────────────────────────────────────────────────────
    if (CL_REFRESH_TOKEN) {
      logger.info("[cl] Auto-refreshing Cognito tokens before run…");
      const refreshed = await refreshCognitoTokens();
      if (!refreshed) {
        if (!clTokens.authToken) {
          logger.error("[cl] Refresh failed and no fallback CL_AUTH_TOKEN — aborting run");
          return [];
        }
        logger.warn("[cl] Token refresh failed — continuing with existing CL_AUTH_TOKEN (may be expired)");
      }
    } else if (!clTokens.authToken) {
      logger.error("[cl] No CL_AUTH_TOKEN and no CL_REFRESH_TOKEN — aborting run");
      return [];
    }

    // ── Scrape each market via direct API calls ────────────────────────────

    for (const market of this.markets) {
      if (this.results.length >= this.options.maxListings) {
        logger.info("[cl] maxListings reached — skipping remaining markets");
        break;
      }

      logger.info(`[cl] Scraping market: ${market.name} (state=${market.stateAbbr})`);

      let tokenRefreshedThisMarket = false;

      for (let page = 1; page <= this.options.maxPages; page++) {
        if (this.results.length >= this.options.maxListings) break;

        const url = buildApiUrl({ state: market.stateAbbr, page });
        logger.info(`[cl] ${market.name} page ${page}/${this.options.maxPages} → ${url}`);

        let apiResp = await apiFetch(url);

        // ── Token expired handling: refresh once and retry ─────────────
        if (apiResp === null && !tokenRefreshedThisMarket && CL_REFRESH_TOKEN) {
          logger.warn(`[cl] ${market.name} p${page}: API returned null — attempting token refresh`);
          tokenRefreshedThisMarket = true;

          const ok = await refreshCognitoTokens();
          if (ok) {
            await sleep(500);
            apiResp = await apiFetch(buildApiUrl({ state: market.stateAbbr, page }));
          }

          if (apiResp === null) {
            logger.error(
              `[cl] ${market.name} p${page}: still failing after token refresh — ` +
              `refresh token may be expired. Re-login and update CL_REFRESH_TOKEN in .env`
            );
            break;
          }
        } else if (apiResp === null) {
          logger.warn(`[cl] ${market.name} p${page}: no data — skipping`);
          break;
        }

        const deals    = apiResp.deals ?? [];
        const pagination = apiResp.pagination;

        logger.info(
          `[cl] ${market.name} p${page}: ${deals.length} deal(s) | ` +
          `total=${pagination?.total ?? "?"} | hasMore=${pagination?.hasMore ?? "?"}`
        );

        if (deals.length === 0) {
          logger.warn(`[cl] ${market.name} p${page}: 0 deals returned`);
          break;
        }

        for (const deal of deals) {
          if (this.results.length >= this.options.maxListings) break;

          // ── Dedup by deal ID ─────────────────────────────────────────
          if (this.visited.has(deal.id)) {
            rejected.push({ listing: dealToRawListing(deal), reason: "duplicate" });
            continue;
          }

          // ── State filter ─────────────────────────────────────────────
          if (market.stateAbbr && deal.state && deal.state !== market.stateAbbr) {
            logger.debug(
              `[cl] ✗ Wrong state — expected ${market.stateAbbr}, got ${deal.state}: ${deal.streetAddress}`
            );
            rejected.push({ listing: dealToRawListing(deal), reason: "wrong_location" });
            continue;
          }

          // ── Price filter ─────────────────────────────────────────────
          if (deal.purchasePrice != null) {
            if (deal.purchasePrice < config.filter.minPrice) {
              rejected.push({ listing: dealToRawListing(deal), reason: "below_min_price" });
              logger.debug(`[cl] ✗ Below min price: ${deal.streetAddress} @ $${deal.purchasePrice}`);
              continue;
            }
            if (deal.purchasePrice > maxPrice) {
              rejected.push({ listing: dealToRawListing(deal), reason: "above_max_price" });
              logger.debug(`[cl] ✗ Above max price: ${deal.streetAddress} @ $${deal.purchasePrice}`);
              continue;
            }
          }

          const raw = dealToRawListing(deal);

          if (!this.passesFilter(raw)) {
            rejected.push({ listing: raw, reason: "filtered" });
            logger.debug(`[cl] ✗ Filtered: ${deal.streetAddress}`);
            continue;
          }

          this.visited.add(deal.id);
          this.results.push(raw);

          logger.info(
            `[cl] ✓ [${this.results.length}/${this.options.maxListings}] ` +
            `${deal.streetAddress ?? "hidden"}, ${deal.city} @ $${deal.purchasePrice?.toLocaleString()} | ` +
            `type=${deal.purchaseType ?? deal.dealCategory}`
          );
        }

        // ── Pagination check ─────────────────────────────────────────
        if (!pagination?.hasMore) {
          logger.info(`[cl] ${market.name}: no more pages — done`);
          break;
        }

        if (page < this.options.maxPages) {
          await sleep(jitter(BETWEEN_PAGE_MS));
        }
      }
    }

    logger.info(
      `[cl] Done — ${this.results.length} accepted, ${rejected.length} rejected`
    );

    // ── JSON dump ─────────────────────────────────────────────────────────
    saveFile(
      `${this.sourceName}.json`,
      JSON.stringify(
        {
          accepted:    this.results,
          rejected,
          generatedAt: new Date().toISOString(),
        },
        null,
        2
      )
    );

    logger.info(`[cl] Finished — ${this.results.length} listings`);
    return this.results;
  }

  protected async scrapePage(_h: any, _p: number): Promise<RawListing[]> {
    return [];
  }
  protected hasMorePages(_p: number, _r: RawListing[]): boolean {
    return false;
  }
}