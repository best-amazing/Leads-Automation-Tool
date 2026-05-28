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
// How it works (three-step, same as RedfinScraper Phase 2):
//
//   Step 1 — Address → propertyId via autocomplete JSON API
//     GET /stingray/do/location-autocomplete
//         ?location=<encoded>&start=0&count=10&v=2&market=<slug>
//         &al=1&iss=false&ooa=true&mrs=false&region_id=NaN&region_type=NaN
//         &includeAddressInfo=false
//     Returns a ranked list of matches.  We pick the first row where type === "1"
//     (address/property) and extract its url path.
//
//     Note: the autocomplete "id" field is NOT the same integer used by
//     avmHistoricalData.  We need the "propertyId" from a subsequent GIS
//     lookup OR we use the /stingray/api/home/details/aboveTheFold endpoint
//     with the URL path to resolve the final propertyId.
//
//     Simplified flow actually used:
//       a. autocomplete → get listing URL path  (e.g. /OH/Cleveland/4433-E-158th-St-44128/home/70800149)
//       b. aboveTheFold (render:false) with url path → get propertyId
//       c. avmHistoricalData (render:false) with propertyId → get estimate
//       d. belowTheFold     (render:false) fallback if Step c returns nothing
//
//   Step 2 — propertyId → Redfin Estimate via avmHistoricalData JSON API
//     GET /stingray/api/home/details/avmHistoricalData?propertyId=<id>&accessLevel=1
//     Same endpoint used by RedfinScraper Phase 2 Step A.
//
//   Step 3 — belowTheFold fallback
//     GET /stingray/api/home/details/belowTheFold?propertyId=<id>&accessLevel=1&pageType=1
//     Same as RedfinScraper Phase 2 Step B.
//
// All three endpoints bypass Redfin's WAF — render:false, plain JSON GETs
// forwarded by Oxylabs without spinning up a browser.
//
// AVM parsing is delegated to redfin.parser (shared with RedfinScraper) to
// ensure both consumers stay in sync when the API response shape changes.
// The parser's parseAvmHistoricalData priority order (verified May 2026):
//   1. payload.propertyTimeSeries[last]   ← actual current API format
//   2. payload.predictedValue
//   3. payload.avmValue / currentValue
//   4. payload.avmHistory[last]           ← older format fallback
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
import {
  parseAvmHistoricalData,
  parseBelowTheFold,
  buildAvmUrl,
  buildBelowTheFoldUrl,
  stripXSSI,
} from "./redfin.parser";

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
  redfinEstimateLow?:  number | null;
  redfinEstimateHigh?: number | null;
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

// ── Address formatter ─────────────────────────────────────────────────────────
//
// Redfin's autocomplete API is tolerant of messy input, but we lightly
// normalise the address before sending it:
//   • strip county segments (same logic as ZillowAddressEnricher)
//   • collapse extra whitespace
//   • keep commas — the autocomplete endpoint handles them fine

function normaliseAddress(raw: string): string {
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean);

  const stateAbbrevRe = /\b[A-Z]{2}\b/;
  const zipRe         = /\b\d{5}\b/;

  const filtered = parts.filter((part, idx) => {
    if (idx === 0)                return true;  // street — always keep
    if (stateAbbrevRe.test(part)) return true;  // contains state abbrev
    if (zipRe.test(part))         return true;  // contains ZIP
    // Purely alpha segment between city and state → likely county name → drop
    if (/^[A-Za-z\s\-']+$/.test(part) && idx < parts.length - 1) {
      const prevIsCity = idx >= 2 && /^[A-Za-z\s\-']+$/.test(parts[idx - 1]);
      if (prevIsCity) return false;
    }
    return true;
  });

  return filtered.join(", ");
}

// ── Market name → Redfin market slug ─────────────────────────────────────────
//
// Redfin's autocomplete uses the `market` param for result ranking.
// Wrong value degrades ranking but does NOT cause a 404 or empty result.

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

// ── URL / path builders ───────────────────────────────────────────────────────

function buildAutocompleteUrl(query: string): string {
  // CORRECT PATH: stingray/do/location-autocomplete  (NOT stingray/api/)
  // Confirmed from live Redfin browser network traffic, May 2025.
  //
  // Params (all present in real browser requests):
  //   location          — search string; commas must NOT be percent-encoded
  //   start=0           — pagination offset
  //   count=10          — max rows to return
  //   v=2               — response format version
  //   market=<slug>     — state/metro slug for result ranking
  //   al=1              — include address-level (type "1") rows
  //   iss=false         — disable instant-search suggestions
  //   ooa=true          — include off-market / out-of-area addresses
  //   mrs=false         — disable mortgage-rate suggestions
  //   region_id=NaN     — sent by browser when no region is pre-selected
  //   region_type=NaN   — same
  //   includeAddressInfo=false — we resolve address detail via aboveTheFold
  //
  // NOTE: URLSearchParams encodes commas as %2C which breaks city/state
  // parsing — build the query string manually instead.
  const encodedLocation = encodeURIComponent(query)
    .replace(/%2C/g, ",")   // restore commas
    .replace(/%20/g, "+");  // spaces as +

  const market = marketFromAddress(query);

  return (
    `${REDFIN_BASE}/stingray/do/location-autocomplete` +
    `?location=${encodedLocation}` +
    `&start=0` +
    `&count=10` +
    `&v=2` +
    `&market=${market}` +
    `&al=1` +
    `&iss=false` +
    `&ooa=true` +
    `&mrs=false` +
    `&region_id=NaN` +
    `&region_type=NaN` +
    `&includeAddressInfo=false`
  );
}

function buildAboveTheFoldUrl(urlPath: string): string {
  // urlPath is like /OH/Cleveland/4433-E-158th-St-44128/home/70800149
  const params = new URLSearchParams({ path: urlPath, accessLevel: "1" });
  return `${REDFIN_BASE}/stingray/api/home/details/aboveTheFold?${params.toString()}`;
}

// ── Oxylabs transport ─────────────────────────────────────────────────────────
//
// All Redfin stingray endpoints are plain JSON — no WAF, no browser needed.
// render:false keeps requests fast and avoids browser spin-up costs.

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

  // Log only the Oxylabs username and a masked password for debugging.
  logger.info(
    `[redfin-enricher] Oxylabs auth user=${OXYLABS_USERNAME} pass=${OXYLABS_PASSWORD ? "***" : "MISSING"}`
  );

  // Redfin's autocomplete endpoint (stingray/do/) checks for browser-like
  // headers and returns Oxylabs error 613 (site blocked) when they're absent.
  // We inject headers that mimic a real Chrome XHR request:
  //   Referer    — must look like it came from a Redfin search page
  //   Accept     — JSON XHR accept header
  //   X-Requested-With — standard XHR marker Redfin checks for on /do/ endpoints
  //
  // The other stingray endpoints (/api/gis, /api/home/details/*) don't need
  // these — they sit behind a different path prefix with no bot check.
  const isAutocomplete = targetUrl.includes("/stingray/do/");
  const payload: Record<string, any> = {
    source:          "universal",
    url:             targetUrl,
    // render:false — all stingray endpoints are plain JSON, no browser needed
    geo_location:    "United States",
    user_agent_type: "desktop_chrome",
    ...(isAutocomplete ? {
      headers: {
        "Referer":           "https://www.redfin.com/",
        "Accept":            "application/json, text/plain, */*",
        "Accept-Language":   "en-US,en;q=0.9",
        "X-Requested-With":  "XMLHttpRequest",
        "Sec-Fetch-Site":    "same-origin",
        "Sec-Fetch-Mode":    "cors",
        "Sec-Fetch-Dest":    "empty",
      },
    } : {}),
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
    // 613 = Oxylabs "target blocked this request" — often transient (IP flagged).
    // Headers fix above should prevent this for autocomplete; if it still fires,
    // the caller will see null and can retry or fall back.
    logger.warn(
      `[redfin-enricher] Inner 613 (Oxylabs blocked by target) for ${targetUrl}\n` +
      `[redfin-enricher]   This is usually a missing/wrong header. ` +
      `Check Referer and X-Requested-With are set for /stingray/do/ endpoints.`
    );
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

  // Guard: if Redfin returned an HTML page instead of JSON (can happen when
  // the endpoint path is wrong or the request is blocked), bail out before
  // the caller tries to JSON.parse it and emits a misleading parse error.
  const sniff = content.trimStart();
  if (sniff.startsWith("<") || sniff.startsWith("<!")) {
    logger.warn(
      `[redfin-enricher] Got HTML instead of JSON (${content.length}ch) for ${targetUrl} — ` +
      `inner=${innerStatus}. Check endpoint path and params.`
    );
    return null;
  }

  return content;
}

// ── Step 1: autocomplete → listing URL path ───────────────────────────────────
//
// Response shape (after XSSI strip):
// {
//   "payload": {
//     "sections": [
//       {
//         "rows": [
//           {
//             "id": "...",
//             "type": "1",      // 1 = address / property
//             "url": "/OH/Cleveland/4433-E-158th-St-44128/home/70800149",
//             "name": "4433 E 158th St, Cleveland, OH 44128",
//             ...
//           }
//         ]
//       }
//     ]
//   }
// }
//
// We pick the first row where type === "1" (address result) and return its url.

function parseAutocomplete(raw: string): {
  urlPath:  string | null;
  name:     string | null;
} {
  let json: any;
  try { json = JSON.parse(stripXSSI(raw)); } catch {
    logger.warn("[redfin-enricher] Could not parse autocomplete response");
    return { urlPath: null, name: null };
  }

  const sections: any[] = json?.payload?.sections ?? [];
  for (const section of sections) {
    for (const row of (section?.rows ?? [])) {
      // type "1" = property/address match; "2" = city; "3" = zip; etc.
      if (String(row?.type) === "1" && row?.url) {
        return { urlPath: row.url as string, name: row.name ?? null };
      }
    }
  }

  logger.debug("[redfin-enricher] No address-type row in autocomplete response");
  return { urlPath: null, name: null };
}

// ── Step 2: aboveTheFold → propertyId ────────────────────────────────────────
//
// We only need the propertyId from this payload — everything else is ignored.
// Known paths (Redfin has been consistent here since 2022):
//
//   payload.propertyId
//   payload.addressInfo.propertyId
//   payload.mainHouseInfo.propertyId

function parseAboveTheFold(raw: string): number | null {
  let json: any;
  try { json = JSON.parse(stripXSSI(raw)); } catch {
    logger.warn("[redfin-enricher] Could not parse aboveTheFold response");
    return null;
  }

  const payload = json?.payload ?? json;

  const id =
    payload?.propertyId                   ??
    payload?.addressInfo?.propertyId      ??
    payload?.mainHouseInfo?.propertyId    ??
    null;

  if (id == null) {
    logger.debug(
      `[redfin-enricher] propertyId not found — aboveTheFold keys: ` +
      Object.keys(payload ?? {}).join(", ")
    );
  }

  return id != null ? Number(id) : null;
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

  // ── Single address lookup ─────────────────────────────────────────────────

  async lookup(rawAddress: string): Promise<RedfinEstimate> {
    logger.info(`\n[redfin-enricher] ═══════════════════════════════════════════════`);
    logger.info(`[redfin-enricher] 📍 Processing address: "${rawAddress}"`);

    const normAddress = normaliseAddress(rawAddress);
    logger.info(`[redfin-enricher]   ✓ Normalised: "${normAddress}"`);

    const base: Omit<RedfinEstimate, "found" | "error"> = {
      propertyId:     null,
      url:            null,
      redfinEstimate: null,
      listPrice:      null,
      address:        rawAddress,
      rawInput:       rawAddress,
    };

    // ── Step 1: autocomplete → listing URL path ────────────────────────────

    const autocompleteUrl = buildAutocompleteUrl(normAddress);
    logger.info(`[redfin-enricher]   Step 1 → ${autocompleteUrl}`);

    let urlPath: string | null = null;
    let matchedName: string | null = null;

    try {
      const raw = await oxylabsFetch(autocompleteUrl);
      if (!raw) {
        logger.warn(
          `[redfin-enricher] Autocomplete returned no usable JSON for "${rawAddress}"\n` +
          `[redfin-enricher]   URL was: ${autocompleteUrl}\n` +
          `[redfin-enricher]   Try: curl -s "${autocompleteUrl}" | head -c 300`
        );
        return { ...base, found: false, error: "no_autocomplete_response" };
      }
      debugSave(`redfin_enricher_autocomplete_${slugify(normAddress)}.json`, raw);
      const parsed = parseAutocomplete(raw);
      urlPath      = parsed.urlPath;
      matchedName  = parsed.name;
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
        logger.warn(`[redfin-enricher] No aboveTheFold response for "${rawAddress}"`);
      }
    } catch (err: any) {
      if (err?.message === "OXYLABS_AUTH_FAILED") throw err;
      logger.warn(`[redfin-enricher] aboveTheFold error: ${err}`);
    }

    if (propertyId == null) {
      // Try extracting from the URL path itself as last resort
      // URL pattern: /home/<propertyId>  e.g. /home/70800149
      const pidMatch = urlPath.match(/\/home\/(\d+)/);
      if (pidMatch) {
        propertyId = Number(pidMatch[1]);
        logger.info(`[redfin-enricher]   ✓ propertyId from URL: ${propertyId}`);
      } else {
        logger.warn(`[redfin-enricher] ✗ Could not resolve propertyId for "${rawAddress}"`);
        return { ...base, url: fullUrl, found: false, error: "no_property_id" };
      }
    } else {
      logger.info(`[redfin-enricher]   ✓ propertyId: ${propertyId}`);
    }

    await sleep(BETWEEN_STEP_MS);

    // ── Step 3: avmHistoricalData → Redfin Estimate ────────────────────────
    //
    // Delegates to redfin.parser.parseAvmHistoricalData — shared with
    // RedfinScraper Phase 2 Step A.  Priority order (May 2026):
    //   1. payload.propertyTimeSeries[last]
    //   2. payload.predictedValue / avmValue / currentValue
    //   3. payload.avmHistory[last] (older format)

    const avmUrl = buildAvmUrl(propertyId);
    logger.info(`[redfin-enricher]   Step 3 → ${avmUrl}`);

    let estimate: number | undefined;
    let listPrice: number | null = null;

    try {
      const raw = await oxylabsFetch(avmUrl);
      if (raw) {
        debugSave(`redfin_enricher_avm_${propertyId}.json`, raw);
        ({ redfinEstimate: estimate } = parseAvmHistoricalData(raw, rawAddress));
      } else {
        logger.warn(`[redfin-enricher] No avmHistoricalData response for "${rawAddress}"`);
      }
    } catch (err: any) {
      if (err?.message === "OXYLABS_AUTH_FAILED") throw err;
      logger.warn(`[redfin-enricher] avmHistoricalData error: ${err}`);
    }

    if (estimate != null) {
      logger.info(
        `[redfin-enricher]   ✓ Redfin Estimate (avmHistoricalData): $${estimate.toLocaleString()}`
      );
    } else {
      logger.debug(`[redfin-enricher]   avmHistoricalData: no estimate — trying belowTheFold`);
      await sleep(BETWEEN_STEP_MS);

      // ── Step 4: belowTheFold fallback ──────────────────────────────────
      //
      // Delegates to redfin.parser.parseBelowTheFold — shared with
      // RedfinScraper Phase 2 Step B.  Priority order:
      //   1. payload.listingInfo.redfinEstimate.value
      //   2. payload.mediaBrowserInfo.virtualTourInfo.avmInfo.predictedValue
      //   3. payload.publicRecordsInfo.basicInfo.propertyLastSoldPrice

      const btfUrl = buildBelowTheFoldUrl(propertyId);
      logger.info(`[redfin-enricher]   Step 4 → ${btfUrl}`);

      try {
        const raw = await oxylabsFetch(btfUrl);
        if (raw) {
          debugSave(`redfin_enricher_btf_${propertyId}.json`, raw);
          ({ redfinEstimate: estimate } = parseBelowTheFold(raw, rawAddress));
        } else {
          logger.warn(`[redfin-enricher] No belowTheFold response for "${rawAddress}"`);
        }
      } catch (err: any) {
        if (err?.message === "OXYLABS_AUTH_FAILED") throw err;
        logger.warn(`[redfin-enricher] belowTheFold error: ${err}`);
      }

      if (estimate != null) {
        logger.info(
          `[redfin-enricher]   ✓ Redfin Estimate (belowTheFold): $${estimate.toLocaleString()}`
        );
      } else {
        logger.warn(`[redfin-enricher] ✗ No Redfin Estimate found for "${rawAddress}"`);
        return {
          ...base,
          propertyId,
          url:       fullUrl,
          listPrice,
          address:   matchedName ?? rawAddress,
          found:     false,
          error:     "estimate_not_found",
        };
      }
    }

    // ── Success ────────────────────────────────────────────────────────────

    logger.info(`[redfin-enricher] ✓ Redfin match found!`);
    logger.info(`[redfin-enricher]   propertyId: ${propertyId}`);
    logger.info(`[redfin-enricher]   estimate:   $${estimate!.toLocaleString()}`);
    logger.info(`[redfin-enricher]   address:    ${matchedName ?? rawAddress}`);
    logger.info(`[redfin-enricher] ═══════════════════════════════════════════════\n`);

    return {
      propertyId,
      url:            fullUrl,
      redfinEstimate: estimate!,
      redfinEstimateLow: null,
      redfinEstimateHigh: null,
      listPrice,
      address:        matchedName ?? rawAddress,
      rawInput:       rawAddress,
      found:          true,
    };
  }

  // ── Batch lookup ──────────────────────────────────────────────────────────
  //
  // Runs addresses in chunks of `concurrency` (default 1).
  // Within each chunk requests are parallel; chunks are sequential with a
  // polite delay between them.

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
//
// For one-off calls without instantiating the class:
//   import { lookupRedfinEstimate } from "./redfin.address-enricher";
//   const est = await lookupRedfinEstimate("4433 E 158th St, Cleveland, OH 44128");

export async function lookupRedfinEstimate(address: string): Promise<RedfinEstimate> {
  return new RedfinAddressEnricher().lookup(address);
}