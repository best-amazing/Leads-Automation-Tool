// src/scrapers/realtor/realtor.scraper.ts
//
// ── Transport ─────────────────────────────────────────────────────────────────
//
// Two-phase approach to defeat Kasada bot protection on Realtor.com:
//
//   PHASE 1 — Playwright browser handshake
//     Launches a headless Chromium browser (via playwright), navigates to the
//     Realtor.com search page, waits for Kasada's /ips.js challenge to resolve,
//     then harvests the solved cookies (KP_UIDz, KP_UIDz-ssn) and the
//     x-kpsdk-ct / x-kpsdk-cd response headers that Kasada requires on API
//     calls.
//
//     Strategy for capturing x-kpsdk-ct (in order of preference):
//       1. Wait for the page to fire its own hulk XHR (networkidle gives more
//          time for this to happen naturally).
//       2. If that doesn't fire, trigger the API call from INSIDE the page via
//          page.evaluate + fetch(), which carries the full browser fingerprint
//          (TLS JA3/JA4, HTTP/2 framing, header order) that Kasada requires to
//          issue a ct token.  context.request.fetch() is NOT used as a fallback
//          because it lacks these fingerprints and consistently returns 403 with
//          ct=absent.
//
//   PHASE 2 — Raw HTTPS GraphQL calls
//     Uses the harvested cookies + Kasada tokens as additional headers on every
//     POST to /api/v1/hulk. On 403, the response headers often contain a fresh
//     x-kpsdk-ct; we retry once with it before triggering a full handshake
//     refresh, avoiding the expensive browser round-trip in the common case.
//
// ── Proxy usage ───────────────────────────────────────────────────────────────
//
//   CRITICAL: Kasada ties KP_UIDz cookies to the IP that solved the challenge.
//   Once a session is established on a given proxy, ALL subsequent API calls
//   must use that same proxy. kasadaTokens.proxyUrl is used for every API call;
//   the rotator is consulted for each new handshake (including refreshes) so
//   that a blocked/flagged IP is not reused.
//
// ── Required dependencies ─────────────────────────────────────────────────────
//   npm install playwright
//   npx playwright install chromium
//
// ── Optional .env ─────────────────────────────────────────────────────────────
//   PROXY_URLS                — comma-separated proxy list (preferred)
//   PROXY_URL                 — single fallback proxy (legacy)
//   REALTOR_SEARCH_URLS       — comma-separated search URLs
//   REALTOR_MAX_PAGES         — per-URL page cap (default 10)
//   REALTOR_MAX_LISTINGS      — hard cap per run (default 200)
//   REALTOR_FETCH_ESTIMATES   — set "false" to skip detail fetches
//   REALTOR_FETCH_TIMEOUT     — ms timeout per raw request (default 30000)
//   REALTOR_HANDSHAKE_TIMEOUT — ms timeout for Playwright handshake (default 60000)
//   REALTOR_HEADLESS          — set "false" to watch the browser (debug only)
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
import { getProxyRotator }              from "../../utils/proxy-rotator";
import {
  parseRealtorGraphQL,
  parseRealtorDetailGraphQL,
  MAX_DAYS_OLD,
} from "./realtor.parser";
import { config } from "../../config";

// ── Config ────────────────────────────────────────────────────────────────────

const FETCH_ESTIMATES      = process.env.REALTOR_FETCH_ESTIMATES !== "false";
const REQUEST_TIMEOUT_MS   = Number(process.env.REALTOR_FETCH_TIMEOUT)    || 30_000;
const HANDSHAKE_TIMEOUT_MS = Number(process.env.REALTOR_HANDSHAKE_TIMEOUT) || 60_000;
const HEADLESS             = process.env.REALTOR_HEADLESS !== "false";
const LEGACY_PROXY_URL     = process.env.PROXY_URL ?? "";
const BETWEEN_PAGE_MS      = 2_000;
const DETAIL_CONCURRENCY   = 4;
const DEBUG_PAGES          = 3;
const RESULTS_PER_PAGE     = 42;

// Dead proxies should fail fast so we don't stall the whole run.
// The full REQUEST_TIMEOUT_MS applies only after the tunnel is established.
const PROXY_CONNECT_TIMEOUT_MS = 10_000;

// How many ms to wait for the page's own hulk XHR after navigation settles.
// Increased from 8s — networkidle gives more time but we still poll explicitly.
const CT_WAIT_MS = 20_000;

// How many consecutive 429s before we re-run the Kasada handshake
const MAX_429_BEFORE_REFRESH = 2;

const REALTOR_HOST = "www.realtor.com";
const HULK_PATH    = "/api/v1/hulk";
const HULK_URL     = `https://${REALTOR_HOST}${HULK_PATH}`;

// ── Kasada token store ────────────────────────────────────────────────────────

interface KasadaTokens {
  /** KP_UIDz cookie value */
  kpUidz:    string;
  /** KP_UIDz-ssn cookie value */
  kpUidzSsn: string;
  /** x-kpsdk-ct header value (changes per resolved challenge) */
  xKpsdkCt:  string;
  /** x-kpsdk-cd header value (PoW answer) */
  xKpsdkCd?: string;
  /** The proxy URL that was used to solve this challenge */
  proxyUrl:  string | null;
  /** Timestamp the tokens were collected */
  solvedAt:  number;
}

let kasadaTokens: KasadaTokens | null = null;
// Tokens expire after 10 minutes to be safe (real TTL is ~15 min)
const TOKEN_TTL_MS = 10 * 60 * 1_000;

// ── Proxy resolution ──────────────────────────────────────────────────────────

function getNextProxyUrl(): string | null {
  try {
    const rotator = getProxyRotator();
    if (rotator.getProxyCount() > 0) return rotator.getNextProxy();
  } catch { /* not initialised */ }
  return LEGACY_PROXY_URL || null;
}

function maskProxyUrl(url: string): string {
  try {
    const u    = new URL(url);
    const auth = u.username ? `${u.username}:***@` : "";
    return `http://${auth}${u.host}`;
  } catch {
    return url.replace(/:[^:/@]+@/g, ":***@");
  }
}

// ── Playwright Kasada handshake ───────────────────────────────────────────────
//
// Strategy for obtaining x-kpsdk-ct:
//
//   1. Navigate with waitUntil:"networkidle" so the page has more time to fire
//      its own hulk XHR.  The response listener captures ct from that XHR.
//
//   2. If the page still hasn't fired a hulk XHR after CT_WAIT_MS, trigger one
//      from INSIDE the page via page.evaluate().  This uses the real browser's
//      fetch(), which carries the full TLS/HTTP2 fingerprint Kasada checks.
//      context.request.fetch() is intentionally NOT used here — it bypasses
//      the browser stack and Kasada consistently blocks it (ct=absent).
//
//   3. Check whether Kasada's /ips.js challenge script actually ran, and log a
//      warning if not (helps diagnose proxy/fingerprint issues early).

async function runKasadaHandshake(
  searchUrl: string,
  proxyUrl:  string | null,
): Promise<KasadaTokens | null> {
  let chromium: any;
  try {
    const pw = await import("playwright");
    chromium  = pw.chromium;
  } catch {
    logger.error(
      "[realtor] playwright not installed. Run: npm install playwright && npx playwright install chromium"
    );
    return null;
  }

  logger.info("[realtor] Starting Kasada handshake via Playwright…");

  const launchOptions: any = {
    headless: HEADLESS,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  };

  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      launchOptions.proxy = {
        server:   `${u.protocol}//${u.host}`,
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      };
      logger.info(`[realtor] Handshake proxy: ${maskProxyUrl(proxyUrl)}`);
    } catch {
      logger.warn("[realtor] Could not parse proxy URL for Playwright");
    }
  }

  let browser: any = null;

  try {
    browser = await chromium.launch(launchOptions);

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
        "AppleWebKit/537.36 (KHTML, like Gecko) " +
        "Chrome/124.0.0.0 Safari/537.36",
      locale:   "en-US",
      viewport: { width: 1280, height: 800 },
      extraHTTPHeaders: {
        "accept-language": "en-US,en;q=0.9",
      },
    });

    // Mask automation fingerprints
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      Object.defineProperty(navigator, "plugins",   { get: () => [1, 2, 3, 4, 5] });
      (window as any).chrome = { runtime: {} };
    });

    const page = await context.newPage();

    // ── Intercept page's own hulk XHRs (fast path) ────────────────────────
    let capturedCt: string = "";
    let capturedCd: string = "";

    page.on("response", async (response: any) => {
      try {
        if (!response.url().includes("/api/v1/hulk")) return;
        const ct = response.headers()["x-kpsdk-ct"] ?? "";
        const cd = response.headers()["x-kpsdk-cd"] ?? "";
        if (ct) capturedCt = ct;
        if (cd) capturedCd = cd;
        logger.debug(
          `[realtor] page hulk XHR: ${response.status()} | ` +
          `ct=${ct ? ct.slice(0, 20) + "…" : "none"}`
        );
      } catch { /* ignore */ }
    });

    // ── Navigate to the search page ───────────────────────────────────────
    // Use "networkidle" instead of "domcontentloaded" so the page has time
    // to complete XHRs (including the hulk call) before we start polling.
    logger.info(`[realtor] Browser navigating to: ${searchUrl}`);
    try {
      await page.goto(searchUrl, {
        waitUntil: "networkidle",
        timeout:   HANDSHAKE_TIMEOUT_MS,
      });
    } catch (navErr: any) {
      // networkidle can time-out on slow proxies; that's acceptable — cookies
      // and XHRs may already have been set/fired before the timeout.
      logger.warn(`[realtor] Navigation did not reach networkidle: ${navErr.message}`);
    }

    // ── Sanity-check: did Kasada's challenge script actually run? ──────────
    const kasadaResolved = await page.evaluate(() => {
      return typeof (window as any).kpsdk !== "undefined";
    }).catch(() => false);

    if (!kasadaResolved) {
      logger.warn(
        "[realtor] Kasada /ips.js challenge script not detected on page — " +
        "proxy IP may be flagged or TLS fingerprint blocked"
      );
    }

    // ── Wait for Kasada to set KP_UIDz ────────────────────────────────────
    logger.info("[realtor] Waiting for Kasada cookies to be set…");
    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;

    let kpUidz    = "";
    let kpUidzSsn = "";

    while (Date.now() < deadline) {
      const cookies = await context.cookies(`https://${REALTOR_HOST}`);
      const uid     = cookies.find((c: any) => c.name === "KP_UIDz");
      const uidSsn  = cookies.find((c: any) => c.name === "KP_UIDz-ssn");
      if (uid) {
        kpUidz    = uid.value;
        kpUidzSsn = uidSsn?.value ?? "";
        logger.info("[realtor] Kasada KP_UIDz cookie captured.");
        break;
      }
      await sleep(500);
    }

    if (!kpUidz) {
      logger.warn("[realtor] Kasada cookies not set within timeout.");
      await browser.close();
      return null;
    }

    // ── Wait for the page's own hulk XHR (extended, fast path) ───────────
    if (!capturedCt) {
      logger.info(`[realtor] Waiting up to ${CT_WAIT_MS / 1_000}s for page's own hulk XHR…`);
      const ctDeadline = Date.now() + CT_WAIT_MS;
      while (Date.now() < ctDeadline && !capturedCt) {
        await sleep(400);
      }
    }

    // ── In-page fetch fallback ─────────────────────────────────────────────
    //
    // If the page never fired a hulk XHR, trigger one from INSIDE the page
    // using page.evaluate().  This runs in the real browser context with the
    // full TLS/HTTP2 fingerprint, so Kasada returns x-kpsdk-ct.
    //
    // WHY NOT context.request.fetch():
    //   context.request.fetch() bypasses the browser's network stack — it has
    //   a different TLS JA3/JA4 fingerprint and HTTP/2 framing.  Kasada
    //   detects this and consistently returns 403 with ct=absent.
    //   page.evaluate() uses the browser's own fetch(), which passes.

    if (!capturedCt) {
      logger.info("[realtor] Page XHR absent — triggering hulk fetch from within page context…");

      try {
        // The response listener above will capture ct from this XHR.
        await page.evaluate(async (hulkUrl: string) => {
          try {
            await fetch(hulkUrl, {
              method:      "POST",
              headers:     { "content-type": "application/json" },
              body:        JSON.stringify({ query: "{ __typename }", variables: {} }),
              credentials: "include",
            });
          } catch { /* ignore network errors — we just need the response event */ }
        }, HULK_URL);

        // Give the response listener time to process the XHR
        logger.info("[realtor] In-page fetch fired — waiting up to 5s for ct…");
        const evalCtDeadline = Date.now() + 5_000;
        while (Date.now() < evalCtDeadline && !capturedCt) {
          await sleep(300);
        }

        if (capturedCt) {
          logger.info(
            `[realtor] ct captured from in-page fetch: ${capturedCt.slice(0, 20)}…`
          );
        } else {
          logger.warn(
            "[realtor] In-page fetch did not yield x-kpsdk-ct — " +
            "API calls will proceed without ct (expect 403)"
          );
        }
      } catch (e: any) {
        logger.warn(`[realtor] In-page fetch trigger failed: ${e.message}`);
      }
    }

    await browser.close();
    browser = null;

    const tokens: KasadaTokens = {
      kpUidz,
      kpUidzSsn,
      xKpsdkCt:  capturedCt,
      xKpsdkCd:  capturedCd || undefined,
      proxyUrl,
      solvedAt:  Date.now(),
    };

    logger.info(
      `[realtor] Kasada handshake complete | ` +
      `ct=${capturedCt ? "✓ " + capturedCt.slice(0, 20) + "…" : "absent"} | ` +
      `KP_UIDz=${kpUidz.slice(0, 16)}… | ` +
      `pinned proxy: ${proxyUrl ? maskProxyUrl(proxyUrl) : "none (direct)"}`
    );

    return tokens;

  } catch (err: any) {
    logger.error(`[realtor] Kasada handshake failed: ${err.message}`);
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    return null;
  }
}

// ── Token management ──────────────────────────────────────────────────────────

async function ensureTokens(searchUrl: string): Promise<void> {
  const expired =
    !kasadaTokens ||
    Date.now() - kasadaTokens.solvedAt > TOKEN_TTL_MS;

  if (!expired) return;

  const proxyUrl = getNextProxyUrl();
  logger.info("[realtor] Kasada tokens absent or expired — running handshake");
  kasadaTokens = await runKasadaHandshake(searchUrl, proxyUrl);
}

async function refreshTokens(searchUrl: string): Promise<void> {
  logger.warn("[realtor] Refreshing Kasada tokens…");
  // Always rotate to a fresh proxy on refresh — the previously pinned proxy
  // was just 403'd by Kasada and is likely flagged.
  const proxyUrl = getNextProxyUrl();
  kasadaTokens   = await runKasadaHandshake(searchUrl, proxyUrl);
}

// ── Kasada-enhanced request headers ──────────────────────────────────────────

function buildKasadaHeaders(): Record<string, string> {
  const t = kasadaTokens;
  if (!t) return {};

  const cookieParts = [`KP_UIDz=${t.kpUidz}`];
  if (t.kpUidzSsn) cookieParts.push(`KP_UIDz-ssn=${t.kpUidzSsn}`);

  const headers: Record<string, string> = {
    "cookie": cookieParts.join("; "),
  };

  if (t.xKpsdkCt) headers["x-kpsdk-ct"] = t.xKpsdkCt;
  if (t.xKpsdkCd) headers["x-kpsdk-cd"] = t.xKpsdkCd;

  return headers;
}

// ── URL → search params ───────────────────────────────────────────────────────

interface SearchParams {
  city:          string;
  stateCode:     string;
  priceMax?:     number;
  priceMin?:     number;
  propertyTypes: string[];
}

function parseSearchUrl(url: string): SearchParams {
  let u: URL;
  try { u = new URL(url); }
  catch { return { city: "Columbus", stateCode: "OH", propertyTypes: ["single_family"] }; }

  const pathMatch = u.pathname.match(/\/realestateandhomes-search\/([^/]+)/);
  const slug      = pathMatch?.[1] ?? "";
  const slugMatch = slug.match(/^(.+?)_([A-Z]{2})$/);
  const city      = slugMatch ? slugMatch[1].replace(/-/g, " ") : "Columbus";
  const stateCode = slugMatch ? slugMatch[2] : "OH";

  const priceMax  = u.searchParams.get("price_max");
  const priceMin  = u.searchParams.get("price_min");
  const typeParam = u.searchParams.get("type") ?? "";
  const propTypes = typeParam
    ? typeParam.split(",").map((t) => t.trim()).filter(Boolean)
    : ["single_family", "multi_family"];

  return {
    city,
    stateCode,
    priceMax:      priceMax  ? parseInt(priceMax,  10) : undefined,
    priceMin:      priceMin  ? parseInt(priceMin,  10) : undefined,
    propertyTypes: propTypes,
  };
}

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

// ── Browser-like base headers ─────────────────────────────────────────────────

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

// ── GraphQL query builders ────────────────────────────────────────────────────

function buildSearchQuery(params: SearchParams, offset: number): string {
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
        list_price: { max: effectivePriceMax },
        prop_type:  params.propertyTypes,
        status:     ["for_sale"],
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
  timeoutMs: number,
  proxyUrl:  string,
): Promise<{ status: number; body: string; respHeaders: Record<string, string> } | null> {
  let proxyHost: string;
  let proxyPort: number;
  let proxyAuth: string | null = null;

  try {
    const u   = new URL(proxyUrl);
    proxyHost = u.hostname;
    proxyPort = parseInt(u.port || "8080", 10);
    if (u.username && u.password) {
      proxyAuth = Buffer.from(
        `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`
      ).toString("base64");
    }
  } catch {
    logger.error(`[realtor] Invalid proxy URL: ${maskProxyUrl(proxyUrl)}`);
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

    const connectTimer = setTimeout(() => {
      connectReq.destroy();
      logger.warn(`[realtor] Proxy CONNECT timeout (${maskProxyUrl(proxyUrl)})`);
      resolve(null);
    }, PROXY_CONNECT_TIMEOUT_MS);

    connectReq.on("error", (err: any) => {
      clearTimeout(connectTimer);
      logger.error(`[realtor] Proxy CONNECT error (${maskProxyUrl(proxyUrl)}): ${err.message}`);
      resolve(null);
    });

    connectReq.on("connect", (res: any, socket: any) => {
      clearTimeout(connectTimer);

      if (res.statusCode !== 200) {
        logger.error(
          `[realtor] Proxy CONNECT rejected HTTP ${res.statusCode} (${maskProxyUrl(proxyUrl)})`
        );
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

      const dataTimer = setTimeout(() => {
        tlsSocket.destroy();
        logger.warn(`[realtor] Request timeout via proxy (${maskProxyUrl(proxyUrl)})`);
        resolve(null);
      }, timeoutMs);

      tlsSocket.on("error", (err: any) => {
        clearTimeout(dataTimer);
        logger.warn(`[realtor] TLS error via proxy: ${err.message}`);
        resolve(null);
      });

      tlsSocket.on("secureConnect", () => {
        const bodyBuf  = Buffer.from(body, "utf-8");
        const allHdrs  = {
          ...headers,
          "Content-Length": bodyBuf.length.toString(),
          "Connection":     "close",   // server closes after response → end event fires
        };
        const reqLines =
          `POST ${reqPath} HTTP/1.1\r\n` +
          `Host: ${hostname}\r\n` +
          Object.entries(allHdrs).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
          "\r\n\r\n";

        tlsSocket.write(reqLines);
        tlsSocket.write(bodyBuf);

        const chunks: Buffer[] = [];
        tlsSocket.on("data", (c: Buffer) => chunks.push(c));
        tlsSocket.on("end", () => {
          clearTimeout(dataTimer);
          try {
            const raw       = Buffer.concat(chunks).toString("binary");
            const headerEnd = raw.indexOf("\r\n\r\n");
            if (headerEnd === -1) { resolve(null); return; }

            const headerSection = raw.slice(0, headerEnd);
            const statusMatch   = headerSection.match(/^HTTP\/\d\.?\d? (\d+)/);
            const status        = statusMatch ? parseInt(statusMatch[1], 10) : 0;
            let   rawBodyStr    = raw.slice(headerEnd + 4);

            const respHeaders: Record<string, string> = {};
            for (const line of headerSection.split("\r\n").slice(1)) {
              const colon = line.indexOf(":");
              if (colon > 0) {
                respHeaders[line.slice(0, colon).toLowerCase().trim()] =
                  line.slice(colon + 1).trim();
              }
            }

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
                .then((buf) => resolve({ status, body: buf.toString("utf-8"), respHeaders }))
                .catch(() => resolve({ status, body: rawBodyStr, respHeaders }));
            } else {
              resolve({ status, body: rawBodyStr, respHeaders });
            }
          } catch (err: any) {
            logger.warn(`[realtor] Response parse error: ${err.message}`);
            resolve(null);
          }
        });
        tlsSocket.on("error", () => { clearTimeout(dataTimer); resolve(null); });
      });
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
  timeoutMs: number,
): Promise<{ status: number; body: string; respHeaders: Record<string, string> } | null> {
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

        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") respHeaders[k] = v;
          else if (Array.isArray(v)) respHeaders[k] = v.join(", ");
        }

        stream.on("data",  (c: Buffer) => chunks.push(c));
        stream.on("end",   () =>
          resolve({
            status:      res.statusCode ?? 0,
            body:        Buffer.concat(chunks).toString("utf-8"),
            respHeaders,
          })
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
  timeoutMs: number = REQUEST_TIMEOUT_MS,
): Promise<{ status: number; body: string; respHeaders: Record<string, string> } | null> {

  // Pin to the proxy that solved the current Kasada challenge.
  // Fall back to the rotator only when there are no active tokens.
  const proxyUrl = kasadaTokens?.proxyUrl ?? getNextProxyUrl();

  if (proxyUrl) {
    logger.debug(`[realtor] Using proxy: ${maskProxyUrl(proxyUrl)}`);
    const result = await httpsPostViaProxy(hostname, reqPath, headers, body, timeoutMs, proxyUrl);
    if (result) return result;

    if (kasadaTokens) {
      logger.warn(
        `[realtor] Pinned proxy failed and tokens are IP-bound — ` +
        `not falling back to direct (would cause 403)`
      );
      return null;
    }

    logger.warn(`[realtor] Proxy failed (no active tokens) — falling back to direct`);
  }

  logger.debug("[realtor] Direct connection");
  return httpsPostDirect(hostname, reqPath, headers, body, timeoutMs);
}

// ── GraphQL API call (Kasada-aware) ──────────────────────────────────────────
//
// 403 handling: Kasada almost always returns x-kpsdk-ct in the 403 response.
// We capture it (already done in the respHeaders block above), update the
// token store, and retry the request ONCE before triggering a full handshake
// refresh. This avoids the expensive browser round-trip in the common case
// where ct was simply absent or just expired.

let consecutive429s = 0;

async function graphqlPost(
  body:       string,
  searchUrl:  string,
  is403Retry: boolean = false,
): Promise<any | null> {
  const kasadaHdrs = buildKasadaHeaders();
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    ...kasadaHdrs,
    "Content-Length": Buffer.byteLength(body).toString(),
  };

  const result = await httpsPost(REALTOR_HOST, HULK_PATH, headers, body);

  if (!result) return null;

  const { status, body: rawBody, respHeaders } = result;

  // Always capture rotated tokens from response headers
  if (kasadaTokens && respHeaders["x-kpsdk-ct"]) {
    kasadaTokens.xKpsdkCt = respHeaders["x-kpsdk-ct"];
    logger.debug("[realtor] x-kpsdk-ct updated from response headers");
  }
  if (kasadaTokens && respHeaders["x-kpsdk-cd"]) {
    kasadaTokens.xKpsdkCd = respHeaders["x-kpsdk-cd"];
  }

  if (status === 429) {
    consecutive429s++;
    logger.warn(
      `[realtor] API 429 (consecutive: ${consecutive429s}) — ` +
      (consecutive429s >= MAX_429_BEFORE_REFRESH
        ? "triggering Kasada refresh"
        : "will retry next call")
    );
    if (consecutive429s >= MAX_429_BEFORE_REFRESH) {
      await refreshTokens(searchUrl);
      consecutive429s = 0;
    }
    return null;
  }

  if (status === 403) {
    if (!is403Retry && kasadaTokens?.xKpsdkCt) {
      // We just captured a fresh ct from the 403 response — retry once with it
      // before falling back to a full handshake refresh.
      logger.warn(
        `[realtor] API 403 — retrying once with fresh ct ` +
        `(${kasadaTokens.xKpsdkCt.slice(0, 20)}…)`
      );
      return graphqlPost(body, searchUrl, /* is403Retry */ true);
    }

    logger.warn("[realtor] API 403 — Kasada fully blocked. Running handshake refresh…");
    await refreshTokens(searchUrl);
    consecutive429s = 0;
    return null;
  }

  if (status !== 200) {
    logger.warn(`[realtor] API HTTP ${status}: ${rawBody.slice(0, 200)}`);
    return null;
  }

  consecutive429s = 0;

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

// ── Proxy summary for startup log ─────────────────────────────────────────────

function resolveProxySummary(): string {
  try {
    const rotator = getProxyRotator();
    const count   = rotator.getProxyCount();
    if (count > 0) return `rotator (${count} proxies)`;
  } catch { /* not initialised */ }
  if (LEGACY_PROXY_URL) return `legacy single proxy (${maskProxyUrl(LEGACY_PROXY_URL)})`;
  return "none (direct connection)";
}

// ── Estimate fetcher ──────────────────────────────────────────────────────────

async function attachEstimates(
  listings:  RawListing[],
  searchUrl: string,
): Promise<void> {
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
        const data = await graphqlPost(body, searchUrl);
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

  logger.info(`[realtor] Estimates: ${hit} found, ${miss} missing / ${listings.length}`);
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
      `[realtor] Transport: Playwright handshake → direct GraphQL (${REALTOR_HOST}${HULK_PATH}) | ` +
      `proxy: ${resolveProxySummary()} | ` +
      `timeout: ${REQUEST_TIMEOUT_MS / 1_000}s | ` +
      `connect timeout: ${PROXY_CONNECT_TIMEOUT_MS / 1_000}s | ` +
      `handshake timeout: ${HANDSHAKE_TIMEOUT_MS / 1_000}s | ` +
      `fetchEstimates: ${FETCH_ESTIMATES} | ` +
      `headless: ${HEADLESS}`
    );
  }

  override async run(): Promise<RawListing[]> {
    logger.info("[realtor] Starting");
    this.visited.clear();
    this.results     = [];
    this.allListings = [];
    consecutive429s  = 0;
    kasadaTokens     = null;

    const searchUrls = getSearchUrls();
    const rejected: Array<{ listing: RawListing; reason: string }> = [];

    await ensureTokens(searchUrls[0]);

    if (!kasadaTokens) {
      logger.warn(
        "[realtor] Kasada handshake failed — will attempt API calls anyway " +
        "(expect 429/403 responses)"
      );
    }

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

        await ensureTokens(baseUrl);

        const offset = (page - 1) * RESULTS_PER_PAGE;
        logger.info(
          `[realtor] ${params.city}, ${params.stateCode} ` +
          `page ${page}/${this.options.maxPages} (offset ${offset})`
        );

        const body = buildSearchQuery(params, offset);
        const data = await graphqlPost(body, baseUrl);

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

        await attachEstimates(listings, baseUrl);

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