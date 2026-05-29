// src/scrapers/propwire/propwire.address-enricher.ts
//
// Stand-alone address → Propwire AVM lookup.
//
// Strategy (tried in order):
//   1. POST /api/auto_complete  { search, search_types: ["A"] }
//      → returns property ID, address fields, lat/lng directly.
//        One call, exact match, no pagination.
//   2. POST /api/property_search searchType "A" (address-level)
//   3. POST /api/property_search searchType "P" (property-level)
//   4. City-pagination fallback (searchType "C", capped at 5 pages)
//
// The auto_complete endpoint was confirmed via DevTools:
//   POST https://api.propwire.com/api/auto_complete
//   Body: { "search": "3206 N Tampa St", "search_types": ["C","Z","N","T","A"] }
//   Response: { data: [{ id, searchType, address, street, city, state, zip, ... }] }
//
// Once we have the property ID from auto_complete, we call
//   POST /api/property_search  with locations[0].id = <id>
// to get the full AVM / equity / lead-type data.
//
// Required env vars:
//   PROPWIRE_BEARER_TOKEN   — JWT from DevTools (expires ~2h)
//   PROPWIRE_DATADOME       — datadome cookie value
//   PROXY_URL               — residential proxy (bypasses DataDome)
//
// Optional:
//   PROPWIRE_SESSION_COOKIE   — full raw cookie string
//   PROPWIRE_X_API_KEY        — x-api-key header value
//   PROPWIRE_USER_ID          — x-user-id header value
//   PROPWIRE_XSRF_TOKEN       — x-xsrf-token header value
//   PROPWIRE_ENRICHER_DEBUG=true  — saves debug JSON to logs/

import * as https from "https";
import * as http  from "http";
import * as tls   from "tls";
import * as zlib  from "zlib";
import * as fs    from "fs";
import * as path  from "path";

import { logger } from "../../utils/logger";
import { sleep  } from "../../utils/browser";
import { parsePrice, buildListingUrl } from "./propwire.parser";

// ── Env / constants ───────────────────────────────────────────────────────────

const BEARER_TOKEN    = process.env.PROPWIRE_BEARER_TOKEN     ?? "";
const DATADOME_COOKIE = process.env.PROPWIRE_DATADOME         ?? "";
const RAW_COOKIE      = process.env.PROPWIRE_SESSION_COOKIE   ?? "";
const PROXY_URL       = process.env.PROXY_URL                 ?? "";

const API_HOST          = "api.propwire.com";
const AUTO_COMPLETE_PATH = "/api/auto_complete";       // ← confirmed via DevTools
const SEARCH_PATH        = "/api/property_search";
const API_TIMEOUT_MS     = 30_000;
const BETWEEN_LOOKUP_MS  = 2_000;
const DEBUG_SAVE         = process.env.PROPWIRE_ENRICHER_DEBUG === "true";

// ── Public types ──────────────────────────────────────────────────────────────

export interface PropwireEstimate {
  propertyId:        string | null;
  url:               string | null;
  propwireEstimate:  number | null;
  estimatedEquity:   number | null;
  listPrice:         number | null;
  address:           string;
  rawInput:          string;
  leadTypes:         string[];
  bedrooms:          number | null;
  bathrooms:         number | null;
  squareFeet:        number | null;
  yearBuilt:         number | null;
  ownerName:         string | null;
  ownerPhone:        string | null;
  found:             boolean;
  strategy?:         string;
  error?:            string;
}

export interface LookupOptions {
  concurrency?: number;
}

// ── Address parser ────────────────────────────────────────────────────────────

interface ParsedAddress {
  street:    string;
  city:      string;
  state:     string;
  stateName: string;
  zip?:      string;
}

const STATE_NAMES: Record<string, string> = {
  OH: "Ohio", WI: "Wisconsin", MI: "Michigan", IN: "Indiana",
  IL: "Illinois", PA: "Pennsylvania", KY: "Kentucky", MN: "Minnesota",
  MO: "Missouri", TX: "Texas", FL: "Florida", GA: "Georgia",
  NC: "North Carolina", SC: "South Carolina", VA: "Virginia",
  MD: "Maryland", NY: "New York", NJ: "New Jersey", CA: "California",
  WA: "Washington", OR: "Oregon", AZ: "Arizona", CO: "Colorado",
  NV: "Nevada", UT: "Utah", TN: "Tennessee", AL: "Alabama",
  MS: "Mississippi", AR: "Arkansas", LA: "Louisiana", OK: "Oklahoma",
  KS: "Kansas", NE: "Nebraska", IA: "Iowa", SD: "South Dakota",
  ND: "North Dakota", MT: "Montana", WY: "Wyoming", ID: "Idaho",
  NM: "New Mexico", AK: "Alaska", HI: "Hawaii", ME: "Maine",
  NH: "New Hampshire", VT: "Vermont", MA: "Massachusetts",
  RI: "Rhode Island", CT: "Connecticut", DE: "Delaware", WV: "West Virginia",
};

function parseAddress(raw: string): ParsedAddress | null {
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const street = parts[0];
  let city  = "";
  let state = "";
  let zip: string | undefined;

  for (let i = 1; i < parts.length; i++) {
    const part = parts[i];
    const stateZipMatch = part.match(/^([A-Z]{2})\s*(\d{5})?$/);
    if (stateZipMatch) {
      state = stateZipMatch[1];
      zip   = stateZipMatch[2];
      if (!city && i > 1) city = parts[i - 1];
      continue;
    }
    const zipOnly = part.match(/^(\d{5})$/);
    if (zipOnly) { zip = zipOnly[1]; continue; }
    if (!state)  city = part;
  }

  if (!state) {
    const m = raw.match(/\b([A-Z]{2})\b\s*(\d{5})?/);
    if (m) { state = m[1]; zip = m[2]; }
  }
  if (!city) {
    const m = raw.match(/,\s*([A-Za-z\s]+),\s*[A-Z]{2}/);
    if (m) city = m[1].trim();
  }

  if (!street || !city || !state) return null;
  return { street, city, state, stateName: STATE_NAMES[state] ?? state, zip };
}

// ── Street normaliser / matcher ───────────────────────────────────────────────

function normaliseStreet(s: string): string {
  return s
    .toLowerCase()
    .replace(/\bstreet\b/g, "st").replace(/\bavenue\b/g, "ave")
    .replace(/\bboulevard\b/g, "blvd").replace(/\bdrive\b/g, "dr")
    .replace(/\broad\b/g, "rd").replace(/\blane\b/g, "ln")
    .replace(/\bcourt\b/g, "ct").replace(/\bplace\b/g, "pl")
    .replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function streetMatches(candidate: string, target: string): boolean {
  return normaliseStreet(candidate).includes(normaliseStreet(target)) ||
         normaliseStreet(target).includes(normaliseStreet(candidate));
}

// ── Lead-type extractor ───────────────────────────────────────────────────────

function extractLeadTypes(leadTypeObj: any): string[] {
  if (!leadTypeObj || typeof leadTypeObj !== "object") return [];
  if (Array.isArray(leadTypeObj)) return leadTypeObj.filter(Boolean);
  return Object.entries(leadTypeObj)
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
  return s.replace(/[^a-z0-9]+/gi, "_").slice(0, 60).toLowerCase();
}

// ── Common headers factory ────────────────────────────────────────────────────

function buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const cookieParts: string[] = [];
  if (DATADOME_COOKIE) cookieParts.push(`datadome=${DATADOME_COOKIE}`);
  if (RAW_COOKIE)      cookieParts.push(RAW_COOKIE);
  const cookieStr = cookieParts.join("; ");

  const headers: Record<string, string> = {
    "Accept":             "application/json, text/plain, */*",
    "Accept-Language":    "en-US,en;q=0.9",
    "Accept-Encoding":    "gzip, deflate, br",
    "Authorization":      `Bearer ${BEARER_TOKEN}`,
    "Origin":             "https://propwire.com",
    "Referer":            "https://propwire.com/",
    "User-Agent":         "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
    "sec-ch-ua":          '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
    "sec-ch-ua-mobile":   "?0",
    "sec-ch-ua-platform": '"Windows"',
    "sec-fetch-dest":     "empty",
    "sec-fetch-mode":     "cors",
    "sec-fetch-site":     "same-site",
    "x-requested-with":   "XMLHttpRequest",
    "priority":           "u=1, i",
    ...(process.env.PROPWIRE_X_API_KEY  ? { "x-api-key":    process.env.PROPWIRE_X_API_KEY   } : {}),
    ...(process.env.PROPWIRE_USER_ID    ? { "x-user-id":    process.env.PROPWIRE_USER_ID     } : {}),
    ...(process.env.PROPWIRE_XSRF_TOKEN ? { "x-xsrf-token": process.env.PROPWIRE_XSRF_TOKEN  } : {}),
    ...extra,
  };

  if (cookieStr) headers["cookie"] = cookieStr;
  return headers;
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

// ── Transport layer ───────────────────────────────────────────────────────────

interface HttpResult { status: number; body: string }

// Shared chunked-encoding decoder used by both proxy and direct response parsers
function decodeChunked(raw: string): string {
  let result = ""; let rem = raw;
  while (rem.length > 0) {
    const crlf = rem.indexOf("\r\n");
    if (crlf === -1) break;
    const sz = parseInt(rem.slice(0, crlf), 16);
    if (isNaN(sz) || sz === 0) break;
    result += rem.slice(crlf + 2, crlf + 2 + sz);
    rem     = rem.slice(crlf + 2 + sz + 2);
  }
  return result;
}

async function finaliseProxyResponse(
  rawBinary: string
): Promise<HttpResult | null> {
  try {
    const headerEnd = rawBinary.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;

    const headerSection = rawBinary.slice(0, headerEnd);
    const statusMatch   = headerSection.match(/^HTTP\/\d\.?\d? (\d+)/);
    const status        = statusMatch ? parseInt(statusMatch[1], 10) : 0;
    let   decoded       = rawBinary.slice(headerEnd + 4);

    if (/transfer-encoding:\s*chunked/i.test(headerSection)) {
      decoded = decodeChunked(decoded);
    }

    const encMatch = headerSection.match(/content-encoding:\s*(\S+)/i);
    const enc      = encMatch?.[1]?.trim() ?? "";
    if (enc === "gzip" || enc === "br" || enc === "deflate") {
      const buf = await decompress(Buffer.from(decoded, "binary"), enc);
      return { status, body: buf.toString("utf-8") };
    }
    return { status, body: decoded };
  } catch {
    return null;
  }
}

async function httpsPostViaProxy(
  hostname: string, reqPath: string,
  headers: Record<string, string>, body: string
): Promise<HttpResult | null> {
  let proxyHost: string; let proxyPort: number; let proxyAuth: string | null = null;
  try {
    const u   = new URL(PROXY_URL);
    proxyHost = u.hostname;
    proxyPort = parseInt(u.port || "8080", 10);
    if (u.username && u.password)
      proxyAuth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64");
  } catch {
    logger.error(`[propwire-enricher] Invalid PROXY_URL: ${PROXY_URL}`);
    return null;
  }

  return new Promise((resolve) => {
    const connectHeaders: Record<string, string> = { "Host": `${hostname}:443`, "User-Agent": "Mozilla/5.0" };
    if (proxyAuth) connectHeaders["Proxy-Authorization"] = `Basic ${proxyAuth}`;

    const connectReq = http.request({
      host: proxyHost, port: proxyPort, method: "CONNECT",
      path: `${hostname}:443`, headers: connectHeaders,
    });

    const timer = setTimeout(() => { connectReq.destroy(); resolve(null); }, API_TIMEOUT_MS);

    connectReq.on("error", (err: any) => {
      clearTimeout(timer);
      logger.error(`[propwire-enricher] Proxy CONNECT error: ${err.message}`);
      resolve(null);
    });

    connectReq.on("connect", (res: any, socket: any) => {
      if (res.statusCode !== 200) { clearTimeout(timer); socket.destroy(); resolve(null); return; }

      const tlsSocket = tls.connect({ host: hostname, socket, servername: hostname, rejectUnauthorized: true });

      tlsSocket.on("error", (err: any) => {
        clearTimeout(timer);
        logger.warn(`[propwire-enricher] TLS error: ${err.message}`);
        resolve(null);
      });

      tlsSocket.on("secureConnect", () => {
        const bodyBuf  = Buffer.from(body, "utf-8");
        const allHdrs  = { ...headers, "Content-Length": bodyBuf.length.toString() };
        const reqLines =
          `POST ${reqPath} HTTP/1.1\r\nHost: ${hostname}\r\n` +
          Object.entries(allHdrs).map(([k, v]) => `${k}: ${v}`).join("\r\n") +
          "\r\n\r\n";

        tlsSocket.write(reqLines);
        tlsSocket.write(bodyBuf);

        const chunks: Buffer[] = [];
        tlsSocket.on("data", (c: Buffer) => chunks.push(c));
        tlsSocket.on("end", async () => {
          clearTimeout(timer);
          const result = await finaliseProxyResponse(Buffer.concat(chunks).toString("binary"));
          resolve(result);
        });
        tlsSocket.on("error", () => { clearTimeout(timer); resolve(null); });
      });
    });

    connectReq.end();
  });
}

async function httpsPostDirect(
  hostname: string, reqPath: string,
  headers: Record<string, string>, body: string
): Promise<HttpResult | null> {
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
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf-8") })
        );
        stream.on("error", () => resolve(null));
      }
    );
    req.setTimeout(API_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.write(body);
    req.end();
  });
}

function httpsPost(
  hostname: string, reqPath: string,
  headers: Record<string, string>, body: string
): Promise<HttpResult | null> {
  return PROXY_URL
    ? httpsPostViaProxy(hostname, reqPath, headers, body)
    : httpsPostDirect(hostname, reqPath, headers, body);
}

// ── Auth / status guard ───────────────────────────────────────────────────────

function checkAuth(label: string): boolean {
  if (BEARER_TOKEN) return true;
  logger.error(
    `[propwire-enricher] ${label}: PROPWIRE_BEARER_TOKEN not set.\n` +
    "  Get it from DevTools → Network → api.propwire.com → Authorization header"
  );
  return false;
}

type StatusOutcome = "ok" | "auth" | "blocked" | "error";
function checkStatus(status: number, label: string): StatusOutcome {
  if (status === 200)  return "ok";
  if (status === 401) { logger.warn(`[propwire-enricher] ${label}: 401 — token expired`);         return "auth";    }
  if (status === 403) { logger.warn(`[propwire-enricher] ${label}: 403 — DataDome blocked`);      return "blocked"; }
  logger.warn(`[propwire-enricher] ${label}: HTTP ${status}`);
  return "error";
}

// ── Strategy 1: /api/auto_complete ───────────────────────────────────────────
//
// POST { search: "<street> <city> <state>", search_types: ["A"] }
// Returns matched property IDs + full address data in one call.
// Confirmed endpoint + payload shape via DevTools (May 2025).

interface AutoCompleteEntry {
  id:         number;
  searchType: string;
  address:    string;   // "3206 N Tampa St, Tampa, FL, 33603"
  street:     string;   // "3206 N Tampa St"
  city:       string;
  state:      string;
  zip:        string;
  county:     string;
  latitude:   number;
  longitude:  number;
  apn:        string;
  fuzzy:      boolean;
}

// Extract house number from a street string e.g. "3206 Tampa Ave" → "3206"
function houseNumber(street: string): string {
  return street.trim().match(/^(\d+)/)?.[1] ?? "";
}

async function autoComplete(parsed: ParsedAddress): Promise<AutoCompleteEntry[] | null> {
  if (!checkAuth("auto_complete")) return null;

  // Use the full address string so the API can narrow by state/zip.
  // Prefer combining state+zip into a single segment so the API treats them together.
  const stateZip  = parsed.zip ? `${parsed.state} ${parsed.zip}` : parsed.state;
  const searchStr = [parsed.street, parsed.city, stateZip].filter(Boolean).join(", ");

  const bodyObj = {
    search:       searchStr,
    search_types: ["C", "Z", "N", "T", "A"],
  };
  const bodyStr = JSON.stringify(bodyObj);
  const headers = buildHeaders({ "Content-Type": "application/json" });

  logger.info(`[propwire-enricher]   → POST ${AUTO_COMPLETE_PATH}  search="${searchStr}"`);

  const result = await httpsPost(API_HOST, AUTO_COMPLETE_PATH, headers, bodyStr);
  if (!result) { logger.warn("[propwire-enricher]   auto_complete: network failure"); return null; }

  logger.info(`[propwire-enricher]   auto_complete: HTTP ${result.status}  body=${result.body.length}ch`);
  logger.debug(`[propwire-enricher]   Response preview: ${result.body.slice(0, 400)}`);
  debugSave(`propwire_autocomplete_${slugify(parsed.street)}.json`, result.body);

  if (checkStatus(result.status, "auto_complete") !== "ok") return null;

  try {
    const json = JSON.parse(result.body);
    const entries: any[] = json?.data ?? json?.results ?? (Array.isArray(json) ? json : []);

    // ── Strict match filter ───────────────────────────────────────────────
    // The API does fuzzy/partial matching and may return wrong states or
    // wrong house numbers. Only keep entries that:
    //   1. Are address-type results (searchType "A")
    //   2. Match the target state exactly
    //   3. Have the same house number as the input
    //   4. Optionally match zip if both sides have one

    const targetNum   = houseNumber(parsed.street);
    const targetState = parsed.state.toUpperCase();

    const strict = entries.filter((e: AutoCompleteEntry) => {
      if (e.searchType !== "A") return false;
      if (e.state?.toUpperCase() !== targetState) return false;
      if (targetNum && houseNumber(e.street ?? e.address) !== targetNum) return false;
      if (parsed.zip && e.zip && e.zip !== parsed.zip) return false;
      return true;
    });

    if (strict.length > 0) {
      logger.info(`[propwire-enricher]   auto_complete: ${strict.length} strict match(es) (of ${entries.length} total)`);
      return strict as AutoCompleteEntry[];
    }

    // No strict match — log all returned entries so we can diagnose
    logger.warn(
      `[propwire-enricher]   auto_complete: 0 strict matches from ${entries.length} result(s). ` +
      `Entries: ${entries.map((e: any) => `"${e.address}" [${e.state}]`).join(" | ")}`
    );
    return [];
  } catch {
    logger.warn("[propwire-enricher]   auto_complete: JSON parse failed");
    return null;
  }
}

// ── Strategy 2: /api/property_search with property ID ────────────────────────
//
// Once we have a property ID from auto_complete, fetch the full record
// (AVM, equity, lead types, owner, etc.) via property_search.
// We pass the ID in the locations entry — Propwire returns the single record.

async function fetchPropertyById(
  acEntry: AutoCompleteEntry
): Promise<any | null> {
  if (!checkAuth("property_search_by_id")) return null;

  // The /api/property_search API ignores a bare `id` field in the locations
  // payload and runs a city search instead. Use the AC entry's own confirmed
  // address fields (street/city/state/zip) for a tight targeted lookup.
  const requestBody = {
    size:         5,
    result_index: 0,
    house:        true,
    locations: [{
      searchType: "A",
      id:          acEntry.id,
      state:       acEntry.state,
      stateName:   STATE_NAMES[acEntry.state] ?? acEntry.state,
      city:        acEntry.city,
      title:       acEntry.address,
      address:     acEntry.street,
      zip:         acEntry.zip,
    }],
  };

  const bodyStr = JSON.stringify(requestBody);
  const headers = buildHeaders({ "Content-Type": "application/json" });

  logger.info(`[propwire-enricher]   → POST ${SEARCH_PATH}  id=${acEntry.id}  addr="${acEntry.address}"`);

  const result = await httpsPost(API_HOST, SEARCH_PATH, headers, bodyStr);
  if (!result) { logger.warn("[propwire-enricher]   property_search_by_id: network failure"); return null; }

  logger.info(`[propwire-enricher]   property_search_by_id: HTTP ${result.status}  body=${result.body.length}ch`);
  logger.debug(`[propwire-enricher]   Response preview: ${result.body.slice(0, 400)}`);
  debugSave(`propwire_detail_${acEntry.id}.json`, result.body);

  if (checkStatus(result.status, "property_search_by_id") !== "ok") return null;

  try {
    const json       = JSON.parse(result.body);
    const properties: any[] = json?.response ?? json?.data?.properties ?? json?.properties ?? [];

    // Prefer the record whose id exactly matches the AC entry
    const exact = properties.find(p => Number(p.id ?? p.property_id) === acEntry.id);
    if (exact) return exact;

    // Fallback: street match within the correct state
    const byStreet = properties.find(p => {
      const addrObj = p.address ?? {};
      const street  = typeof addrObj === "string" ? addrObj :
                      (addrObj.address ?? addrObj.street_address ?? "").trim();
      const state   = (addrObj.state ?? p.state ?? "").toUpperCase();
      return state === acEntry.state.toUpperCase() && streetMatches(street, acEntry.street);
    });
    if (byStreet) return byStreet;

    logger.warn(
      `[propwire-enricher]   property_search_by_id: id ${acEntry.id} not in response ` +
      `(got ${properties.length} record(s): ${properties.map((p: any) => p.id).join(", ")})`
    );
    return null;
  } catch {
    logger.warn("[propwire-enricher]   property_search_by_id: JSON parse failed");
    return null;
  }
}

// ── Strategy 3: searchType "A" / "P" city-constrained ────────────────────────
//
// Fallback if auto_complete fails — POST to property_search with the street
// address baked into the locations entry.

async function searchByAddressType(
  parsed:     ParsedAddress,
  searchType: "A" | "P"
): Promise<any[] | null> {
  if (!checkAuth(`searchType-${searchType}`)) return null;

  const requestBody = {
    size: 10, result_index: 0, house: true,
    locations: [{
      searchType,
      state:     parsed.state,
      stateName: parsed.stateName,
      title:     `${parsed.street}, ${parsed.city}, ${parsed.state}${parsed.zip ? " " + parsed.zip : ""}`,
      city:       parsed.city,
      address:    parsed.street,
      ...(parsed.zip ? { zip: parsed.zip } : {}),
    }],
  };

  const bodyStr = JSON.stringify(requestBody);
  const headers = buildHeaders({ "Content-Type": "application/json" });

  logger.info(`[propwire-enricher]   → POST ${SEARCH_PATH}  searchType="${searchType}"`);

  const result = await httpsPost(API_HOST, SEARCH_PATH, headers, bodyStr);
  if (!result) { logger.warn(`[propwire-enricher]   searchType-${searchType}: network failure`); return null; }

  logger.info(`[propwire-enricher]   searchType-${searchType}: HTTP ${result.status}  body=${result.body.length}ch`);
  logger.debug(`[propwire-enricher]   Response preview: ${result.body.slice(0, 300)}`);
  debugSave(`propwire_search_${searchType}_${slugify(parsed.street)}.json`, result.body);

  if (checkStatus(result.status, `searchType-${searchType}`) !== "ok") return null;

  try {
    const json = JSON.parse(result.body);
    return json?.response ?? json?.data?.properties ?? json?.properties ?? [];
  } catch { return null; }
}

// ── Strategy 4: city-pagination fallback ─────────────────────────────────────

async function searchByCityPagination(
  parsed: ParsedAddress, maxPages = 5
): Promise<any | null> {
  if (!checkAuth("city-pagination")) return null;

  const PAGE_SIZE = 50;
  for (let page = 0; page < maxPages; page++) {
    const resultIndex = page * PAGE_SIZE;
    logger.info(`[propwire-enricher]   city-pagination page ${page + 1}/${maxPages}`);

    const requestBody = {
      size: PAGE_SIZE, result_index: resultIndex, house: true,
      locations: [{
        searchType: "C", state: parsed.state, stateName: parsed.stateName,
        title: `${parsed.city}, ${parsed.state}`, city: parsed.city,
      }],
    };

    const result = await httpsPost(
      API_HOST, SEARCH_PATH,
      buildHeaders({ "Content-Type": "application/json" }),
      JSON.stringify(requestBody)
    );
    if (!result || checkStatus(result.status, "city-pagination") !== "ok") return null;

    let properties: any[];
    try {
      const json = JSON.parse(result.body);
      properties = json?.response ?? json?.data?.properties ?? json?.properties ?? [];
    } catch { return null; }

    debugSave(`propwire_city_p${page + 1}_${slugify(parsed.street)}.json`, JSON.stringify(properties, null, 2));
    logger.info(`[propwire-enricher]   ${properties.length} properties`);

    for (const item of properties) {
      const addrObj = item.address ?? {};
      const street  = typeof addrObj === "string" ? addrObj :
                      (addrObj.address ?? addrObj.street_address ?? item.street_address ?? "").trim();
      if (!street) continue;
      if (streetMatches(street, parsed.street)) {
        const itemZip = (addrObj.zip ?? item.zip ?? "").trim();
        if (parsed.zip && itemZip && itemZip !== parsed.zip) continue;
        logger.info(`[propwire-enricher]   city-pagination ✓ page ${page + 1}`);
        return item;
      }
    }

    if (properties.length < PAGE_SIZE) break;
    await sleep(800);
  }
  return null;
}

// ── Result extractor ──────────────────────────────────────────────────────────

function extractFromProperty(matched: any, rawAddress: string): Omit<PropwireEstimate, "strategy"> {
  const addrObj     = matched.address ?? {};
  const streetLine  = typeof addrObj === "string" ? addrObj :
                      (addrObj.address ?? addrObj.street_address ?? "").trim();
  const city        = (addrObj.city  ?? matched.city  ?? "").trim();
  const state       = (addrObj.state ?? matched.state ?? "").trim();
  const zip         = (addrObj.zip   ?? matched.zip   ?? "").trim();
  const fullAddress = [streetLine, city, state, zip].filter(Boolean).join(", ");
  const propertyId  = String(matched.id ?? matched.property_id ?? "");

  const propwireEstimate = parsePrice(matched.estimated_value ?? matched.estimatedValue ?? matched.avm_value)  ?? null;
  const estimatedEquity  = parsePrice(matched.estimated_equity ?? matched.estimatedEquity)                     ?? null;
  const listPrice        = parsePrice(matched.list_price ?? matched.listing_price)                             ?? null;
  const leadTypes        = extractLeadTypes(matched.lead_type);

  const url = propertyId ? buildListingUrl(propertyId, streetLine, city, state) : null;

  let ownerName: string | null = null;
  const rawOwner = matched.owner_name ?? matched.ownerName;
  if (Array.isArray(rawOwner))           ownerName = rawOwner[0] ?? null;
  else if (typeof rawOwner === "string") ownerName = rawOwner;

  return {
    propertyId:       propertyId || null,
    url,
    propwireEstimate,
    estimatedEquity,
    listPrice,
    address:          fullAddress || rawAddress,
    rawInput:         rawAddress,
    leadTypes,
    bedrooms:         typeof matched.bedrooms          === "number" ? matched.bedrooms          : null,
    bathrooms:        typeof matched.bathrooms         === "number" ? matched.bathrooms         : null,
    squareFeet:       typeof matched.building_area_sf  === "number" ? matched.building_area_sf  : null,
    yearBuilt:        typeof matched.year_built        === "number" ? matched.year_built        : null,
    ownerName,
    ownerPhone:       matched.owner_phone ?? null,
    found:            true,
  };
}

// ── Auto-complete result → PropwireEstimate ───────────────────────────────────
//
// If the detail fetch fails, we still assemble a partial result from the
// auto_complete entry (has address, ID, coords — but not AVM/equity).

function estimateFromAutoComplete(
  entry: AutoCompleteEntry, rawAddress: string
): PropwireEstimate {
  const propertyId = String(entry.id);
  const url        = propertyId
    ? buildListingUrl(propertyId, entry.street, entry.city, entry.state)
    : null;

  return {
    propertyId,
    url,
    propwireEstimate: null,
    estimatedEquity:  null,
    listPrice:        null,
    address:          entry.address || rawAddress,
    rawInput:         rawAddress,
    leadTypes:        [],
    bedrooms:         null,
    bathrooms:        null,
    squareFeet:       null,
    yearBuilt:        null,
    ownerName:        null,
    ownerPhone:       null,
    found:            true,
    strategy:         "auto_complete_partial",
  };
}

// ── PropwireAddressEnricher ───────────────────────────────────────────────────

export class PropwireAddressEnricher {

  async lookup(rawAddress: string): Promise<PropwireEstimate> {
    logger.info(`\n[propwire-enricher] ═══════════════════════════════════════════════`);
    logger.info(`[propwire-enricher] 📍 "${rawAddress}"`);

    const base: Omit<PropwireEstimate, "found"> = {
      propertyId: null, url: null, propwireEstimate: null, estimatedEquity: null,
      listPrice: null, address: rawAddress, rawInput: rawAddress, leadTypes: [],
      bedrooms: null, bathrooms: null, squareFeet: null, yearBuilt: null,
      ownerName: null, ownerPhone: null,
    };

    const parsed = parseAddress(rawAddress);
    if (!parsed) {
      logger.warn(`[propwire-enricher] Could not parse address: "${rawAddress}"`);
      return { ...base, found: false, error: "invalid_address" };
    }

    logger.info(
      `[propwire-enricher]   street="${parsed.street}"  city="${parsed.city}"  ` +
      `state="${parsed.state}"  zip="${parsed.zip ?? "n/a"}"`
    );

    // ── Strategy 1: auto_complete → property_search by ID ─────────────────
    //
    // One autocomplete call resolves the address to an ID, then a targeted
    // property_search fetch returns the full AVM/equity/lead data.

    logger.info(`[propwire-enricher]   ── Strategy 1: /api/auto_complete`);
    const acEntries = await autoComplete(parsed);

    if (acEntries && acEntries.length > 0) {
      logger.info(`[propwire-enricher]   auto_complete: ${acEntries.length} result(s)`);

      // Pick the best match — prefer exact address match, then first result
      const best = acEntries.find(e =>
        e.searchType === "A" && streetMatches(e.street ?? e.address, parsed.street) &&
        (!parsed.zip || !e.zip || e.zip === parsed.zip)
      ) ?? acEntries[0];

      logger.info(`[propwire-enricher]   Best AC match: id=${best.id}  "${best.address}"`);

      // Fetch full property detail by ID
      await sleep(400);
      logger.info(`[propwire-enricher]   ── Strategy 1b: property_search by id=${best.id}`);
      const detail = await fetchPropertyById(best);

      if (detail) {
        logger.info(`[propwire-enricher]   ✓ Full detail retrieved`);
        debugSave(`propwire_matched_full_${slugify(rawAddress)}.json`, JSON.stringify(detail, null, 2));
        const est = extractFromProperty(detail, rawAddress);
        logger.info(`[propwire-enricher]   estimate=${est.propwireEstimate != null ? "$" + est.propwireEstimate.toLocaleString() : "N/A"}  equity=${est.estimatedEquity != null ? "$" + est.estimatedEquity.toLocaleString() : "N/A"}`);
        logger.info(`[propwire-enricher] ═══════════════════════════════════════════════\n`);
        return { ...est, strategy: "auto_complete+property_search" };
      }

      // Detail fetch failed — return partial result from auto_complete entry
      logger.warn(`[propwire-enricher]   Detail fetch failed — returning partial AC result (no AVM)`);
      return estimateFromAutoComplete(best, rawAddress);
    }

    // ── Strategy 2: property_search searchType "A" ────────────────────────

    logger.info(`[propwire-enricher]   ── Strategy 2: property_search searchType="A"`);
    await sleep(600);
    const resultsA = await searchByAddressType(parsed, "A");

    if (resultsA && resultsA.length > 0) {
      // Never accept first-result fallback — require an actual street match
      // within the correct state to avoid returning a random city property.
      const matched = resultsA.find(item => {
        const addrObj  = item.address ?? {};
        const street   = typeof addrObj === "string" ? addrObj :
                         (addrObj.address ?? addrObj.street_address ?? "").trim();
        const state    = (addrObj.state ?? item.state ?? "").toUpperCase();
        const itemZip  = (addrObj.zip ?? item.zip ?? "").trim();
        const numMatch = !houseNumber(parsed.street) ||
                         houseNumber(street) === houseNumber(parsed.street);
        const stMatch  = state === parsed.state.toUpperCase();
        const zipMatch = !parsed.zip || !itemZip || itemZip === parsed.zip;
        return street && numMatch && stMatch && zipMatch && streetMatches(street, parsed.street);
      });

      if (matched) {
        logger.info(`[propwire-enricher]   ✓ searchType "A" matched: "${
          typeof matched.address === "string" ? matched.address : matched.address?.address
        }"`);
        logger.info(`[propwire-enricher] ═══════════════════════════════════════════════\n`);
        return { ...extractFromProperty(matched, rawAddress), strategy: "searchType-A" };
      }

      logger.warn(
        `[propwire-enricher]   searchType "A": no valid match in ${resultsA.length} result(s) — ` +
        `first was "${typeof resultsA[0].address === "string" ? resultsA[0].address : resultsA[0].address?.address}"`
      );
    }

    // ── Strategy 3: property_search searchType "P" ────────────────────────

    logger.info(`[propwire-enricher]   ── Strategy 3: property_search searchType="P"`);
    await sleep(600);
    const resultsP = await searchByAddressType(parsed, "P");

    if (resultsP && resultsP.length > 0) {
      const matched = resultsP.find(item => {
        const addrObj  = item.address ?? {};
        const street   = typeof addrObj === "string" ? addrObj :
                         (addrObj.address ?? addrObj.street_address ?? "").trim();
        const state    = (addrObj.state ?? item.state ?? "").toUpperCase();
        const itemZip  = (addrObj.zip ?? item.zip ?? "").trim();
        const numMatch = !houseNumber(parsed.street) ||
                         houseNumber(street) === houseNumber(parsed.street);
        const stMatch  = state === parsed.state.toUpperCase();
        const zipMatch = !parsed.zip || !itemZip || itemZip === parsed.zip;
        return street && numMatch && stMatch && zipMatch && streetMatches(street, parsed.street);
      });

      if (matched) {
        logger.info(`[propwire-enricher]   ✓ searchType "P" matched`);
        logger.info(`[propwire-enricher] ═══════════════════════════════════════════════\n`);
        return { ...extractFromProperty(matched, rawAddress), strategy: "searchType-P" };
      }

      logger.warn(`[propwire-enricher]   searchType "P": no valid match in ${resultsP.length} result(s)`);
    }

    // ── Strategy 4: city-pagination fallback ──────────────────────────────

    logger.info(`[propwire-enricher]   ── Strategy 4: city-pagination (5 pages)`);
    await sleep(600);
    const matchedCity = await searchByCityPagination(parsed, 5);

    if (matchedCity) {
      logger.info(`[propwire-enricher]   ✓ city-pagination matched`);
      logger.info(`[propwire-enricher] ═══════════════════════════════════════════════\n`);
      return { ...extractFromProperty(matchedCity, rawAddress), strategy: "city-pagination" };
    }

    logger.warn(`[propwire-enricher] ✗ "${rawAddress}" — all strategies exhausted`);
    logger.info(`[propwire-enricher] ═══════════════════════════════════════════════\n`);
    return { ...base, found: false, error: "address_not_found" };
  }

  async lookupBatch(
    addresses: string[],
    options:   LookupOptions = {}
  ): Promise<PropwireEstimate[]> {
    const concurrency = Math.max(1, options.concurrency ?? 1);
    const results: PropwireEstimate[] = [];

    for (let i = 0; i < addresses.length; i += concurrency) {
      const chunk = addresses.slice(i, i + concurrency);
      logger.info(
        `[propwire-enricher] Batch chunk ` +
        `${Math.floor(i / concurrency) + 1}/${Math.ceil(addresses.length / concurrency)} ` +
        `(${chunk.length} address(es))`
      );
      const chunkResults = await Promise.all(chunk.map(a => this.lookup(a)));
      results.push(...chunkResults);
      if (i + concurrency < addresses.length) await sleep(BETWEEN_LOOKUP_MS);
    }

    const found = results.filter(r => r.found).length;
    logger.info(`[propwire-enricher] Batch done — ${found}/${results.length} found`);
    return results;
  }
}

// ── Convenience function ──────────────────────────────────────────────────────

export async function lookupPropwireEstimate(address: string): Promise<PropwireEstimate> {
  return new PropwireAddressEnricher().lookup(address);
}