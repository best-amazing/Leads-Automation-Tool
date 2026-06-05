// src/scrapers/realtor/realtor.address-enricher.ts
//
// Stand-alone address → Realtor.com AVM lookup.
// No Playwright/browser required for the API calls themselves.
//
// ── API flow ──────────────────────────────────────────────────────────────────
//
//   Step 1 — Address search (autocomplete)
//     GET https://www.realtor.com/api/v1/hulk_lookup/autocomplete
//         ?input={address}&client_id=rdc-x&schema=homes
//     Returns: { data: [ { property_id, mpr_id, permalink, full_address } ] }
//
//   Step 2 — Property detail via /frontdoor/graphql
//     POST https://www.realtor.com/frontdoor/graphql
//     Body: HomeDetailsQuery (GraphQL) with permalink / property_id
//     Returns: { data: { home: { ... } } }
//
// ── Auth ──────────────────────────────────────────────────────────────────────
//
//   Realtor.com uses Kasada bot protection. The KP_UIDz cookies are sufficient
//   for /frontdoor/graphql (200 OK confirmed). The autocomplete endpoint needs
//   the full browser cookie string to avoid 403.
//
//   Set in .env:
//     REALTOR_KP_UIDZ         — KP_UIDz cookie value
//     REALTOR_KP_UIDZ_SSN     — KP_UIDz-ssn cookie value
//     REALTOR_SESSION_COOKIE  — full cookie string from DevTools (Network → Request Headers → cookie)
//     REALTOR_KPSDK_CT        — x-kpsdk-ct header (optional, not enforced on confirmed endpoints)
//     REALTOR_USE_PLAYWRIGHT  — set "true" to auto-solve Kasada via headless browser
//     PROXY_URL               — residential proxy (http://user:pass@host:port)
//     REALTOR_ENRICHER_DEBUG  — set "true" to save raw responses to logs/
//     REALTOR_HANDSHAKE_TIMEOUT — ms timeout for Playwright handshake (default 60000)

import * as https from "https";
import * as http from "http";
import * as tls from "tls";
import * as zlib from "zlib";
import * as fs from "fs";
import * as path from "path";

import { logger } from "../../utils/logger";
import { sleep } from "../../utils/browser";
import {
  getProxyRotator,
  initializeProxyRotator,
} from "../../utils/proxy-rotator";

// ── Config ────────────────────────────────────────────────────────────────────

const DEBUG_SAVE = process.env.REALTOR_ENRICHER_DEBUG === "true";
const USE_PLAYWRIGHT = process.env.REALTOR_USE_PLAYWRIGHT === "true";
const HANDSHAKE_TIMEOUT_MS = Number(
  process.env.REALTOR_HANDSHAKE_TIMEOUT ?? 60_000,
);
const TIMEOUT_MS = 30_000;
const BETWEEN_MS = 1_200;
const PROXY_CONNECT_TIMEOUT_MS = 10_000;

const REALTOR_HOST = "www.realtor.com";
const AUTOCOMPLETE_PATH = "/api/v1/hulk_lookup/autocomplete";
const GRAPHQL_PATH = "/frontdoor/graphql";

// Full session cookie string from REALTOR_SESSION_COOKIE env var.
// This is needed for the autocomplete endpoint to pass Kasada.
const SESSION_COOKIE_STRING = process.env.REALTOR_SESSION_COOKIE ?? "";

// ── Proxy helpers ─────────────────────────────────────────────────────────────

function getNextProxyUrl(): string | null {
  try {
    const rotator = getProxyRotator();
    if (rotator.getProxyCount() > 0) {
      const proxy = rotator.getNextProxy();
      if (proxy) return proxy;
    }
  } catch (e: any) {
    logger.debug(`[realtor-enricher] Proxy rotator error: ${e.message}`);
  }
  return process.env.PROXY_URL ?? null;
}

// ── Kasada token store ────────────────────────────────────────────────────────

interface KasadaTokens {
  kpUidz: string;
  kpUidzSsn: string;
  xKpsdkCt: string;
  solvedAt: number;
}

const ENV_TOKENS: KasadaTokens | null = process.env.REALTOR_KP_UIDZ
  ? {
      kpUidz: process.env.REALTOR_KP_UIDZ ?? "",
      kpUidzSsn: process.env.REALTOR_KP_UIDZ_SSN ?? "",
      xKpsdkCt: process.env.REALTOR_KPSDK_CT ?? "",
      solvedAt: Date.now(),
    }
  : null;

let liveTokens: KasadaTokens | null = ENV_TOKENS;
const TOKEN_TTL_MS = 12 * 60 * 1_000; // 12 min (Kasada TTL ~15 min)

// ── Public types ──────────────────────────────────────────────────────────────

export interface RealtorEstimate {
  propertyId: string | null;
  url: string | null;
  listPrice: number | null;
  estimate: number | null;
  estimateLow: number | null;
  estimateHigh: number | null;
  address: string;
  rawInput: string;
  bedrooms: number | null;
  bathrooms: number | null;
  squareFeet: number | null;
  lotSqft: number | null;
  yearBuilt: number | null;
  propertyType: string | null;
  daysOnMarket: number | null;
  status: string | null;
  agentName: string | null;
  agentPhone: string | null;
  found: boolean;
  strategy?: string;
  error?: string;
}

// ── Playwright Kasada handshake ───────────────────────────────────────────────

async function runKasadaHandshake(): Promise<KasadaTokens | null> {
  let chromium: any;
  try {
    const pw = await import("playwright");
    chromium = pw.chromium;
  } catch {
    logger.error(
      "[realtor-enricher] playwright not installed. Run: npm install playwright && npx playwright install chromium",
    );
    return null;
  }

  logger.info("[realtor-enricher] Starting Kasada handshake via Playwright…");

  const launchOptions: any = {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
    ],
  };

  const proxyUrl = getNextProxyUrl();
  if (proxyUrl) {
    try {
      const u = new URL(proxyUrl);
      launchOptions.proxy = {
        server: `${u.protocol}//${u.host}`,
        username: decodeURIComponent(u.username),
        password: decodeURIComponent(u.password),
      };
      logger.info(
        `[realtor-enricher] Handshake proxy: ${proxyUrl.replace(/:[^:/@]+@/, ":***@")}`,
      );
    } catch {}
  }

  let browser: any = null;
  try {
    browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      locale: "en-US",
      viewport: { width: 1280, height: 800 },
    });

    await context.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      (window as any).chrome = { runtime: {} };
    });

    const page = await context.newPage();

    let capturedCt = "";
    page.on("response", async (response: any) => {
      try {
        const ct = response.headers()["x-kpsdk-ct"] ?? "";
        if (ct) capturedCt = ct;
      } catch {}
    });

    logger.info("[realtor-enricher] Browser navigating to realtor.com…");
    await page.goto("https://www.realtor.com/", {
      waitUntil: "domcontentloaded",
      timeout: HANDSHAKE_TIMEOUT_MS,
    });

    const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
    let kpUidz = "",
      kpUidzSsn = "";

    while (Date.now() < deadline) {
      const cookies = await context.cookies("https://www.realtor.com");
      const uid = cookies.find((c: any) => c.name === "KP_UIDz");
      const uidSsn = cookies.find((c: any) => c.name === "KP_UIDz-ssn");
      if (uid) {
        kpUidz = uid.value;
        kpUidzSsn = uidSsn?.value ?? "";
        break;
      }
      await sleep(500);
    }

    if (!capturedCt) {
      const ctDeadline = Date.now() + 8_000;
      while (Date.now() < ctDeadline && !capturedCt) await sleep(400);
    }

    await browser.close();
    browser = null;

    if (!kpUidz) {
      logger.warn("[realtor-enricher] Kasada cookies not set within timeout");
      return null;
    }

    logger.info(
      `[realtor-enricher] Kasada handshake complete | ct=${capturedCt ? "✓" : "absent"}`,
    );
    return { kpUidz, kpUidzSsn, xKpsdkCt: capturedCt, solvedAt: Date.now() };
  } catch (err: any) {
    logger.error(`[realtor-enricher] Kasada handshake failed: ${err.message}`);
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }
    return null;
  }
}

async function ensureTokens(): Promise<void> {
  if (ENV_TOKENS) return;
  const expired =
    !liveTokens || Date.now() - liveTokens.solvedAt > TOKEN_TTL_MS;
  if (!expired) return;

  if (!USE_PLAYWRIGHT) {
    logger.warn(
      "[realtor-enricher] No Kasada tokens set. " +
        "Set REALTOR_KP_UIDZ / REALTOR_KP_UIDZ_SSN in .env " +
        "(copy from browser DevTools → Application → Cookies), " +
        "or set REALTOR_USE_PLAYWRIGHT=true.",
    );
    return;
  }

  liveTokens = await runKasadaHandshake();
}

// ── Cookie builder ────────────────────────────────────────────────────────────
//
// Priority:
//   1. REALTOR_SESSION_COOKIE (full string from DevTools) — most complete
//   2. Fallback: construct minimal cookie from KP_UIDz env vars only
//
// The full session cookie is required for /hulk_lookup/autocomplete.
// /frontdoor/graphql only needs KP_UIDz but sending the full string is fine.

function buildCookieHeader(): string {
  // Use full session cookie string if available
  if (SESSION_COOKIE_STRING) {
    // If live tokens came from Playwright, patch KP_UIDz into the session string
    if (liveTokens?.kpUidz && !ENV_TOKENS) {
      let cookie = SESSION_COOKIE_STRING;
      cookie = cookie.replace(
        /KP_UIDz-ssn=[^;]+/,
        `KP_UIDz-ssn=${liveTokens.kpUidzSsn}`,
      );
      cookie = cookie.replace(/KP_UIDz=[^;]+/, `KP_UIDz=${liveTokens.kpUidz}`);
      return cookie;
    }
    return SESSION_COOKIE_STRING;
  }

  // Fallback: minimal cookie from individual env vars
  const t = liveTokens;
  if (!t?.kpUidz) return "";
  const parts = [`KP_UIDz=${t.kpUidz}`];
  if (t.kpUidzSsn) parts.push(`KP_UIDz-ssn=${t.kpUidzSsn}`);
  return parts.join("; ");
}

function buildAuthHeaders(): Record<string, string> {
  const cookie = buildCookieHeader();
  const h: Record<string, string> = {};
  if (cookie) h["cookie"] = cookie;
  // x-kpsdk-ct is optional — include if available (not enforced on confirmed endpoints)
  const ct = liveTokens?.xKpsdkCt ?? process.env.REALTOR_KPSDK_CT ?? "";
  if (ct) h["x-kpsdk-ct"] = ct;
  return h;
}

// ── Browser-like base headers ─────────────────────────────────────────────────

function buildHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  return {
    accept: "application/json, text/plain, */*",
    "accept-encoding": "gzip, deflate, br",
    "accept-language": "en-US,en;q=0.9",
    "content-type": "application/json",
    origin: "https://www.realtor.com",
    referer: "https://www.realtor.com/",
    "user-agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "sec-ch-ua":
      '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "rdc-client-name": "RDC_WEB_DETAILS_PAGE",
    "rdc-client-version": "2.858.0",
    ...buildAuthHeaders(), // ← full session cookie + optional x-kpsdk-ct
    ...extra,
  };
}

// ── Debug helpers ─────────────────────────────────────────────────────────────

function debugSave(filename: string, content: string): void {
  if (!DEBUG_SAVE) return;
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, "utf-8");
  } catch {}
}

function slugify(s: string): string {
  return s
    .replace(/[^a-z0-9]+/gi, "_")
    .slice(0, 60)
    .toLowerCase();
}

// ── Decompression ─────────────────────────────────────────────────────────────

async function decompress(buf: Buffer, enc: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const e = enc.toLowerCase().trim();
    if (e === "gzip" || e === "x-gzip")
      zlib.gunzip(buf, (er, r) => (er ? reject(er) : resolve(r)));
    else if (e === "deflate")
      zlib.inflate(buf, (er, r) => {
        if (er)
          zlib.inflateRaw(buf, (e2, r2) => (e2 ? reject(e2) : resolve(r2)));
        else resolve(r);
      });
    else if (e === "br")
      zlib.brotliDecompress(buf, (er, r) => (er ? reject(er) : resolve(r)));
    else resolve(buf);
  });
}

// ── Transport ─────────────────────────────────────────────────────────────────

interface HttpResult {
  status: number;
  body: string;
  respHeaders: Record<string, string>;
}

function decodeChunked(raw: string): string {
  let result = "",
    rem = raw;
  while (rem.length > 0) {
    const crlf = rem.indexOf("\r\n");
    if (crlf === -1) break;
    const sz = parseInt(rem.slice(0, crlf), 16);
    if (isNaN(sz) || sz === 0) break;
    result += rem.slice(crlf + 2, crlf + 2 + sz);
    rem = rem.slice(crlf + 2 + sz + 2);
  }
  return result;
}

async function finaliseProxy(rawBinary: string): Promise<HttpResult | null> {
  try {
    const headerEnd = rawBinary.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    const headerSection = rawBinary.slice(0, headerEnd);
    const statusMatch = headerSection.match(/^HTTP\/\d\.?\d? (\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
    let decoded = rawBinary.slice(headerEnd + 4);
    if (/transfer-encoding:\s*chunked/i.test(headerSection))
      decoded = decodeChunked(decoded);
    const respHeaders: Record<string, string> = {};
    for (const line of headerSection.split("\r\n").slice(1)) {
      const c = line.indexOf(":");
      if (c > 0)
        respHeaders[line.slice(0, c).toLowerCase().trim()] = line
          .slice(c + 1)
          .trim();
    }
    const encMatch = headerSection.match(/content-encoding:\s*(\S+)/i);
    const enc = encMatch?.[1]?.trim() ?? "";
    if (enc === "gzip" || enc === "br" || enc === "deflate") {
      const buf = await decompress(Buffer.from(decoded, "binary"), enc);
      return { status, body: buf.toString("utf-8"), respHeaders };
    }
    return { status, body: decoded, respHeaders };
  } catch {
    return null;
  }
}

async function request(
  method: "GET" | "POST",
  hostname: string,
  reqPath: string,
  headers: Record<string, string>,
  body?: string,
): Promise<HttpResult | null> {
  // ── Via proxy ──────────────────────────────────────────────────────────────
  const proxyUrl = getNextProxyUrl();
  if (proxyUrl) {
    // Log the proxy being used (mask the auth credentials)
    const maskedProxy = proxyUrl.replace(
      /^(https?:\/\/)([^:]+):([^@]+)@/,
      "$1***:***@",
    );
    logger.info(`[realtor-enricher]       🔗 Proxy: ${maskedProxy}`);

    return new Promise((resolve) => {
      let proxyHost: string,
        proxyPort: number,
        proxyAuth: string | null = null;
      try {
        const u = new URL(proxyUrl);
        proxyHost = u.hostname;
        proxyPort = parseInt(u.port || "8080", 10);
        if (u.username && u.password)
          proxyAuth = Buffer.from(
            `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
          ).toString("base64");
      } catch {
        resolve(null);
        return;
      }

      const cHdrs: Record<string, string> = {
        Host: `${hostname}:443`,
        "User-Agent": "Mozilla/5.0",
      };
      if (proxyAuth) cHdrs["Proxy-Authorization"] = `Basic ${proxyAuth}`;

      const connectReq = http.request({
        host: proxyHost,
        port: proxyPort,
        method: "CONNECT",
        path: `${hostname}:443`,
        headers: cHdrs,
      });
      const timer = setTimeout(() => {
        connectReq.destroy();
        resolve(null);
      }, TIMEOUT_MS);

      connectReq.on("error", () => {
        clearTimeout(timer);
        resolve(null);
      });
      connectReq.on("connect", (res: any, socket: any) => {
        if (res.statusCode !== 200) {
          clearTimeout(timer);
          socket.destroy();
          resolve(null);
          return;
        }

        const tlsSocket = tls.connect({
          host: hostname,
          socket,
          servername: hostname,
          rejectUnauthorized: true,
        });
        tlsSocket.on("error", () => {
          clearTimeout(timer);
          resolve(null);
        });
        tlsSocket.on("secureConnect", () => {
          const bodyBuf = body ? Buffer.from(body, "utf-8") : Buffer.alloc(0);
          const allHdrs = body
            ? { ...headers, "Content-Length": bodyBuf.length.toString() }
            : headers;
          const reqLines =
            `${method} ${reqPath} HTTP/1.1\r\nHost: ${hostname}\r\n` +
            Object.entries(allHdrs)
              .map(([k, v]) => `${k}: ${v}`)
              .join("\r\n") +
            "\r\n\r\n";
          tlsSocket.write(reqLines);
          if (bodyBuf.length) tlsSocket.write(bodyBuf);
          const chunks: Buffer[] = [];
          tlsSocket.on("data", (c: Buffer) => chunks.push(c));
          tlsSocket.on("end", async () => {
            clearTimeout(timer);
            resolve(
              await finaliseProxy(Buffer.concat(chunks).toString("binary")),
            );
          });
          tlsSocket.on("error", () => {
            clearTimeout(timer);
            resolve(null);
          });
        });
      });
      connectReq.end();
    });
  }

  // ── Direct ─────────────────────────────────────────────────────────────────
  return new Promise((resolve) => {
    const allHdrs = body
      ? { ...headers, "Content-Length": Buffer.byteLength(body).toString() }
      : headers;
    const req = https.request(
      { hostname, path: reqPath, method, family: 4, headers: allHdrs },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        const enc = (res.headers["content-encoding"] ?? "").trim();
        const stream: NodeJS.ReadableStream =
          enc === "gzip"
            ? res.pipe(zlib.createGunzip())
            : enc === "deflate"
              ? res.pipe(zlib.createInflate())
              : enc === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : (res as any);

        const respHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === "string") respHeaders[k] = v;
          else if (Array.isArray(v)) respHeaders[k] = v.join(", ");
        }

        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
            respHeaders,
          }),
        );
        stream.on("error", () => resolve(null));
      },
    );
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    if (body) req.write(body);
    req.end();
  });
}

function checkStatus(
  status: number,
  label: string,
  respHeaders: Record<string, string>,
): "ok" | "auth" | "rate_limited" | "error" {
  // Capture refreshed ct token from response headers if present
  if (liveTokens && respHeaders["x-kpsdk-ct"]) {
    liveTokens.xKpsdkCt = respHeaders["x-kpsdk-ct"];
  }
  if (status === 200) return "ok";
  if (status === 401 || status === 403) {
    logger.warn(
      `[realtor-enricher]   ${label}: HTTP ${status} — Kasada blocked / token expired`,
    );
    return "auth";
  }
  if (status === 429) {
    logger.warn(`[realtor-enricher]   ${label}: 429 — rate limited`);
    return "rate_limited";
  }
  logger.warn(`[realtor-enricher]   ${label}: HTTP ${status}`);
  return "error";
}

// ── Step 1: Autocomplete search ───────────────────────────────────────────────

interface AutocompleteMatch {
  propertyId: string;
  permalink: string;
  address: string;
}

async function autocompleteSearch(
  rawAddress: string,
): Promise<AutocompleteMatch | null> {
  const qs = new URLSearchParams({
    input: rawAddress,
    client_id: "rdc-x",
    schema: "homes",
  });
  const reqPath = `${AUTOCOMPLETE_PATH}?${qs.toString()}`;

  logger.info(
    `[realtor-enricher]   → GET ${AUTOCOMPLETE_PATH}?input="${rawAddress}"`,
  );
  const result = await request("GET", REALTOR_HOST, reqPath, buildHeaders());
  if (!result) {
    logger.warn("[realtor-enricher]   autocomplete: network failure");
    return null;
  }

  logger.info(
    `[realtor-enricher]   autocomplete: HTTP ${result.status}  body=${result.body.length}ch`,
  );
  logger.debug(`[realtor-enricher]   Preview: ${result.body.slice(0, 300)}`);
  debugSave(`realtor_autocomplete_${slugify(rawAddress)}.json`, result.body);

  const outcome = checkStatus(
    result.status,
    "autocomplete",
    result.respHeaders,
  );
  if (outcome === "auth") {
    liveTokens = null;
    return null;
  }
  if (outcome !== "ok") return null;

  try {
    const json = JSON.parse(result.body);
    const entries = json?.data ?? [];
    if (!entries.length) {
      logger.warn("[realtor-enricher]   autocomplete: no results");
      return null;
    }

    const addressEntry =
      entries.find(
        (e: any) =>
          (e.type === "address" || e.type === "property" || e.permalink) &&
          e.property_id,
      ) ?? entries[0];

    if (!addressEntry) {
      logger.warn("[realtor-enricher]   autocomplete: no usable entry");
      return null;
    }

    logger.info(
      `[realtor-enricher]   autocomplete: matched "${addressEntry.full_address ?? addressEntry.line}" ` +
        `(id=${addressEntry.property_id ?? addressEntry.mpr_id})`,
    );
    return {
      propertyId: String(addressEntry.property_id ?? addressEntry.mpr_id ?? ""),
      permalink: addressEntry.permalink ?? "",
      address: addressEntry.full_address ?? addressEntry.line ?? rawAddress,
    };
  } catch {
    logger.warn("[realtor-enricher]   autocomplete: JSON parse failed");
    return null;
  }
}

// ── Step 2: Property detail via /frontdoor/graphql ────────────────────────────

const HOME_DETAILS_QUERY = `
  query HomeDetailsQuery($propertyId: ID!) {
    home(property_id: $propertyId) {
      property_id
      permalink
      list_price
      list_date
      status
      last_sold_price
      last_sold_date
      price_per_sqft
      description {
        beds
        baths_full
        baths_half
        baths_consolidated
        sqft
        lot_sqft
        year_built
        type
        text
        stories
        garage
      }
      estimates {
        current_values {
          estimate
          isbest_homevalue
        }
      }
      location {
        address {
          line
          city
          state_code
          postal_code
          coordinate { lat lon }
        }
      }
      advertisers {
        name
        email
        phones { number type primary }
        office { name }
        type
      }
      source {
        days_on_mls
        raw { status }
      }
      flags {
        is_price_reduced
        is_new_listing
        is_foreclosure
        is_pending
      }
      hoa { fee }
    }
  }
`;

interface PropertyDetail {
  propertyId: string;
  url: string;
  listPrice: number | null;
  estimate: number | null;
  estimateLow: number | null;
  estimateHigh: number | null;
  address: string;
  beds: number | null;
  baths: number | null;
  sqft: number | null;
  lotSqft: number | null;
  yearBuilt: number | null;
  propType: string | null;
  dom: number | null;
  status: string | null;
  agentName: string | null;
  agentPhone: string | null;
}

function mapPropertyType(raw: string | undefined): string | null {
  if (!raw) return null;
  const t = raw.toLowerCase();
  if (t.includes("single") || t === "single_family") return "single_family";
  if (t.includes("multi")) return "multi_family";
  if (t.includes("duplex")) return "duplex";
  if (t.includes("condo")) return "condo";
  if (t.includes("town")) return "townhouse";
  return raw;
}

async function fetchPropertyDetail(
  propertyId: string,
  permalink: string,
): Promise<PropertyDetail | null> {
  const body = JSON.stringify({
    query: HOME_DETAILS_QUERY,
    variables: { propertyId },
  });

  logger.info(
    `[realtor-enricher]   → POST ${GRAPHQL_PATH}  propertyId=${propertyId}`,
  );
  const result = await request(
    "POST",
    REALTOR_HOST,
    GRAPHQL_PATH,
    buildHeaders({ "x-is-bot": "false" }),
    body,
  );
  if (!result) {
    logger.warn("[realtor-enricher]   graphql: network failure");
    return null;
  }

  logger.info(
    `[realtor-enricher]   graphql: HTTP ${result.status}  body=${result.body.length}ch`,
  );
  logger.debug(`[realtor-enricher]   Preview: ${result.body.slice(0, 400)}`);
  debugSave(`realtor_detail_${slugify(propertyId)}.json`, result.body);

  const outcome = checkStatus(result.status, "graphql", result.respHeaders);
  if (outcome === "auth") {
    liveTokens = null;
    return null;
  }
  if (outcome !== "ok") return null;

  try {
    const json = JSON.parse(result.body);
    const home = json?.data?.home;
    if (!home) {
      logger.warn("[realtor-enricher]   graphql: no home in response");
      return null;
    }

    const estimates: any[] = home.estimates?.current_values ?? [];
    const bestEst =
      estimates.find((e: any) => e.isbest_homevalue)?.estimate ?? null;
    const allEsts = estimates
      .map((e: any) => e.estimate)
      .filter((v: any) => typeof v === "number")
      .sort((a: number, b: number) => a - b);
    const estLow = allEsts[0] ?? null;
    const estHigh = allEsts[allEsts.length - 1] ?? null;

    const addr = home.location?.address ?? {};
    const address = [addr.line, addr.city, addr.state_code, addr.postal_code]
      .filter(Boolean)
      .join(", ");

    const sellers = (home.advertisers ?? []).filter(
      (a: any) => a.type === "seller",
    );
    const agent = sellers[0] ?? home.advertisers?.[0] ?? null;
    const agentName = agent?.name ?? null;
    const agentPhone =
      agent?.phones?.find((p: any) => p.primary)?.number ??
      agent?.phones?.[0]?.number ??
      null;

    const desc = home.description ?? {};

    return {
      propertyId,
      url: `https://www.realtor.com/realestateandhomes-detail/${permalink || propertyId}`,
      listPrice: typeof home.list_price === "number" ? home.list_price : null,
      estimate: typeof bestEst === "number" ? bestEst : null,
      estimateLow:
        typeof estLow === "number" && estLow !== bestEst ? estLow : null,
      estimateHigh:
        typeof estHigh === "number" && estHigh !== bestEst ? estHigh : null,
      address,
      beds: typeof desc.beds === "number" ? desc.beds : null,
      baths:
        typeof desc.baths_consolidated !== "undefined"
          ? parseFloat(String(desc.baths_consolidated)) || null
          : typeof desc.baths_full === "number"
            ? desc.baths_full
            : null,
      sqft: typeof desc.sqft === "number" ? desc.sqft : null,
      lotSqft: typeof desc.lot_sqft === "number" ? desc.lot_sqft : null,
      yearBuilt: typeof desc.year_built === "number" ? desc.year_built : null,
      propType: mapPropertyType(desc.type),
      dom:
        typeof home.source?.days_on_mls === "number"
          ? home.source.days_on_mls
          : null,
      status: home.status ?? home.source?.raw?.status ?? null,
      agentName,
      agentPhone,
    };
  } catch (err: any) {
    logger.warn(
      `[realtor-enricher]   graphql: JSON parse failed — ${err.message}`,
    );
    return null;
  }
}

// ── Main enricher class ───────────────────────────────────────────────────────

export class RealtorAddressEnricher {
  constructor() {
    // Initialize proxy rotator with configured proxies
    try {
      const proxyUrls = process.env.PROXY_URLS
        ? process.env.PROXY_URLS.split(",").map((p) => p.trim())
        : [];

      const proxyUrl = process.env.PROXY_URL;

      if (proxyUrls.length > 0) {
        initializeProxyRotator(proxyUrls);
        logger.info(
          `[realtor-enricher] Proxy rotator initialized with ${proxyUrls.length} proxy(ies) from PROXY_URLS`,
        );
      } else if (proxyUrl) {
        initializeProxyRotator([proxyUrl]);
        logger.info(
          `[realtor-enricher] Proxy rotator initialized with 1 proxy from PROXY_URL`,
        );
      } else {
        initializeProxyRotator([]);
        logger.info(
          `[realtor-enricher] Proxy rotator initialized with no proxies`,
        );
      }
    } catch (e: any) {
      logger.warn(`[realtor-enricher] Proxy rotator init failed: ${e.message}`);
    }
  }

  async lookup(rawAddress: string): Promise<RealtorEstimate> {
    logger.info(
      `\n[realtor-enricher] ═══════════════════════════════════════════════`,
    );
    logger.info(`[realtor-enricher] 📍 "${rawAddress}"`);

    const base: RealtorEstimate = {
      propertyId: null,
      url: null,
      listPrice: null,
      estimate: null,
      estimateLow: null,
      estimateHigh: null,
      address: rawAddress,
      rawInput: rawAddress,
      bedrooms: null,
      bathrooms: null,
      squareFeet: null,
      lotSqft: null,
      yearBuilt: null,
      propertyType: null,
      daysOnMarket: null,
      status: null,
      agentName: null,
      agentPhone: null,
      found: false,
    };

    await ensureTokens();

    if (!liveTokens?.kpUidz && !SESSION_COOKIE_STRING) {
      logger.warn(
        "[realtor-enricher] No auth tokens or session cookie set — API will return 403",
      );
    }

    // ── Step 1: Autocomplete ──────────────────────────────────────────────────
    logger.info(`[realtor-enricher]   ── Step 1: autocomplete search`);
    const match = await autocompleteSearch(rawAddress);
    if (!match) {
      logger.warn(
        `[realtor-enricher] ✗ "${rawAddress}" — no autocomplete match`,
      );
      return { ...base, error: "address_not_found" };
    }

    await sleep(BETWEEN_MS + Math.random() * 400);

    // ── Step 2: Property detail ───────────────────────────────────────────────
    logger.info(
      `[realtor-enricher]   ── Step 2: property detail via /frontdoor/graphql`,
    );
    const detail = await fetchPropertyDetail(match.propertyId, match.permalink);

    if (!detail) {
      logger.warn(
        `[realtor-enricher] ✗ "${rawAddress}" — graphql detail failed`,
      );
      return {
        ...base,
        propertyId: match.propertyId,
        url: `https://www.realtor.com/realestateandhomes-detail/${match.permalink || match.propertyId}`,
        address: match.address,
        error: "detail_fetch_failed",
      };
    }

    const result: RealtorEstimate = {
      propertyId: detail.propertyId,
      url: detail.url,
      listPrice: detail.listPrice,
      estimate: detail.estimate,
      estimateLow: detail.estimateLow,
      estimateHigh: detail.estimateHigh,
      address: detail.address || match.address || rawAddress,
      rawInput: rawAddress,
      bedrooms: detail.beds,
      bathrooms: detail.baths,
      squareFeet: detail.sqft,
      lotSqft: detail.lotSqft,
      yearBuilt: detail.yearBuilt,
      propertyType: detail.propType,
      daysOnMarket: detail.dom,
      status: detail.status,
      agentName: detail.agentName,
      agentPhone: detail.agentPhone,
      found: true,
      strategy: "autocomplete+frontdoor/graphql",
    };

    logger.info(
      `[realtor-enricher] ✓ found | ` +
        `${detail.beds ?? "?"}bd/${detail.baths ?? "?"}ba | ` +
        `${detail.sqft?.toLocaleString() ?? "?"}sqft | ` +
        `list=$${detail.listPrice?.toLocaleString() ?? "N/A"} | ` +
        `est=$${detail.estimate?.toLocaleString() ?? "N/A"}`,
    );
    logger.info(
      `[realtor-enricher] ═══════════════════════════════════════════════\n`,
    );

    return result;
  }

  async lookupBatch(
    addresses: string[],
    concurrency = 1,
  ): Promise<RealtorEstimate[]> {
    const results: RealtorEstimate[] = [];
    const c = Math.max(1, concurrency);

    for (let i = 0; i < addresses.length; i += c) {
      const chunk = addresses.slice(i, i + c);
      logger.info(
        `[realtor-enricher] Batch chunk ` +
          `${Math.floor(i / c) + 1}/${Math.ceil(addresses.length / c)} ` +
          `(${chunk.length} address(es))`,
      );
      const chunkResults = await Promise.all(chunk.map((a) => this.lookup(a)));
      results.push(...chunkResults);
      if (i + c < addresses.length) await sleep(2_000 + Math.random() * 1_000);
    }

    const found = results.filter((r) => r.found).length;
    logger.info(
      `[realtor-enricher] Batch done — ${found}/${results.length} found`,
    );
    return results;
  }
}

// ── Convenience export ────────────────────────────────────────────────────────

export async function lookupRealtorEstimate(
  address: string,
): Promise<RealtorEstimate> {
  return new RealtorAddressEnricher().lookup(address);
}
