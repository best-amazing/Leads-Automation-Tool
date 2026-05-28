// src/scrapers/redfin/redfin.address-enricher.ts
//
// Stand-alone address → Redfin Estimate lookup.
//
// Mirrors the ZillowAddressEnricher pattern exactly:
//
//   const enricher = new RedfinAddressEnricher();
//   const result   = await enricher.lookup("4433 E 158th St, Cleveland, OH 44128");
//   // → { redfinEstimate: 74500, propertyId: 12345678, url: "...", found: true }
//
// Batch usage:
//   const results = await enricher.lookupBatch(addresses, { concurrency: 2 });
//
// How it works:
//
//   Step 1 — Address → URL path via autocomplete JSON API
//     GET /stingray/do/location-autocomplete
//         ?location=<encoded>&start=0&count=10&v=2&market=<slug>
//         &al=1&iss=false&ooa=true&mrs=false&region_id=NaN&region_type=NaN
//         &includeAddressInfo=false
//     Pick first row where type === "1"; prefer payload.exactMatch.
//     Confirmed working — returns /OH/Cleveland/4433-E-158th-St-44128/home/70800149
//
//   Step 2 — URL path → propertyId via aboveTheFold JSON API
//     GET /stingray/api/home/details/aboveTheFold?path=<urlPath>&accessLevel=1
//     Returns 613 without browser-like headers — headers now applied to ALL
//     stingray endpoints, not just /do/.
//     Fallback: extract propertyId directly from URL path (/home/<id>).
//
//   Step 3 — propertyId → Redfin Estimate via avmHistoricalData JSON API
//     GET /stingray/api/home/details/avmHistoricalData?propertyId=<id>&accessLevel=1
//     NOTE: Many off-market/low-data properties return a valid 200 response
//     with historical sale data but NO predictedValue — Redfin simply has no
//     AVM for them. Parser now checks all known paths including nested ones.
//
//   Step 4 — belowTheFold fallback
//     GET /stingray/api/home/details/belowTheFold?propertyId=<id>&accessLevel=1&pageType=1
//     Also returns 613 without headers — fixed by global header injection.
//
// All stingray endpoints now receive browser-mimicking headers to prevent 613.
//
// Debug artefacts (when REDFIN_ENRICHER_DEBUG=true) → logs/
//   redfin_enricher_autocomplete_<slug>.json
//   redfin_enricher_aboveTheFold_<propertyId>.json
//   redfin_enricher_avm_<propertyId>.json
//   redfin_enricher_btf_<propertyId>.json
// ─────────────────────────────────────────────────────────────────────────────

import * as https from "https";
import * as http  from "http";
import * as zlib  from "zlib";
import * as fs    from "fs";
import * as path  from "path";

import { logger } from "../../utils/logger";
import { sleep  } from "../../utils/browser";

// ── Env / constants ───────────────────────────────────────────────────────────

const OXYLABS_ENDPOINT   = "realtime.oxylabs.io";
const OXYLABS_PATH       = "/v1/queries";
const OXYLABS_USERNAME   = process.env.OXYLABS_USERNAME ?? "";
const OXYLABS_PASSWORD   = process.env.OXYLABS_PASSWORD ?? "";
const REQUEST_TIMEOUT_MS = 90_000;
const BETWEEN_STEP_MS    = 1_200;   // polite gap between sequential API calls
const BETWEEN_LOOKUP_MS  = 2_500;   // polite gap between batch lookups
const DEBUG_SAVE         = process.env.REDFIN_ENRICHER_DEBUG === "true";

const REDFIN_BASE        = "https://www.redfin.com";

// ── Public types ──────────────────────────────────────────────────────────────

export interface RedfinEstimate {
  propertyId:          number | null;
  url:                 string | null;
  /** Redfin AVM estimate (null if not found) */
  redfinEstimate:      number | null;
  redfinEstimateLow:   number | null;
  redfinEstimateHigh:  number | null;
  /** Listed price if on-market (null for off-market) */
  listPrice:           number | null;
  address:             string;       // normalised address Redfin returned
  rawInput:            string;       // original string you passed in
  found:               boolean;
  error?:              string;
}

export interface LookupOptions {
  /** How many addresses to fetch in parallel (default 1 — sequential) */
  concurrency?: number;
}

// ── Address normaliser ────────────────────────────────────────────────────────
//
// Strips county segments before sending to autocomplete.
// Same logic as ZillowAddressEnricher.formatAddressToSlug().

function normaliseAddress(raw: string): string {
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);

  const stateAbbrevRe = /\b[A-Z]{2}\b/;
  const zipRe         = /\b\d{5}\b/;

  const filtered = parts.filter((part, idx) => {
    if (idx === 0)                return true;
    if (stateAbbrevRe.test(part)) return true;
    if (zipRe.test(part))         return true;
    if (/^[A-Za-z\s\-']+$/.test(part) && idx < parts.length - 1) {
      const prevIsCity = idx >= 2 && /^[A-Za-z\s\-']+$/.test(parts[idx - 1]);
      if (prevIsCity) return false;
    }
    return true;
  });

  return filtered.join(", ");
}

// ── Market slug ───────────────────────────────────────────────────────────────

const STATE_TO_MARKET: Record<string, string> = {
  OH: "ohio",        PA: "pennsylvania", MI: "michigan",
  IN: "indiana",     KY: "kentucky",     WV: "westvirginia",
  NY: "newyork",     NJ: "newjersey",    CT: "connecticut",
  MA: "boston",      IL: "chicago",      WI: "wisconsin",
  MN: "minneapolis", MO: "stlouis",      TX: "texas",
  FL: "florida",     GA: "atlanta",      NC: "carolinas",
  SC: "carolinas",   VA: "virginia",     MD: "baltimore",
  DC: "dc",          WA: "seattle",      OR: "oregon",
  CA: "socal",       AZ: "arizona",      CO: "denver",
  NV: "nevada",      UT: "utah",
};

function marketFromAddress(normAddress: string): string {
  const m = normAddress.match(/\b([A-Z]{2})\b/);
  return (m?.[1] && STATE_TO_MARKET[m[1]]) ? STATE_TO_MARKET[m[1]] : "national";
}

// ── URL builders ──────────────────────────────────────────────────────────────

function buildAutocompleteUrl(query: string): string {
  // CORRECT PATH: stingray/do/location-autocomplete  (NOT stingray/api/)
  // Confirmed from live Redfin browser network traffic, May 2025.
  // URLSearchParams must NOT be used — it encodes commas as %2C which breaks
  // Redfin's city/state parsing. Build manually and restore commas.
  const encodedLocation = encodeURIComponent(query)
    .replace(/%2C/g, ",")
    .replace(/%20/g, "+");

  const market = marketFromAddress(query);

  return (
    `${REDFIN_BASE}/stingray/do/location-autocomplete` +
    `?location=${encodedLocation}` +
    `&start=0&count=10&v=2` +
    `&market=${market}` +
    `&al=1&iss=false&ooa=true&mrs=false` +
    `&region_id=NaN&region_type=NaN` +
    `&includeAddressInfo=false`
  );
}

function buildAboveTheFoldUrl(urlPath: string): string {
  const params = new URLSearchParams({ path: urlPath, accessLevel: "1" });
  return `${REDFIN_BASE}/stingray/api/home/details/aboveTheFold?${params.toString()}`;
}

function buildAvmUrl(propertyId: number): string {
  const params = new URLSearchParams({
    propertyId:  String(propertyId),
    accessLevel: "1",
  });
  return `${REDFIN_BASE}/stingray/api/home/details/avmHistoricalData?${params.toString()}`;
}

function buildBelowTheFoldUrl(propertyId: number): string {
  const params = new URLSearchParams({
    propertyId:  String(propertyId),
    accessLevel: "1",
    pageType:    "1",
  });
  return `${REDFIN_BASE}/stingray/api/home/details/belowTheFold?${params.toString()}`;
}

// ── Oxylabs transport ─────────────────────────────────────────────────────────
//
// FIX: Browser-mimicking headers are now applied to ALL stingray endpoints,
// not just /stingray/do/.  The aboveTheFold and belowTheFold endpoints on
// /stingray/api/ were returning 613 without them — same WAF check, different
// path prefix.

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

async function oxylabsFetch(targetUrl: string): Promise<string | null> {
  if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
    logger.error(
      "[redfin-enricher] Oxylabs credentials missing — set OXYLABS_USERNAME / OXYLABS_PASSWORD"
    );
    return null;
  }

  // Apply browser-mimicking headers to ALL Redfin stingray endpoints.
  // Both /stingray/do/ (autocomplete) and /stingray/api/ (aboveTheFold,
  // belowTheFold) return 613 without these. The Referer and X-Requested-With
  // headers are the critical ones Redfin's WAF checks for.
  const payload: Record<string, any> = {
    source:          "universal",
    url:             targetUrl,
    geo_location:    "United States",
    user_agent_type: "desktop_chrome",
    headers: {
      "Referer":           "https://www.redfin.com/",
      "Accept":            "application/json, text/plain, */*",
      "Accept-Language":   "en-US,en;q=0.9",
      "X-Requested-With":  "XMLHttpRequest",
      "Sec-Fetch-Site":    "same-origin",
      "Sec-Fetch-Mode":    "cors",
      "Sec-Fetch-Dest":    "empty",
    },
  };

  const bodyStr = JSON.stringify(payload);
  const authStr = Buffer.from(`${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`).toString("base64");

  const rawResp = await new Promise<{ status: number; body: string }>(
    (resolve, reject) => {
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
            try { dec = encoding ? await decompressBuffer(buf, encoding) : buf; }
            catch { dec = buf; }
            resolve({ status: res.statusCode ?? 0, body: dec.toString("utf-8") });
          });
          res.on("error", reject);
        }
      );

      req.setTimeout(REQUEST_TIMEOUT_MS, () =>
        req.destroy(new Error("Oxylabs request timed out"))
      );
      req.on("error", reject);
      req.write(bodyStr);
      req.end();
    }
  );

  if (rawResp.status === 401) {
    logger.error("[redfin-enricher] Oxylabs 401 — bad credentials");
    throw new Error("OXYLABS_AUTH_FAILED");
  }
  if (rawResp.status === 429) {
    logger.warn("[redfin-enricher] Oxylabs 429 — rate limited, waiting 10s");
    await sleep(10_000);
    return null;
  }
  if (rawResp.status !== 200) {
    logger.warn(`[redfin-enricher] Oxylabs HTTP ${rawResp.status}`);
    return null;
  }

  let envelope: any;
  try { envelope = JSON.parse(rawResp.body); } catch {
    logger.warn("[redfin-enricher] Could not parse Oxylabs envelope");
    return null;
  }

  const result0     = envelope?.results?.[0];
  const innerStatus = result0?.status_code ?? result0?.statusCode ?? 200;
  const content: string = result0?.content ?? result0?.html ?? "";

  logger.debug(
    `[redfin-enricher] inner=${innerStatus} content=${content.length}ch url=${targetUrl}`
  );

  if (innerStatus === 401) throw new Error("OXYLABS_AUTH_FAILED");
  if ([403, 404, 405].includes(innerStatus)) {
    logger.warn(`[redfin-enricher] Inner ${innerStatus} (permanent block) for ${targetUrl}`);
    return null;
  }
  if (innerStatus === 613) {
    // 613 = Oxylabs "site blocked this request".
    // Headers should now prevent this — if it still fires, the Oxylabs IP
    // rotation landed on a flagged exit node.  Caller receives null.
    logger.warn(`[redfin-enricher] Inner 613 for ${targetUrl} — headers may not have been forwarded`);
    return null;
  }
  if (innerStatus === 429) {
    logger.warn("[redfin-enricher] Inner 429 — waiting 10s");
    await sleep(10_000);
    return null;
  }
  if (!content) {
    logger.warn(`[redfin-enricher] Empty content for ${targetUrl}`);
    return null;
  }

  // Guard: HTML page returned instead of JSON
  const sniff = content.trimStart();
  if (sniff.startsWith("<") || sniff.startsWith("<!")) {
    logger.warn(
      `[redfin-enricher] Got HTML instead of JSON (${content.length}ch) for ${targetUrl}`
    );
    return null;
  }

  return content;
}

// ── Redfin XSSI guard stripper ────────────────────────────────────────────────

function stripXssi(raw: string): string {
  return raw.startsWith("{}&&") ? raw.slice(4) : raw;
}

// ── Step 1: autocomplete → listing URL path ───────────────────────────────────
//
// Confirmed response shape (live Redfin traffic, May 2025):
// {}&&{
//   "payload": {
//     "sections": [{ "name": "Addresses", "rows": [{
//       "id": "1_70800149", "type": "1",
//       "name": "4433 E 158th St", "subName": "Cleveland, OH, USA",
//       "url": "/OH/Cleveland/4433-E-158th-St-44128/home/70800149",
//       "urlV2": "/OH/Cleveland/4433-E-158th-St-44128/home/70800149"
//     }]}],
//     "exactMatch": { "type": "1", "urlV2": "/OH/Cleveland/...", ... }
//   }
// }
//
// Priority: exactMatch (type "1") → first sections row (type "1")
// Display name built from name + subName (", USA" stripped).

function rowToResult(row: any): { urlPath: string; name: string } {
  const urlPath = (row.urlV2 ?? row.url) as string;
  const subName = (row.subName as string ?? "").replace(/,\s*USA$/i, "").trim();
  const name    = [row.name, subName].filter(Boolean).join(", ");
  return { urlPath, name };
}

function parseAutocomplete(raw: string): { urlPath: string | null; name: string | null } {
  let json: any;
  try { json = JSON.parse(stripXssi(raw)); } catch {
    logger.warn("[redfin-enricher] Could not parse autocomplete response");
    return { urlPath: null, name: null };
  }

  const payload = json?.payload ?? {};

  // Priority 1: exactMatch
  const exact = payload?.exactMatch;
  if (exact && String(exact?.type) === "1" && (exact?.urlV2 ?? exact?.url)) {
    const result = rowToResult(exact);
    logger.debug(`[redfin-enricher] autocomplete exactMatch → ${result.urlPath}`);
    return result;
  }

  // Priority 2: first type "1" row in sections
  for (const section of (payload?.sections ?? [])) {
    for (const row of (section?.rows ?? [])) {
      if (String(row?.type) === "1" && (row?.urlV2 ?? row?.url)) {
        const result = rowToResult(row);
        logger.debug(`[redfin-enricher] autocomplete section row → ${result.urlPath}`);
        return result;
      }
    }
  }

  logger.debug("[redfin-enricher] No address-type (type=1) row in autocomplete response");
  return { urlPath: null, name: null };
}

// ── Step 2: aboveTheFold → propertyId ────────────────────────────────────────

function parseAboveTheFold(raw: string): number | null {
  let json: any;
  try { json = JSON.parse(stripXssi(raw)); } catch {
    logger.warn("[redfin-enricher] Could not parse aboveTheFold response");
    return null;
  }

  const payload = json?.payload ?? json;
  const id =
    payload?.propertyId                ??
    payload?.addressInfo?.propertyId   ??
    payload?.mainHouseInfo?.propertyId ??
    null;

  if (id == null) {
    logger.debug(
      `[redfin-enricher] propertyId not found in aboveTheFold — keys: ` +
      Object.keys(payload ?? {}).join(", ")
    );
  }

  return id != null ? Number(id) : null;
}

// ── Step 3: avmHistoricalData → Redfin Estimate ───────────────────────────────
//
// The avmHistoricalData endpoint returns a valid 200 for all properties, but
// many off-market / low-data-area properties have NO predictedValue at all.
// The payload in that case only contains: avmUpdateDate, saleHistory,
// yearBuilt, propertyTimeSeries, postalCodeTimeSeries, cityTimeSeries,
// countyTimeSeries — no AVM estimate exists on Redfin's side.
//
// Known paths where the estimate CAN appear:
//   payload.predictedValue
//   payload.avmDetails.predictedValue
//   payload.payload.predictedValue       (double-wrapped)
//   payload.estimatedValue
//   payload.homeInfo.predictedValue      (newer layout)
//   payload.avm.predictedValue

interface AvmBlock {
  estimate:  number | null;
  low:       number | null;
  high:      number | null;
  listPrice: number | null;
}

function parseAvmHistoricalData(raw: string, label: string): AvmBlock {
  const empty: AvmBlock = { estimate: null, low: null, high: null, listPrice: null };

  let json: any;
  try { json = JSON.parse(stripXssi(raw)); } catch {
    logger.warn(`[redfin-enricher] Could not parse avmHistoricalData for ${label}`);
    return empty;
  }

  // Handle double-wrapped payload (seen in some markets)
  const payload = json?.payload?.payload ?? json?.payload ?? json;
  const avm     = payload?.avmDetails ?? payload?.avm ?? {};

  const estimate = resolveAmount(
    payload?.predictedValue     ??
    avm?.predictedValue         ??
    payload?.estimatedValue     ??
    payload?.homeInfo?.predictedValue ??
    null
  );

  const low = resolveAmount(
    payload?.predictedValueLow  ??
    avm?.predictedValueLow      ??
    null
  );

  const high = resolveAmount(
    payload?.predictedValueHigh ??
    avm?.predictedValueHigh     ??
    null
  );

  const listPrice = resolveAmount(payload?.listPrice ?? payload?.price ?? null);

  if (estimate == null) {
    // Log all top-level keys so we can see if a new path appears in the future
    logger.debug(
      `[redfin-enricher] avmHistoricalData: no estimate for ${label} — ` +
      `payload keys: ${Object.keys(payload ?? {}).join(", ")}`
    );
  }

  return { estimate, low, high, listPrice };
}

// ── Step 4: belowTheFold → Redfin Estimate (fallback) ────────────────────────
//
// Known paths:
//   payload.avm.predictedValue
//   payload.avm.estimatedValue
//   payload.avmData.predictedValue
//   payload.publicRecordsInfo.estimatedValue
//   payload.listingInfo.listPrice  (on-market only)

function parseBelowTheFold(raw: string, label: string): AvmBlock {
  const empty: AvmBlock = { estimate: null, low: null, high: null, listPrice: null };

  let json: any;
  try { json = JSON.parse(stripXssi(raw)); } catch {
    logger.warn(`[redfin-enricher] Could not parse belowTheFold for ${label}`);
    return empty;
  }

  const payload = json?.payload?.payload ?? json?.payload ?? json;
  const avm     = payload?.avm ?? payload?.avmData ?? {};
  const pubRec  = payload?.publicRecordsInfo ?? {};

  const estimate = resolveAmount(
    avm?.predictedValue        ??
    avm?.estimatedValue        ??
    pubRec?.estimatedValue     ??
    payload?.predictedValue    ??
    null
  );

  const low      = resolveAmount(avm?.predictedValueLow  ?? null);
  const high     = resolveAmount(avm?.predictedValueHigh ?? null);
  const listPrice = resolveAmount(
    payload?.listingInfo?.listPrice ??
    payload?.listPrice              ??
    payload?.price                  ??
    null
  );

  if (estimate == null) {
    logger.debug(
      `[redfin-enricher] belowTheFold: no estimate for ${label} — ` +
      `payload keys: ${Object.keys(payload ?? {}).join(", ")}`
    );
  }

  return { estimate, low, high, listPrice };
}

// ── Shared amount resolver ────────────────────────────────────────────────────

function resolveAmount(val: any): number | null {
  if (val == null)             return null;
  if (typeof val === "number") return val > 0 ? val : null;
  if (typeof val === "string") {
    const n = parseFloat(val.replace(/[^0-9.]/g, ""));
    return isNaN(n) || n <= 0 ? null : n;
  }
  if (typeof val === "object" && val.amount != null) return resolveAmount(val.amount);
  return null;
}

// ── Debug helpers ─────────────────────────────────────────────────────────────

function debugSave(filename: string, content: string): void {
  if (!DEBUG_SAVE) return;
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, "utf-8");
  } catch { /* non-fatal */ }
}

function slugify(s: string): string {
  return s.replace(/[^a-z0-9]+/gi, "_").slice(0, 60).toLowerCase();
}

// ── RedfinAddressEnricher ─────────────────────────────────────────────────────

export class RedfinAddressEnricher {

  async lookup(rawAddress: string): Promise<RedfinEstimate> {
    logger.info(`\n[redfin-enricher] ═══════════════════════════════════════════════`);
    logger.info(`[redfin-enricher] 📍 Processing address: "${rawAddress}"`);

    const normAddress = normaliseAddress(rawAddress);
    logger.info(`[redfin-enricher]   ✓ Normalised: "${normAddress}"`);

    const base: Omit<RedfinEstimate, "found" | "error"> = {
      propertyId:         null,
      url:                null,
      redfinEstimate:     null,
      redfinEstimateLow:  null,
      redfinEstimateHigh: null,
      listPrice:          null,
      address:            rawAddress,
      rawInput:           rawAddress,
    };

    // ── Step 1: autocomplete → URL path ───────────────────────────────────

    const autocompleteUrl = buildAutocompleteUrl(normAddress);
    logger.info(`[redfin-enricher]   Step 1 → ${autocompleteUrl}`);

    let urlPath: string | null      = null;
    let matchedName: string | null  = null;

    try {
      const raw = await oxylabsFetch(autocompleteUrl);
      if (!raw) {
        logger.warn(
          `[redfin-enricher] No autocomplete response for "${rawAddress}"\n` +
          `[redfin-enricher]   URL: ${autocompleteUrl}`
        );
        return { ...base, found: false, error: "no_autocomplete_response" };
      }
      debugSave(`redfin_enricher_autocomplete_${slugify(normAddress)}.json`, raw);
      ({ urlPath, name: matchedName } = parseAutocomplete(raw));
    } catch (err: any) {
      if (err?.message === "OXYLABS_AUTH_FAILED") throw err;
      logger.warn(`[redfin-enricher] Autocomplete error: ${err}`);
      return { ...base, found: false, error: "autocomplete_error" };
    }

    if (!urlPath) {
      logger.warn(`[redfin-enricher] ✗ Address not found in Redfin: "${rawAddress}"`);
      return { ...base, found: false, error: "address_not_found" };
    }

    const fullUrl = `${REDFIN_BASE}${urlPath}`;
    logger.info(`[redfin-enricher]   ✓ Matched: "${matchedName}" → ${fullUrl}`);
    await sleep(BETWEEN_STEP_MS);

    // ── Step 2: aboveTheFold → propertyId ─────────────────────────────────

    const aboveTheFoldUrl = buildAboveTheFoldUrl(urlPath);
    logger.info(`[redfin-enricher]   Step 2 → ${aboveTheFoldUrl}`);

    let propertyId: number | null = null;

    try {
      const raw = await oxylabsFetch(aboveTheFoldUrl);
      if (raw) {
        debugSave(`redfin_enricher_aboveTheFold_${slugify(urlPath)}.json`, raw);
        propertyId = parseAboveTheFold(raw);
      } else {
        logger.warn(`[redfin-enricher] No aboveTheFold response — falling back to URL extraction`);
      }
    } catch (err: any) {
      if (err?.message === "OXYLABS_AUTH_FAILED") throw err;
      logger.warn(`[redfin-enricher] aboveTheFold error: ${err}`);
    }

    // Fallback: extract propertyId from URL path /home/<id>
    if (propertyId == null) {
      const pidMatch = urlPath.match(/\/home\/(\d+)/);
      if (pidMatch) {
        propertyId = Number(pidMatch[1]);
        logger.info(`[redfin-enricher]   ✓ propertyId from URL fallback: ${propertyId}`);
      } else {
        logger.warn(`[redfin-enricher] ✗ Could not resolve propertyId for "${rawAddress}"`);
        return { ...base, url: fullUrl, found: false, error: "no_property_id" };
      }
    } else {
      logger.info(`[redfin-enricher]   ✓ propertyId: ${propertyId}`);
    }

    await sleep(BETWEEN_STEP_MS);

    // ── Step 3: avmHistoricalData → Redfin Estimate ────────────────────────

    const avmUrl = buildAvmUrl(propertyId);
    logger.info(`[redfin-enricher]   Step 3 → ${avmUrl}`);

    let avm: AvmBlock = { estimate: null, low: null, high: null, listPrice: null };

    try {
      const raw = await oxylabsFetch(avmUrl);
      if (raw) {
        debugSave(`redfin_enricher_avm_${propertyId}.json`, raw);
        avm = parseAvmHistoricalData(raw, rawAddress);
      } else {
        logger.warn(`[redfin-enricher] No avmHistoricalData response for "${rawAddress}"`);
      }
    } catch (err: any) {
      if (err?.message === "OXYLABS_AUTH_FAILED") throw err;
      logger.warn(`[redfin-enricher] avmHistoricalData error: ${err}`);
    }

    if (avm.estimate != null) {
      logger.info(
        `[redfin-enricher]   ✓ Redfin Estimate (avmHistoricalData): $${avm.estimate.toLocaleString()}`
      );
    } else {
      logger.debug(`[redfin-enricher]   avmHistoricalData: no estimate — trying belowTheFold`);
      await sleep(BETWEEN_STEP_MS);

      // ── Step 4: belowTheFold fallback ──────────────────────────────────

      const btfUrl = buildBelowTheFoldUrl(propertyId);
      logger.info(`[redfin-enricher]   Step 4 → ${btfUrl}`);

      try {
        const raw = await oxylabsFetch(btfUrl);
        if (raw) {
          debugSave(`redfin_enricher_btf_${propertyId}.json`, raw);
          avm = parseBelowTheFold(raw, rawAddress);
        } else {
          logger.warn(`[redfin-enricher] No belowTheFold response for "${rawAddress}"`);
        }
      } catch (err: any) {
        if (err?.message === "OXYLABS_AUTH_FAILED") throw err;
        logger.warn(`[redfin-enricher] belowTheFold error: ${err}`);
      }

      if (avm.estimate != null) {
        logger.info(
          `[redfin-enricher]   ✓ Redfin Estimate (belowTheFold): $${avm.estimate.toLocaleString()}`
        );
      } else {
        // Property exists on Redfin but has no AVM — common for off-market /
        // low-transaction-volume areas. Return found:false with propertyId and
        // url populated so callers can still use the Redfin URL.
        logger.warn(
          `[redfin-enricher] ✗ No Redfin Estimate for "${rawAddress}" — ` +
          `property exists (id=${propertyId}) but Redfin has no AVM data`
        );
        return {
          ...base,
          propertyId,
          url:       fullUrl,
          listPrice: avm.listPrice,
          address:   matchedName ?? rawAddress,
          found:     false,
          error:     "estimate_not_found",
        };
      }
    }

    // ── Success ────────────────────────────────────────────────────────────

    logger.info(`[redfin-enricher] ✓ Redfin match found!`);
    logger.info(`[redfin-enricher]   propertyId: ${propertyId}`);
    logger.info(`[redfin-enricher]   estimate:   $${avm.estimate!.toLocaleString()}`);
    logger.info(
      `[redfin-enricher]   range:      ` +
      `${avm.low  != null ? "$" + avm.low.toLocaleString()  : "?"} – ` +
      `${avm.high != null ? "$" + avm.high.toLocaleString() : "?"}`
    );
    logger.info(`[redfin-enricher]   address:    ${matchedName ?? rawAddress}`);
    logger.info(`[redfin-enricher] ═══════════════════════════════════════════════\n`);

    return {
      propertyId,
      url:                fullUrl,
      redfinEstimate:     avm.estimate,
      redfinEstimateLow:  avm.low,
      redfinEstimateHigh: avm.high,
      listPrice:          avm.listPrice,
      address:            matchedName ?? rawAddress,
      rawInput:           rawAddress,
      found:              true,
    };
  }

  async lookupBatch(
    addresses: string[],
    options:   LookupOptions = {}
  ): Promise<RedfinEstimate[]> {
    const concurrency = Math.max(1, options.concurrency ?? 1);
    const results: RedfinEstimate[] = [];

    for (let i = 0; i < addresses.length; i += concurrency) {
      const chunk = addresses.slice(i, i + concurrency);

      logger.info(
        `[redfin-enricher] Batch chunk ` +
        `${Math.floor(i / concurrency) + 1} / ` +
        `${Math.ceil(addresses.length / concurrency)} ` +
        `(${chunk.length} address(es))`
      );

      const chunkResults = await Promise.all(chunk.map(a => this.lookup(a)));
      results.push(...chunkResults);

      if (i + concurrency < addresses.length) {
        await sleep(BETWEEN_LOOKUP_MS);
      }
    }

    const found = results.filter(r => r.found).length;
    logger.info(`[redfin-enricher] Batch done — ${found}/${results.length} found`);
    return results;
  }
}

// ── Convenience function ──────────────────────────────────────────────────────

export async function lookupRedfinEstimate(address: string): Promise<RedfinEstimate> {
  return new RedfinAddressEnricher().lookup(address);
}