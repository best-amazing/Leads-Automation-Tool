// src/scrapers/propwire/propwire.address-enricher.ts
//
// Stand-alone address → Propwire AVM lookup.
//
// Strategy (tried in order):
//   1a. POST https://api.propwire.com/api/auto_complete
//       Resolves address → property ID in one shot.
//   1b. POST https://propwire.com/pw_property_detail  { id }
//       Fetches full AVM / equity / owner data for that ID.
//       Falls back to strategy 1c if blocked.
//   1c. POST https://api.propwire.com/api/property_search (by address fields)
//       Used only when /pw_property_detail fails.
//   2.  POST /api/property_search  searchType "A"
//   3.  POST /api/property_search  searchType "P"
//   4.  City-pagination  searchType "C"  (capped at 5 pages)
//
// Environment variables
// ─────────────────────
// api.propwire.com calls (auto_complete, property_search):
//   PROPWIRE_BEARER_TOKEN      JWT from DevTools → Authorization header (~2h)
//   PROPWIRE_DATADOME          datadome cookie value
//   PROPWIRE_SESSION_COOKIE    full raw cookie string
//   PROPWIRE_X_API_KEY         x-api-key header
//   PROPWIRE_USER_ID           x-user-id header
//   PROPWIRE_XSRF_TOKEN        x-xsrf-token header
//
// propwire.com call (/pw_property_detail):
//   PROPWIRE_WEB_BEARER_TOKEN  JWT for propwire.com (may differ from API JWT)
//   PROPWIRE_WEB_DATADOME      datadome cookie for propwire.com
//   PROPWIRE_WEB_XSRF_TOKEN    x-xsrf-token header for propwire.com
//   PROPWIRE_WEB_SESSION       propwire_session cookie value
//   PROPWIRE_WEB_XSRF_COOKIE   XSRF-TOKEN cookie value (URL-encoded)
//
// Shared:
//   PROXY_URL                  residential proxy URL (bypasses DataDome)
//   PROPWIRE_ENRICHER_DEBUG    set "true" to save debug JSON to logs/

import * as https from "https";
import * as http from "http";
import * as tls from "tls";
import * as zlib from "zlib";
import * as fs from "fs";
import * as path from "path";

import { logger } from "../../utils/logger";
import { sleep } from "../../utils/browser";
import { parsePrice, buildListingUrl } from "./propwire.parser";

// ── Env ───────────────────────────────────────────────────────────────────────

// api.propwire.com
const API_BEARER = process.env.PROPWIRE_BEARER_TOKEN ?? "";
const API_DATADOME = process.env.PROPWIRE_DATADOME ?? "";
const API_RAW_COOKIE = process.env.PROPWIRE_SESSION_COOKIE ?? "";
const API_KEY = process.env.PROPWIRE_X_API_KEY ?? "";
const API_USER_ID = process.env.PROPWIRE_USER_ID ?? "";
const API_XSRF = process.env.PROPWIRE_XSRF_TOKEN ?? "";

// propwire.com  (/pw_property_detail)
const WEB_BEARER = process.env.PROPWIRE_WEB_BEARER_TOKEN ?? API_BEARER;
const WEB_DATADOME = process.env.PROPWIRE_WEB_DATADOME ?? API_DATADOME;
const WEB_XSRF_TOKEN = process.env.PROPWIRE_WEB_XSRF_TOKEN ?? API_XSRF;
const WEB_SESSION = process.env.PROPWIRE_WEB_SESSION ?? "";
const WEB_XSRF_COOKIE = process.env.PROPWIRE_WEB_XSRF_COOKIE ?? "";

const PROXY_URL = process.env.PROXY_URL ?? "";
const DEBUG_SAVE = process.env.PROPWIRE_ENRICHER_DEBUG === "true";

// ── Hosts / paths ─────────────────────────────────────────────────────────────

const API_HOST = "api.propwire.com";
const WEB_HOST = "propwire.com";
const AUTO_COMPLETE_PATH = "/api/auto_complete";
const SEARCH_PATH = "/api/property_search";
const DETAIL_PATH = "/pw_property_detail";

const API_TIMEOUT_MS = 30_000;
const BETWEEN_LOOKUP_MS = 2_000;

// ── Public types ──────────────────────────────────────────────────────────────

export interface PropwireEstimate {
  propertyId: string | null;
  url: string | null;
  propwireEstimate: number | null;
  estimatedEquity: number | null;
  listPrice: number | null;
  address: string;
  rawInput: string;
  leadTypes: string[];
  bedrooms: number | null;
  bathrooms: number | null;
  squareFeet: number | null;
  yearBuilt: number | null;
  ownerName: string | null;
  ownerPhone: string | null;
  found: boolean;
  strategy?: string;
  error?: string;
}

export interface LookupOptions {
  concurrency?: number;
}

// ── Address parser ────────────────────────────────────────────────────────────

interface ParsedAddress {
  street: string;
  city: string;
  state: string;
  stateName: string;
  zip?: string;
}

const STATE_NAMES: Record<string, string> = {
  OH: "Ohio",
  WI: "Wisconsin",
  MI: "Michigan",
  IN: "Indiana",
  IL: "Illinois",
  PA: "Pennsylvania",
  KY: "Kentucky",
  MN: "Minnesota",
  MO: "Missouri",
  TX: "Texas",
  FL: "Florida",
  GA: "Georgia",
  NC: "North Carolina",
  SC: "South Carolina",
  VA: "Virginia",
  MD: "Maryland",
  NY: "New York",
  NJ: "New Jersey",
  CA: "California",
  WA: "Washington",
  OR: "Oregon",
  AZ: "Arizona",
  CO: "Colorado",
  NV: "Nevada",
  UT: "Utah",
  TN: "Tennessee",
  AL: "Alabama",
  MS: "Mississippi",
  AR: "Arkansas",
  LA: "Louisiana",
  OK: "Oklahoma",
  KS: "Kansas",
  NE: "Nebraska",
  IA: "Iowa",
  SD: "South Dakota",
  ND: "North Dakota",
  MT: "Montana",
  WY: "Wyoming",
  ID: "Idaho",
  NM: "New Mexico",
  AK: "Alaska",
  HI: "Hawaii",
  ME: "Maine",
  NH: "New Hampshire",
  VT: "Vermont",
  MA: "Massachusetts",
  RI: "Rhode Island",
  CT: "Connecticut",
  DE: "Delaware",
  WV: "West Virginia",
};

function normalizePropwireAddress(raw: string): string {
  return raw
    .trim()
    .replace(/\s+/g, " ")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+$/g, "");
}

function splitStreetAndCity(
  raw: string,
): { street: string; city: string } | null {
  const match = raw.match(/^(.*\d+.*\b)\s+([A-Za-z][A-Za-z\s]+)$/);
  if (!match) return null;
  const street = match[1].trim();
  const city = match[2].trim();
  if (!street || !city) return null;
  return { street, city };
}

function parseAddress(raw: string): ParsedAddress | null {
  const normalizedRaw = normalizePropwireAddress(raw);
  const parts = normalizedRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (parts.length < 2) return null;

  const stateAbbrevRe = /^([A-Za-z]{2})\s*(\d{5})?$/;
  const zipRe = /^(\d{5})$/;
  let street = "",
    city = "",
    state = "",
    zip: string | undefined;

  const lastPart = parts[parts.length - 1];
  const stateZipMatch = lastPart.match(stateAbbrevRe);
  if (stateZipMatch) {
    state = stateZipMatch[1].toUpperCase();
    zip = stateZipMatch[2];
  }

  const prefixParts = parts.slice(0, -1);
  if (prefixParts.length === 1) {
    const compact = splitStreetAndCity(prefixParts[0]);
    if (compact) {
      street = compact.street;
      city = compact.city;
    } else street = prefixParts[0];
  } else {
    const filtered = prefixParts.filter((part, idx) => {
      if (idx === 0) return true;
      if (stateAbbrevRe.test(part)) return true;
      if (zipRe.test(part)) return true;
      if (/^[A-Za-z\s\-']+$/.test(part) && idx < prefixParts.length - 1) {
        const prevIsCity =
          idx >= 2 && /^[A-Za-z\s\-']+$/.test(prefixParts[idx - 1]);
        if (prevIsCity) return false;
      }
      return true;
    });
    street = filtered[0] ?? "";
    city = filtered.slice(1).join(", ");
  }

  if (!state) {
    const m = normalizedRaw.match(/\b([A-Za-z]{2})\b\s*(\d{5})?/);
    if (m) {
      state = m[1].toUpperCase();
      zip = zip ?? m[2];
    }
  }
  if (!city) {
    const implied = normalizedRaw.match(
      /^(.*\d+.*?)\s+([A-Za-z][A-Za-z\s]+),\s*[A-Za-z]{2}/,
    );
    if (implied) city = implied[2].trim();
  }

  if (!street || !city || !state) return null;
  return { street, city, state, stateName: STATE_NAMES[state] ?? state, zip };
}

// ── Street helpers ────────────────────────────────────────────────────────────

function normaliseStreet(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\bboulevard\b/g, "blvd")
    .replace(/\bdrive\b/g, "dr")
    .replace(/\broad\b/g, "rd")
    .replace(/\blane\b/g, "ln")
    .replace(/\bcourt\b/g, "ct")
    .replace(/\bplace\b/g, "pl")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function streetMatches(candidate: string, target: string): boolean {
  return (
    normaliseStreet(candidate).includes(normaliseStreet(target)) ||
    normaliseStreet(target).includes(normaliseStreet(candidate))
  );
}

function houseNumber(street: string): string {
  return street.trim().match(/^(\d+)/)?.[1] ?? "";
}

// ── Lead-type extractor ───────────────────────────────────────────────────────

function extractLeadTypes(obj: any): string[] {
  if (!obj || typeof obj !== "object") return [];
  if (Array.isArray(obj)) return obj.filter(Boolean);
  return Object.entries(obj)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
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

// ── Header factories ──────────────────────────────────────────────────────────

/** Headers for api.propwire.com (same-site) */
function buildApiHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  const cookieParts: string[] = [];
  if (API_DATADOME) cookieParts.push(`datadome=${API_DATADOME}`);
  if (API_RAW_COOKIE) cookieParts.push(API_RAW_COOKIE);

  const h: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Authorization: `Bearer ${API_BEARER}`,
    Origin: "https://propwire.com",
    Referer: "https://propwire.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "sec-ch-ua":
      '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-site",
    "x-requested-with": "XMLHttpRequest",
    priority: "u=1, i",
    ...(API_KEY ? { "x-api-key": API_KEY } : {}),
    ...(API_USER_ID ? { "x-user-id": API_USER_ID } : {}),
    ...(API_XSRF ? { "x-xsrf-token": API_XSRF } : {}),
    ...extra,
  };
  if (cookieParts.length) h["cookie"] = cookieParts.join("; ");
  return h;
}

/** Headers for propwire.com (/pw_property_detail — same-origin) */
function buildWebHeaders(
  extra: Record<string, string> = {},
): Record<string, string> {
  const cookieParts: string[] = [];
  if (WEB_DATADOME) cookieParts.push(`datadome=${WEB_DATADOME}`);
  if (WEB_XSRF_COOKIE) cookieParts.push(`XSRF-TOKEN=${WEB_XSRF_COOKIE}`);
  if (WEB_SESSION) cookieParts.push(`propwire_session=${WEB_SESSION}`);

  const h: Record<string, string> = {
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    Authorization: `Bearer ${WEB_BEARER}`,
    Origin: "https://propwire.com",
    Referer: "https://propwire.com/",
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36",
    "sec-ch-ua":
      '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest": "empty",
    "sec-fetch-mode": "cors",
    "sec-fetch-site": "same-origin",
    "x-requested-with": "XMLHttpRequest",
    priority: "u=1, i",
    ...(API_KEY ? { "x-api-key": API_KEY } : {}),
    ...(WEB_XSRF_TOKEN ? { "x-xsrf-token": WEB_XSRF_TOKEN } : {}),
    ...extra,
  };
  if (cookieParts.length) h["cookie"] = cookieParts.join("; ");
  return h;
}

// ── Decompression ─────────────────────────────────────────────────────────────

async function decompress(buf: Buffer, encoding: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const enc = encoding.toLowerCase().trim();
    if (enc === "gzip" || enc === "x-gzip") {
      zlib.gunzip(buf, (e, r) => (e ? reject(e) : resolve(r)));
    } else if (enc === "deflate") {
      zlib.inflate(buf, (e, r) => {
        if (e)
          zlib.inflateRaw(buf, (e2, r2) => (e2 ? reject(e2) : resolve(r2)));
        else resolve(r);
      });
    } else if (enc === "br") {
      zlib.brotliDecompress(buf, (e, r) => (e ? reject(e) : resolve(r)));
    } else {
      resolve(buf);
    }
  });
}

// ── Transport ─────────────────────────────────────────────────────────────────

interface HttpResult {
  status: number;
  body: string;
}

function decodeChunked(raw: string): string {
  let result = "";
  let rem = raw;
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

async function finaliseProxyResponse(
  rawBinary: string,
): Promise<HttpResult | null> {
  try {
    const headerEnd = rawBinary.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    const headerSection = rawBinary.slice(0, headerEnd);
    const statusMatch = headerSection.match(/^HTTP\/\d\.?\d? (\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
    let decoded = rawBinary.slice(headerEnd + 4);
    if (/transfer-encoding:\s*chunked/i.test(headerSection))
      decoded = decodeChunked(decoded);
    const encMatch = headerSection.match(/content-encoding:\s*(\S+)/i);
    const enc = encMatch?.[1]?.trim() ?? "";
    if (enc === "gzip" || enc === "br" || enc === "deflate") {
      const buf = await decompress(Buffer.from(decoded, "binary"), enc);
      return { status, body: buf.toString("utf-8") };
    }
    return { status, body: decoded };
  } catch {
    return null;
  }
}

function makeProxyTunnel(
  hostname: string,
  onSocket: (socket: tls.TLSSocket) => void,
  onFail: () => void,
): void {
  let proxyHost: string;
  let proxyPort: number;
  let proxyAuth: string | null = null;
  try {
    const u = new URL(PROXY_URL);
    proxyHost = u.hostname;
    proxyPort = parseInt(u.port || "8080", 10);
    if (u.username && u.password)
      proxyAuth = Buffer.from(
        `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`,
      ).toString("base64");
  } catch {
    onFail();
    return;
  }

  const connectHeaders: Record<string, string> = {
    Host: `${hostname}:443`,
    "User-Agent": "Mozilla/5.0",
  };
  if (proxyAuth) connectHeaders["Proxy-Authorization"] = `Basic ${proxyAuth}`;

  const connectReq = http.request({
    host: proxyHost,
    port: proxyPort,
    method: "CONNECT",
    path: `${hostname}:443`,
    headers: connectHeaders,
  });
  connectReq.setTimeout(API_TIMEOUT_MS, () => {
    connectReq.destroy();
    onFail();
  });
  connectReq.on("error", () => onFail());
  connectReq.on("connect", (res: any, socket: any) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      onFail();
      return;
    }
    const tlsSocket = tls.connect({
      host: hostname,
      socket,
      servername: hostname,
      rejectUnauthorized: true,
    });
    tlsSocket.on("error", () => onFail());
    tlsSocket.on("secureConnect", () => onSocket(tlsSocket));
  });
  connectReq.end();
}

async function httpsPostViaProxy(
  hostname: string,
  reqPath: string,
  headers: Record<string, string>,
  body: string,
): Promise<HttpResult | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), API_TIMEOUT_MS);
    makeProxyTunnel(
      hostname,
      (tlsSocket) => {
        const bodyBuf = Buffer.from(body, "utf-8");
        const allHdrs = {
          ...headers,
          "Content-Length": bodyBuf.length.toString(),
        };
        const reqLines =
          `POST ${reqPath} HTTP/1.1\r\nHost: ${hostname}\r\n` +
          Object.entries(allHdrs)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n";
        tlsSocket.write(reqLines);
        tlsSocket.write(bodyBuf);
        const chunks: Buffer[] = [];
        tlsSocket.on("data", (c: Buffer) => chunks.push(c));
        tlsSocket.on("end", async () => {
          clearTimeout(timer);
          resolve(
            await finaliseProxyResponse(
              Buffer.concat(chunks).toString("binary"),
            ),
          );
        });
        tlsSocket.on("error", () => {
          clearTimeout(timer);
          resolve(null);
        });
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

async function httpsPostDirect(
  hostname: string,
  reqPath: string,
  headers: Record<string, string>,
  body: string,
): Promise<HttpResult | null> {
  return new Promise((resolve) => {
    const req = https.request(
      { hostname, path: reqPath, method: "POST", family: 4, headers },
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
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8"),
          }),
        );
        stream.on("error", () => resolve(null));
      },
    );
    req.setTimeout(API_TIMEOUT_MS, () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

function httpsPost(
  hostname: string,
  reqPath: string,
  headers: Record<string, string>,
  body: string,
): Promise<HttpResult | null> {
  return PROXY_URL
    ? httpsPostViaProxy(hostname, reqPath, headers, body)
    : httpsPostDirect(hostname, reqPath, headers, body);
}

// ── Auth / status guards ──────────────────────────────────────────────────────

function checkAuth(label: string): boolean {
  if (API_BEARER) return true;
  logger.error(
    `[propwire-enricher] ${label}: PROPWIRE_BEARER_TOKEN not set.\n` +
      "  Get it from DevTools → Network → api.propwire.com → Authorization header",
  );
  return false;
}

type StatusOutcome = "ok" | "auth" | "blocked" | "error";
function checkStatus(status: number, label: string): StatusOutcome {
  if (status === 200) return "ok";
  if (status === 401) {
    logger.warn(`[propwire-enricher] ${label}: 401 — token expired`);
    return "auth";
  }
  if (status === 403) {
    logger.warn(`[propwire-enricher] ${label}: 403 — DataDome blocked`);
    return "blocked";
  }
  logger.warn(`[propwire-enricher] ${label}: HTTP ${status}`);
  return "error";
}

// ── Strategy 1a: /api/auto_complete ──────────────────────────────────────────

interface AutoCompleteEntry {
  id: number;
  searchType: string;
  address: string;
  street: string;
  city: string;
  state: string;
  zip: string;
  county: string;
  latitude: number;
  longitude: number;
  apn: string;
  fuzzy: boolean;
}

async function autoComplete(
  parsed: ParsedAddress,
): Promise<AutoCompleteEntry[] | null> {
  if (!checkAuth("auto_complete")) return null;

  const stateZip = parsed.zip ? `${parsed.state} ${parsed.zip}` : parsed.state;
  const searchStr = [parsed.street, parsed.city, stateZip]
    .filter(Boolean)
    .join(", ");
  const bodyStr = JSON.stringify({
    search: searchStr,
    search_types: ["C", "Z", "N", "T", "A"],
  });
  const headers = buildApiHeaders({ "Content-Type": "application/json" });

  logger.info(
    `[propwire-enricher]   → POST ${AUTO_COMPLETE_PATH}  search="${searchStr}"`,
  );
  const result = await httpsPost(
    API_HOST,
    AUTO_COMPLETE_PATH,
    headers,
    bodyStr,
  );
  if (!result) {
    logger.warn("[propwire-enricher]   auto_complete: network failure");
    return null;
  }

  logger.info(
    `[propwire-enricher]   auto_complete: HTTP ${result.status}  body=${result.body.length}ch`,
  );
  logger.debug(`[propwire-enricher]   Preview: ${result.body.slice(0, 400)}`);
  debugSave(
    `propwire_autocomplete_${slugify(parsed.street)}.json`,
    result.body,
  );

  if (checkStatus(result.status, "auto_complete") !== "ok") return null;

  try {
    const json = JSON.parse(result.body);
    const entries: any[] =
      json?.data ?? json?.results ?? (Array.isArray(json) ? json : []);

    const targetNum = houseNumber(parsed.street);
    const targetState = parsed.state.toUpperCase();

    const strict = entries.filter((e: AutoCompleteEntry) => {
      if (e.searchType !== "A") return false;
      if (e.state?.toUpperCase() !== targetState) return false;
      if (targetNum && houseNumber(e.street ?? e.address) !== targetNum)
        return false;
      if (parsed.zip && e.zip && e.zip !== parsed.zip) return false;
      return true;
    });

    if (strict.length > 0) {
      logger.info(
        `[propwire-enricher]   auto_complete: ${strict.length} strict match(es) (of ${entries.length} total)`,
      );
      return strict as AutoCompleteEntry[];
    }

    logger.warn(
      `[propwire-enricher]   auto_complete: 0 strict matches from ${entries.length} result(s). ` +
        `Entries: ${entries.map((e: any) => `"${e.address}" [${e.state}]`).join(" | ")}`,
    );
    return [];
  } catch {
    logger.warn("[propwire-enricher]   auto_complete: JSON parse failed");
    return null;
  }
}

// ── Strategy 1b: POST /pw_property_detail  { id } ────────────────────────────
//
// Confirmed via DevTools:
//   POST https://propwire.com/pw_property_detail
//   Body: { "id": 235684 }
//   Response: { response: [{ id, equity_details, property_details, owner_details, ... }] }

async function fetchPropertyDetail(propertyId: number): Promise<any | null> {
  if (!WEB_BEARER) {
    logger.warn(
      "[propwire-enricher]   pw_property_detail: PROPWIRE_WEB_BEARER_TOKEN not set — skipping",
    );
    return null;
  }

  const bodyStr = JSON.stringify({ id: propertyId });
  const headers = buildWebHeaders({ "Content-Type": "application/json" });

  logger.info(`[propwire-enricher]   → POST ${DETAIL_PATH}  id=${propertyId}`);
  const result = await httpsPost(WEB_HOST, DETAIL_PATH, headers, bodyStr);
  if (!result) {
    logger.warn("[propwire-enricher]   pw_property_detail: network failure");
    return null;
  }

  logger.info(
    `[propwire-enricher]   pw_property_detail: HTTP ${result.status}  body=${result.body.length}ch`,
  );
  logger.debug(`[propwire-enricher]   Preview: ${result.body.slice(0, 400)}`);
  debugSave(`propwire_pw_detail_${propertyId}.json`, result.body);

  if (checkStatus(result.status, "pw_property_detail") !== "ok") return null;

  try {
    const json = JSON.parse(result.body);
    const records: any[] = json?.response ?? [];
    return (
      records.find((r: any) => Number(r.id) === propertyId) ??
      records[0] ??
      null
    );
  } catch {
    logger.warn("[propwire-enricher]   pw_property_detail: JSON parse failed");
    return null;
  }
}

// ── Strategy 1c: /api/property_search by address fields ──────────────────────
//
// Fallback when /pw_property_detail is blocked. Searches by address rather than
// ID because the API ignores the id field and does a geographic search anyway.

async function fetchPropertyByAddress(
  acEntry: AutoCompleteEntry,
): Promise<any | null> {
  if (!checkAuth("property_search_by_address")) return null;

  const requestBody = {
    size: 25,
    result_index: 0,
    house: true,
    locations: [
      {
        searchType: "A",
        id: acEntry.id,
        state: acEntry.state,
        stateName: STATE_NAMES[acEntry.state] ?? acEntry.state,
        city: acEntry.city,
        title: acEntry.address,
        address: acEntry.street,
        zip: acEntry.zip,
      },
    ],
  };

  const bodyStr = JSON.stringify(requestBody);
  const headers = buildApiHeaders({ "Content-Type": "application/json" });

  logger.info(
    `[propwire-enricher]   → POST ${SEARCH_PATH}  (address fallback)  id=${acEntry.id}  addr="${acEntry.address}"`,
  );
  const result = await httpsPost(API_HOST, SEARCH_PATH, headers, bodyStr);
  if (!result) {
    logger.warn(
      "[propwire-enricher]   property_search_by_address: network failure",
    );
    return null;
  }

  logger.info(
    `[propwire-enricher]   property_search_by_address: HTTP ${result.status}  body=${result.body.length}ch`,
  );
  logger.debug(`[propwire-enricher]   Preview: ${result.body.slice(0, 400)}`);
  debugSave(`propwire_search_by_addr_${acEntry.id}.json`, result.body);

  if (checkStatus(result.status, "property_search_by_address") !== "ok")
    return null;

  try {
    const json = JSON.parse(result.body);
    const properties: any[] =
      json?.response ?? json?.data?.properties ?? json?.properties ?? [];

    const exact = properties.find(
      (p) => Number(p.id ?? p.property_id) === acEntry.id,
    );
    if (exact) return exact;

    const byStreet = properties.find((p) => {
      const addrObj = p.address ?? {};
      const street =
        typeof addrObj === "string"
          ? addrObj
          : (addrObj.address ?? addrObj.street_address ?? "").trim();
      const state = (addrObj.state ?? p.state ?? "").toUpperCase();
      return (
        state === acEntry.state.toUpperCase() &&
        streetMatches(street, acEntry.street)
      );
    });
    if (byStreet) return byStreet;

    logger.warn(
      `[propwire-enricher]   property_search_by_address: id ${acEntry.id} not found ` +
        `(got ${properties.length} record(s): ${properties.map((p: any) => p.id).join(", ")})`,
    );
    return null;
  } catch {
    logger.warn(
      "[propwire-enricher]   property_search_by_address: JSON parse failed",
    );
    return null;
  }
}

// ── Strategies 2 / 3: searchType "A" or "P" ──────────────────────────────────

async function searchByAddressType(
  parsed: ParsedAddress,
  searchType: "A" | "P",
): Promise<any[] | null> {
  if (!checkAuth(`searchType-${searchType}`)) return null;

  const requestBody = {
    size: 10,
    result_index: 0,
    house: true,
    locations: [
      {
        searchType,
        state: parsed.state,
        stateName: parsed.stateName,
        title: `${parsed.street}, ${parsed.city}, ${parsed.state}${parsed.zip ? " " + parsed.zip : ""}`,
        city: parsed.city,
        address: parsed.street,
        ...(parsed.zip ? { zip: parsed.zip } : {}),
      },
    ],
  };

  const bodyStr = JSON.stringify(requestBody);
  const headers = buildApiHeaders({ "Content-Type": "application/json" });

  logger.info(
    `[propwire-enricher]   → POST ${SEARCH_PATH}  searchType="${searchType}"`,
  );
  const result = await httpsPost(API_HOST, SEARCH_PATH, headers, bodyStr);
  if (!result) {
    logger.warn(
      `[propwire-enricher]   searchType-${searchType}: network failure`,
    );
    return null;
  }

  logger.info(
    `[propwire-enricher]   searchType-${searchType}: HTTP ${result.status}  body=${result.body.length}ch`,
  );
  logger.debug(`[propwire-enricher]   Preview: ${result.body.slice(0, 300)}`);
  debugSave(
    `propwire_search_${searchType}_${slugify(parsed.street)}.json`,
    result.body,
  );

  if (checkStatus(result.status, `searchType-${searchType}`) !== "ok")
    return null;

  try {
    const json = JSON.parse(result.body);
    return json?.response ?? json?.data?.properties ?? json?.properties ?? [];
  } catch {
    return null;
  }
}

// ── Strategy 4: city-pagination ───────────────────────────────────────────────

async function searchByCityPagination(
  parsed: ParsedAddress,
  maxPages = 5,
): Promise<any | null> {
  if (!checkAuth("city-pagination")) return null;

  const PAGE_SIZE = 50;
  for (let page = 0; page < maxPages; page++) {
    logger.info(
      `[propwire-enricher]   city-pagination page ${page + 1}/${maxPages}`,
    );
    const requestBody = {
      size: PAGE_SIZE,
      result_index: page * PAGE_SIZE,
      house: true,
      locations: [
        {
          searchType: "C",
          state: parsed.state,
          stateName: parsed.stateName,
          title: `${parsed.city}, ${parsed.state}`,
          city: parsed.city,
        },
      ],
    };

    const result = await httpsPost(
      API_HOST,
      SEARCH_PATH,
      buildApiHeaders({ "Content-Type": "application/json" }),
      JSON.stringify(requestBody),
    );
    if (!result || checkStatus(result.status, "city-pagination") !== "ok")
      return null;

    let properties: any[];
    try {
      const json = JSON.parse(result.body);
      properties =
        json?.response ?? json?.data?.properties ?? json?.properties ?? [];
    } catch {
      return null;
    }

    debugSave(
      `propwire_city_p${page + 1}_${slugify(parsed.street)}.json`,
      JSON.stringify(properties, null, 2),
    );
    logger.info(`[propwire-enricher]   ${properties.length} properties`);

    for (const item of properties) {
      const addrObj = item.address ?? {};
      const street =
        typeof addrObj === "string"
          ? addrObj
          : (
              addrObj.address ??
              addrObj.street_address ??
              item.street_address ??
              ""
            ).trim();
      if (!street) continue;
      if (!streetMatches(street, parsed.street)) continue;
      const itemZip = (addrObj.zip ?? item.zip ?? "").trim();
      if (parsed.zip && itemZip && itemZip !== parsed.zip) continue;
      logger.info(`[propwire-enricher]   city-pagination ✓ page ${page + 1}`);
      return item;
    }

    if (properties.length < PAGE_SIZE) break;
    await sleep(800);
  }
  return null;
}

// ── Result extractor — handles both response shapes ───────────────────────────
//
// /pw_property_detail nests data under property_details, equity_details, etc.
// /api/property_search returns flat fields on the record.
// Both are handled here.

function extractFromProperty(
  matched: any,
  rawAddress: string,
): Omit<PropwireEstimate, "strategy"> {
  // Address — prefer nested property_details.address_details, then flat address obj
  const addrDetails =
    matched.property_details?.address_details ?? matched.address ?? {};
  const streetLine =
    typeof addrDetails === "string"
      ? addrDetails
      : (addrDetails.address ?? addrDetails.street_address ?? "").trim();
  const city = (addrDetails.city ?? matched.city ?? "").trim();
  const state = (addrDetails.state ?? matched.state ?? "").trim();
  const zip = (addrDetails.zip ?? matched.zip ?? "").trim();
  const fullAddress = [streetLine, city, state, zip].filter(Boolean).join(", ");
  const propertyId = String(matched.id ?? matched.property_id ?? "");

  // AVM / equity — prefer equity_details (from /pw_property_detail)
  const propwireEstimate =
    parsePrice(
      matched.equity_details?.estimated_value ??
        matched.estimated_value ??
        matched.estimatedValue ??
        matched.avm_value,
    ) ?? null;
  const estimatedEquity =
    parsePrice(
      matched.equity_details?.estimated_equity ??
        matched.estimated_equity ??
        matched.estimatedEquity,
    ) ?? null;
  const listPrice =
    parsePrice(matched.list_price ?? matched.listing_price) ?? null;

  const leadTypes = extractLeadTypes(matched.lead_type);
  const url = propertyId
    ? buildListingUrl(propertyId, streetLine, city, state)
    : null;

  // Beds / baths / sqft / year — prefer nested building details
  const bldInt = matched.property_details?.building_interior_details;
  const bldDet = matched.property_details?.building_details;
  const bedrooms =
    bldInt?.bedrooms ??
    (typeof matched.bedrooms === "number" ? matched.bedrooms : null);
  const bathrooms =
    bldInt?.bathrooms ??
    (typeof matched.bathrooms === "number" ? matched.bathrooms : null);
  const squareFeet =
    bldDet?.building_area_sf ??
    (typeof matched.building_area_sf === "number"
      ? matched.building_area_sf
      : null);
  const yearBuilt =
    bldDet?.year_built ??
    (typeof matched.year_built === "number" ? matched.year_built : null);

  // Owner — prefer owner_details (from /pw_property_detail)
  const rawOwner =
    matched.owner_details?.owner_names ??
    matched.owner_name ??
    matched.ownerName;
  const ownerName: string | null = Array.isArray(rawOwner)
    ? (rawOwner[0] ?? null)
    : typeof rawOwner === "string"
      ? rawOwner
      : null;

  return {
    propertyId: propertyId || null,
    url,
    propwireEstimate,
    estimatedEquity,
    listPrice,
    address: fullAddress || rawAddress,
    rawInput: rawAddress,
    leadTypes,
    bedrooms,
    bathrooms,
    squareFeet,
    yearBuilt,
    ownerName,
    ownerPhone: matched.owner_phone ?? null,
    found: true,
  };
}

// ── Partial result from auto_complete (no AVM) ────────────────────────────────

function estimateFromAutoComplete(
  entry: AutoCompleteEntry,
  rawAddress: string,
): PropwireEstimate {
  const propertyId = String(entry.id);
  return {
    propertyId,
    url: buildListingUrl(propertyId, entry.street, entry.city, entry.state),
    propwireEstimate: null,
    estimatedEquity: null,
    listPrice: null,
    address: entry.address || rawAddress,
    rawInput: rawAddress,
    leadTypes: [],
    bedrooms: null,
    bathrooms: null,
    squareFeet: null,
    yearBuilt: null,
    ownerName: null,
    ownerPhone: null,
    found: true,
    strategy: "auto_complete_partial",
  };
}

// ── Address-type search match filter (shared by strategies 2 & 3) ─────────────

function findMatch(properties: any[], parsed: ParsedAddress): any | null {
  return (
    properties.find((item) => {
      const addrObj = item.address ?? {};
      const street =
        typeof addrObj === "string"
          ? addrObj
          : (addrObj.address ?? addrObj.street_address ?? "").trim();
      const state = (addrObj.state ?? item.state ?? "").toUpperCase();
      const itemZip = (addrObj.zip ?? item.zip ?? "").trim();
      const numMatch =
        !houseNumber(parsed.street) ||
        houseNumber(street) === houseNumber(parsed.street);
      const stMatch = state === parsed.state.toUpperCase();
      const zipMatch = !parsed.zip || !itemZip || itemZip === parsed.zip;
      return (
        street &&
        numMatch &&
        stMatch &&
        zipMatch &&
        streetMatches(street, parsed.street)
      );
    }) ?? null
  );
}

// ── PropwireAddressEnricher ───────────────────────────────────────────────────

export class PropwireAddressEnricher {
  async lookup(rawAddress: string): Promise<PropwireEstimate> {
    logger.info(
      `\n[propwire-enricher] ═══════════════════════════════════════════════`,
    );
    logger.info(`[propwire-enricher] 📍 "${rawAddress}"`);

    const base: Omit<PropwireEstimate, "found"> = {
      propertyId: null,
      url: null,
      propwireEstimate: null,
      estimatedEquity: null,
      listPrice: null,
      address: rawAddress,
      rawInput: rawAddress,
      leadTypes: [],
      bedrooms: null,
      bathrooms: null,
      squareFeet: null,
      yearBuilt: null,
      ownerName: null,
      ownerPhone: null,
    };

    const parsed = parseAddress(rawAddress);
    if (!parsed) {
      logger.warn(
        `[propwire-enricher] Could not parse address: "${rawAddress}"`,
      );
      return { ...base, found: false, error: "invalid_address" };
    }

    logger.info(
      `[propwire-enricher]   street="${parsed.street}"  city="${parsed.city}"  ` +
        `state="${parsed.state}"  zip="${parsed.zip ?? "n/a"}"`,
    );

    // ── Strategy 1a: auto_complete ────────────────────────────────────────

    logger.info(`[propwire-enricher]   ── Strategy 1a: /api/auto_complete`);
    const acEntries = await autoComplete(parsed);

    if (acEntries && acEntries.length > 0) {
      const best =
        acEntries.find(
          (e) =>
            e.searchType === "A" &&
            streetMatches(e.street ?? e.address, parsed.street) &&
            (!parsed.zip || !e.zip || e.zip === parsed.zip),
        ) ?? acEntries[0];

      logger.info(
        `[propwire-enricher]   Best AC match: id=${best.id}  "${best.address}"`,
      );

      // ── Strategy 1b: /pw_property_detail ─────────────────────────────

      await sleep(400);
      logger.info(
        `[propwire-enricher]   ── Strategy 1b: POST /pw_property_detail  id=${best.id}`,
      );
      const detail = await fetchPropertyDetail(best.id);

      if (detail) {
        logger.info(
          `[propwire-enricher]   ✓ Full detail retrieved via /pw_property_detail`,
        );
        debugSave(
          `propwire_matched_full_${slugify(rawAddress)}.json`,
          JSON.stringify(detail, null, 2),
        );
        const est = extractFromProperty(detail, rawAddress);
        logger.info(
          `[propwire-enricher]   estimate=${est.propwireEstimate != null ? "$" + est.propwireEstimate.toLocaleString() : "N/A"}` +
            `  equity=${est.estimatedEquity != null ? "$" + est.estimatedEquity.toLocaleString() : "N/A"}`,
        );
        logger.info(
          `[propwire-enricher] ═══════════════════════════════════════════════\n`,
        );
        return { ...est, strategy: "auto_complete+pw_property_detail" };
      }

      // ── Strategy 1c: /api/property_search by address (fallback) ──────

      logger.warn(
        `[propwire-enricher]   /pw_property_detail failed — trying property_search fallback`,
      );
      await sleep(400);
      logger.info(
        `[propwire-enricher]   ── Strategy 1c: POST /api/property_search (address fallback)`,
      );
      const detailFallback = await fetchPropertyByAddress(best);

      if (detailFallback) {
        logger.info(
          `[propwire-enricher]   ✓ Full detail retrieved via property_search fallback`,
        );
        debugSave(
          `propwire_matched_full_${slugify(rawAddress)}.json`,
          JSON.stringify(detailFallback, null, 2),
        );
        const est = extractFromProperty(detailFallback, rawAddress);
        logger.info(
          `[propwire-enricher] ═══════════════════════════════════════════════\n`,
        );
        return { ...est, strategy: "auto_complete+property_search" };
      }

      // Both detail fetches failed — return partial auto_complete result
      logger.warn(
        `[propwire-enricher]   All detail fetches failed — returning partial AC result (no AVM)`,
      );
      return estimateFromAutoComplete(best, rawAddress);
    }

    // ── Strategy 2: searchType "A" ────────────────────────────────────────

    logger.info(
      `[propwire-enricher]   ── Strategy 2: property_search searchType="A"`,
    );
    await sleep(600);
    const resultsA = await searchByAddressType(parsed, "A");

    if (resultsA && resultsA.length > 0) {
      const matched = findMatch(resultsA, parsed);
      if (matched) {
        logger.info(`[propwire-enricher]   ✓ searchType "A" matched`);
        logger.info(
          `[propwire-enricher] ═══════════════════════════════════════════════\n`,
        );
        return {
          ...extractFromProperty(matched, rawAddress),
          strategy: "searchType-A",
        };
      }
      logger.warn(
        `[propwire-enricher]   searchType "A": no valid match in ${resultsA.length} result(s) — ` +
          `first was "${typeof resultsA[0].address === "string" ? resultsA[0].address : resultsA[0].address?.address}"`,
      );
    }

    // ── Strategy 3: searchType "P" ────────────────────────────────────────

    logger.info(
      `[propwire-enricher]   ── Strategy 3: property_search searchType="P"`,
    );
    await sleep(600);
    const resultsP = await searchByAddressType(parsed, "P");

    if (resultsP && resultsP.length > 0) {
      const matched = findMatch(resultsP, parsed);
      if (matched) {
        logger.info(`[propwire-enricher]   ✓ searchType "P" matched`);
        logger.info(
          `[propwire-enricher] ═══════════════════════════════════════════════\n`,
        );
        return {
          ...extractFromProperty(matched, rawAddress),
          strategy: "searchType-P",
        };
      }
      logger.warn(
        `[propwire-enricher]   searchType "P": no valid match in ${resultsP.length} result(s)`,
      );
    }

    // ── Strategy 4: city-pagination ───────────────────────────────────────

    logger.info(
      `[propwire-enricher]   ── Strategy 4: city-pagination (5 pages)`,
    );
    await sleep(600);
    const matchedCity = await searchByCityPagination(parsed, 5);

    if (matchedCity) {
      logger.info(`[propwire-enricher]   ✓ city-pagination matched`);
      logger.info(
        `[propwire-enricher] ═══════════════════════════════════════════════\n`,
      );
      return {
        ...extractFromProperty(matchedCity, rawAddress),
        strategy: "city-pagination",
      };
    }

    logger.warn(
      `[propwire-enricher] ✗ "${rawAddress}" — all strategies exhausted`,
    );
    logger.info(
      `[propwire-enricher] ═══════════════════════════════════════════════\n`,
    );
    return { ...base, found: false, error: "address_not_found" };
  }

  async lookupBatch(
    addresses: string[],
    options: LookupOptions = {},
  ): Promise<PropwireEstimate[]> {
    const concurrency = Math.max(1, options.concurrency ?? 1);
    const results: PropwireEstimate[] = [];

    for (let i = 0; i < addresses.length; i += concurrency) {
      const chunk = addresses.slice(i, i + concurrency);
      logger.info(
        `[propwire-enricher] Batch chunk ` +
          `${Math.floor(i / concurrency) + 1}/${Math.ceil(addresses.length / concurrency)} ` +
          `(${chunk.length} address(es))`,
      );
      const chunkResults = await Promise.all(chunk.map((a) => this.lookup(a)));
      results.push(...chunkResults);
      if (i + concurrency < addresses.length) await sleep(BETWEEN_LOOKUP_MS);
    }

    const found = results.filter((r) => r.found).length;
    logger.info(
      `[propwire-enricher] Batch done — ${found}/${results.length} found`,
    );
    return results;
  }
}

// ── Convenience export ────────────────────────────────────────────────────────

export async function lookupPropwireEstimate(
  address: string,
): Promise<PropwireEstimate> {
  return new PropwireAddressEnricher().lookup(address);
}
