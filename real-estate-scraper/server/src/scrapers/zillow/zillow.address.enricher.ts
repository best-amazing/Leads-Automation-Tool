// src/scrapers/zillow/zillow.address-enricher.ts
//
// Stand-alone address → Zestimate lookup.
//
// Usage (one-off):
//   const enricher = new ZillowAddressEnricher();
//   const result   = await enricher.lookup("1657 Sullivant Avenue, Columbus, Franklin, OH 43223");
//   // → { zestimate: 87400, zestimateLow: 79000, zestimateHigh: 96000, zpid: "12345678", url: "..." }
//
// Usage (batch — e.g. from a LoopNet import):
//   const results = await enricher.lookupBatch(loopnetAddresses, { concurrency: 2 });
//
// How it works:
//   1. formatAddressToSlug()  — strips the county segment, normalises the
//      string into Zillow's  "1657-Sullivant-Avenue-Columbus-OH-43223" slug.
//   2. buildZillowDetailUrl() — wraps the slug in the standard _rb/ path.
//   3. oxylabsFetch()         — same Oxylabs client used by ZillowScraper.
//   4. extractZestimate()     — pulls the value from __NEXT_DATA__ trying
//      every known path in priority order.
//
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
const BETWEEN_LOOKUP_MS  = 2_500;   // polite gap between batch requests
const DEBUG_SAVE         = process.env.ZILLOW_ENRICHER_DEBUG === "true";

// ── Public types ──────────────────────────────────────────────────────────────

export interface ZillowEstimate {
  zpid:           string | null;
  url:            string;
  /** Best-guess AVM from Zillow (null if not found) */
  zestimate:      number | null;
  zestimateLow:   number | null;
  zestimateHigh:  number | null;
  /** Zillow-listed price (null for off-market / pre-foreclosure) */
  listPrice:      number | null;
  address:        string;       // normalised address Zillow returned
  rawInput:       string;       // original string you passed in
  found:          boolean;
  error?:         string;
}

export interface LookupOptions {
  /** How many addresses to fetch in parallel (default 1 — sequential) */
  concurrency?: number;
}

// ── Address formatter ─────────────────────────────────────────────────────────
//
// Input:  "1657 Sullivant Avenue, Columbus, Franklin, OH 43223"
//         "742 Evergreen Terrace, Springfield, IL 62701"
//         "100 Main St Columbus OH 43215"
//
// Output: "1657-Sullivant-Avenue-Columbus-OH-43223"
//
// Rules:
//   • Split on comma or 2+ spaces
//   • Drop segments that look like US counties (a word followed by " County"
//     or a bare county name sandwiched between a city and a state token)
//   • Drop anything that is ONLY alphabetic AND is between the city and
//     state tokens — that's usually a county name like "Franklin"
//   • Join remaining parts, replace whitespace with hyphens, strip unsafe chars

function formatAddressToSlug(raw: string): string {
  // ── 1. Split into coarse parts on comma boundaries ────────────────────────
  const commaParts = raw.split(",").map(s => s.trim()).filter(Boolean);
  logger.debug(`[zillow-enricher] formatAddressToSlug input: "${raw}"`);
  logger.debug(`[zillow-enricher]   Stage 1 - Split on commas: [${commaParts.map(p => `"${p}"`).join(", ")}]`);

  // ── 2. Detect and drop county-like tokens ─────────────────────────────────
  //
  // Zillow URLs never include county.  A county segment looks like one of:
  //   • "Franklin"           (bare county name, all letters, between city + state)
  //   • "Franklin County"    (explicit suffix)
  //   • "Franklin Co"
  //
  // Strategy: after the first part (street address) we look for a segment that
  // is purely alphabetic (no digits) AND does NOT contain a US state abbreviation
  // AND is NOT the last segment (which carries "OH 43223").
  //
  // We also handle the case where county is embedded inside a segment like
  // "Columbus, Franklin, OH 43223".

  const stateAbbrevRe = /\b[A-Z]{2}\b/;
  const zipRe         = /\b\d{5}\b/;

  const filtered = commaParts.filter((part, idx) => {
    if (idx === 0) {
      logger.debug(`[zillow-enricher]     [${idx}] "${part}" → KEEP (street)`);
      return true;
    }
    if (stateAbbrevRe.test(part)) {
      logger.debug(`[zillow-enricher]     [${idx}] "${part}" → KEEP (has state abbrev)`);
      return true;
    }
    if (zipRe.test(part)) {
      logger.debug(`[zillow-enricher]     [${idx}] "${part}" → KEEP (has zip)`);
      return true;
    }
    // If the part is purely alpha (no digits, no state abbrev) and there are
    // still more parts after it → likely a county name → drop it
    if (/^[A-Za-z\s\-']+$/.test(part) && idx < commaParts.length - 1) {
      // But only drop if it isn't itself a city name (heuristic: city names
      // appear right after street and county is after city).
      // We drop if the immediately preceding part also looks like a city
      // (purely alpha) — meaning: street → city → [county] → state
      const prevIsCity = idx >= 2 && /^[A-Za-z\s\-']+$/.test(commaParts[idx - 1]);
      if (prevIsCity) {
        logger.debug(`[zillow-enricher]     [${idx}] "${part}" → DROP (county name)`);
        return false;
      }
    }
    logger.debug(`[zillow-enricher]     [${idx}] "${part}" → KEEP`);
    return true;
  });

  logger.debug(`[zillow-enricher]   Stage 2 - After county removal: [${filtered.map(p => `"${p}"`).join(", ")}]`);

  // ── 3. Flatten into a single string and slugify ───────────────────────────
  const flat = filtered
    .join(" ")
    .trim()
    .replace(/[^a-zA-Z0-9\s\-]/g, " ")   // strip commas, dots, etc.
    .replace(/\s+/g, "-")                  // spaces → hyphens
    .replace(/-+/g, "-")                   // collapse multiple hyphens
    .replace(/^-|-$/g, "");               // trim leading/trailing hyphens

  logger.debug(`[zillow-enricher]   Stage 3 - Final slug: "${flat}"`);
  return flat;
}

// ── URL builder ───────────────────────────────────────────────────────────────

function buildZillowDetailUrl(addressSlug: string): string {
  return `https://www.zillow.com/homes/${addressSlug}_rb/`;
}

// ── Oxylabs fetch ─────────────────────────────────────────────────────────────

function oxylabsFetch(targetUrl: string, sessionId?: string): Promise<string | null> {
  return new Promise((resolve) => {
    if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
      logger.error("[zillow-enricher] Oxylabs credentials missing (OXYLABS_USERNAME / OXYLABS_PASSWORD)");
      resolve(null);
      return;
    }

    const payload = {
      source:          "universal",
      url:             targetUrl,
      render:          "html",
      geo_location:    "United States",
      user_agent_type: "desktop",
      ...(sessionId ? { session_id: sessionId } : {}),
    };

    const bodyStr = JSON.stringify(payload);
    const authStr = Buffer.from(`${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`).toString("base64");

    const req = https.request(
      {
        hostname: OXYLABS_ENDPOINT,
        path:     OXYLABS_PATH,
        method:   "POST",
        family:   4,
        headers:  {
          "Content-Type":   "application/json",
          "Authorization":  `Basic ${authStr}`,
          "Content-Length": Buffer.byteLength(bodyStr).toString(),
        },
      },
      (res: http.IncomingMessage) => {
        const enc    = (res.headers["content-encoding"] ?? "").toLowerCase();
        const chunks: Buffer[] = [];
        const stream =
          enc === "gzip"    ? res.pipe(zlib.createGunzip())           :
          enc === "deflate" ? res.pipe(zlib.createInflate())          :
          enc === "br"      ? res.pipe(zlib.createBrotliDecompress()) :
          res as any;

        (stream as NodeJS.ReadableStream).on("data", (c: Buffer) => chunks.push(c));
        (stream as NodeJS.ReadableStream).on("end", () => {
          const raw    = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;

          if (status === 401) { logger.error("[zillow-enricher] Oxylabs 401 — bad credentials"); resolve(null); return; }
          if (status === 429) { logger.warn("[zillow-enricher] Oxylabs 429 — rate limited");     resolve(null); return; }
          if (status !== 200) { logger.warn(`[zillow-enricher] Oxylabs HTTP ${status}`);          resolve(null); return; }

          let parsed: any;
          try { parsed = JSON.parse(raw); } catch {
            logger.warn("[zillow-enricher] Could not parse Oxylabs envelope"); resolve(null); return;
          }

          const result      = parsed?.results?.[0];
          const content     = result?.content ?? "";
          const innerStatus = result?.status_code ?? 0;

          if (innerStatus === 403 || innerStatus === 429) {
            logger.warn(`[zillow-enricher] Zillow returned ${innerStatus} via Oxylabs`);
            resolve(null); return;
          }
          if (!content || content.length < 3_000) {
            logger.warn(`[zillow-enricher] Short content (${content.length} chars)`);
            resolve(null); return;
          }

          resolve(content);
        });

        (stream as NodeJS.ReadableStream).on("error", (err: any) => { resolve(null); });
      }
    );

    req.setTimeout(REQUEST_TIMEOUT_MS, () => { req.destroy(); resolve(null); });
    req.on("error", (err: any) => { logger.error(`[zillow-enricher] ${err.message}`); resolve(null); });
    req.write(bodyStr);
    req.end();
  });
}

// ── __NEXT_DATA__ extractor ───────────────────────────────────────────────────

function extractNextData(html: string): any | null {
  const m = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (!m?.[1]) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

// ── Zestimate extractor ───────────────────────────────────────────────────────
//
// Zillow's __NEXT_DATA__ structure has changed multiple times.  We try every
// known path in priority order so we degrade gracefully when they A/B test a
// new layout.
//
// Confirmed paths (as of 2024-2025):
//
//   A. gdpClientCache  (most common on property-detail pages)
//      props.pageProps.gdpClientCache["<zpid>-..."].property
//
//   B. componentProps (older layout)
//      props.pageProps.componentProps.zestimate
//
//   C. initialReduxState / apolloState (SPA layout)
//      props.pageProps.initialReduxState.gdp.fullPageRenderHash.property
//
//   D. Flat at pageProps level (rare but observed)
//      props.pageProps.property.zestimate

interface ZestimateBlock {
  zpid:          string | null;
  zestimate:     number | null;
  zestimateLow:  number | null;
  zestimateHigh: number | null;
  listPrice:     number | null;
  address:       string;
}
function extractZestimate(nextData: any): ZestimateBlock {
  const empty: ZestimateBlock = {
    zpid: null, zestimate: null, zestimateLow: null, zestimateHigh: null,
    listPrice: null, address: "",
  };

  if (!nextData) return empty;

  const pageProps = nextData?.props?.pageProps ?? {};
  const cp = pageProps?.componentProps ?? {};

  // ── gdpClientCache is a JSON STRING on this page layout — parse it ─────
  let cache = cp?.gdpClientCache;
  if (typeof cache === "string") {
    try { cache = JSON.parse(cache); } catch { cache = null; }
  }

  if (cache && typeof cache === "object") {
    for (const key of Object.keys(cache)) {
      const prop = cache[key]?.property;
      if (!prop) continue;
      const result = pickFromProperty(prop);
      // Accept if we have a zpid (property was found), regardless of zestimate
      if (result.zpid != null) return result;
    }
  }

  // ── Remaining paths unchanged ──────────────────────────────────────────
  if (cp?.zestimate != null) return pickFromProperty(cp);

  const rdx = pageProps?.initialReduxState;
  if (rdx) {
    const gdpProp = rdx?.gdp?.fullPageRenderHash?.property;
    if (gdpProp?.zestimate != null) return pickFromProperty(gdpProp);
    const listingsMap = rdx?.listings?.listingsByZpid ?? {};
    for (const zpid of Object.keys(listingsMap)) {
      const p = listingsMap[zpid];
      if (p?.zestimate != null) return pickFromProperty(p);
    }
  }

  const flatProp = pageProps?.property;
  if (flatProp?.zestimate != null) return pickFromProperty(flatProp);

  return empty;
}

function pickFromProperty(p: any): ZestimateBlock {
  const zestimate = resolveAmount(p?.zestimate);
  const low       = resolveAmount(p?.zestimateRangeLow  ?? p?.zestimateLow  ?? p?.zestimateRange?.low);
  const high      = resolveAmount(p?.zestimateRangeHigh ?? p?.zestimateHigh ?? p?.zestimateRange?.high);
  // listPrice is strictly the listing price — never used as a zestimate substitute
  const listPrice = resolveAmount(p?.price ?? p?.listPrice);

  const zpid = p?.zpid != null ? String(p.zpid) : null;

  let address = "";
  if (typeof p?.address === "string") {
    address = p.address;
  } else if (p?.address) {
    const a = p.address;
    address = [a.streetAddress, a.city, a.state, a.zipcode].filter(Boolean).join(", ");
  } else if (p?.streetAddress) {
    address = [p.streetAddress, p.city, p.state, p.zipcode].filter(Boolean).join(", ");
  }

  return { zpid, zestimate, zestimateLow: low, zestimateHigh: high, listPrice, address };
}


function resolveAmount(val: any): number | null {
  if (val == null)            return null;
  if (typeof val === "number") return val;
  if (typeof val === "string") {
    const n = parseFloat(val.replace(/[^0-9.]/g, ""));
    return isNaN(n) ? null : n;
  }
  // { amount, currency } shape
  if (typeof val === "object" && val.amount != null) return resolveAmount(val.amount);
  return null;
}

// ── Debug helpers ─────────────────────────────────────────────────────────────

function debugSave(filename: string, content: string): void {
  if (!DEBUG_SAVE) return;
  try {
    const dir  = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), content, "utf-8");
  } catch { /* non-fatal */ }
}

// ── ZillowAddressEnricher ─────────────────────────────────────────────────────

export class ZillowAddressEnricher {
  private readonly sessionId = `zillow_enrich_${Date.now()}_${Math.floor(Math.random() * 9_999)}`;

  // ── Single address lookup ─────────────────────────────────────────────────

  async lookup(rawAddress: string): Promise<ZillowEstimate> {
    logger.info(`\n[zillow-enricher] ═══════════════════════════════════════════════`);
    logger.info(`[zillow-enricher] 📍 Processing address: "${rawAddress}"`);
    
    const slug = formatAddressToSlug(rawAddress);
    const url  = buildZillowDetailUrl(slug);

    logger.info(`[zillow-enricher]   ✓ Slug: "${slug}"`);
    logger.info(`[zillow-enricher]   ✓ URL: ${url}`);

    const base: Omit<ZillowEstimate, "found" | "error"> = {
      zpid: null, url, zestimate: null, zestimateLow: null,
      zestimateHigh: null, listPrice: null,
      address: rawAddress, rawInput: rawAddress,
    };

    // ── Fetch HTML ─────────────────────────────────────────────────────────
    const html = await oxylabsFetch(url, this.sessionId);
    if (!html) {
      logger.warn(`[zillow-enricher] No HTML returned for "${rawAddress}"`);
      return { ...base, found: false, error: "no_html" };
    }

    debugSave(`enricher_${slug}.html`, html);

    // ── Quick block check ──────────────────────────────────────────────────
    const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").toLowerCase();
    if (["access denied", "attention required", "just a moment"].some(t => title.includes(t))) {
      logger.warn(`[zillow-enricher] Blocked for "${rawAddress}": title="${title}"`);
      return { ...base, found: false, error: "blocked" };
    }

    // ── "Home not found" detection ─────────────────────────────────────────
    //
    // When Zillow can't resolve the address it shows a search-results page
    // (no property detail) or a "home not found" notice.  We detect this by
    // checking for the absence of __NEXT_DATA__ with a property zpid.
    if (!html.includes("__NEXT_DATA__")) {
      logger.warn(`[zillow-enricher] No __NEXT_DATA__ for "${rawAddress}"`);
      return { ...base, found: false, error: "no_next_data" };
    }

    // ── Parse __NEXT_DATA__ ────────────────────────────────────────────────
    const nextData = extractNextData(html);
    if (!nextData) {
      logger.warn(`[zillow-enricher] Failed to parse __NEXT_DATA__ for "${rawAddress}"`);
      return { ...base, found: false, error: "parse_error" };
    }

    debugSave(`enricher_${slug}.json`, JSON.stringify(nextData, null, 2));

    const block = extractZestimate(nextData);

    if (block.zestimate == null && block.zpid == null) {
      logger.warn(`[zillow-enricher] ✗ Zestimate not found for "${rawAddress}"`);
      return { ...base, found: false, error: "zestimate_missing" };
    }

    logger.info(
      `[zillow-enricher] ✓ Zillow match found!`
    );
    logger.info(
      `[zillow-enricher]   zpid: ${block.zpid ?? "N/A"}`
    );
    logger.info(
      `[zillow-enricher]   zestimate: ${block.zestimate != null ? "$" + block.zestimate.toLocaleString() : "N/A"}`
    );
    logger.info(
      `[zillow-enricher]   range: ${block.zestimateLow != null ? "$" + block.zestimateLow.toLocaleString() : "?"} – ${block.zestimateHigh != null ? "$" + block.zestimateHigh.toLocaleString() : "?"}`
    );
    logger.info(
      `[zillow-enricher]   address: ${block.address || "N/A"}`
    );
    logger.info(`[zillow-enricher] ═══════════════════════════════════════════════\n`);

    return {
      ...base,
      ...block,
      url,
      address:  block.address || rawAddress,
      rawInput: rawAddress,
      found:    true,
    };
  }

  // ── Batch lookup ──────────────────────────────────────────────────────────
  //
  // Runs addresses in chunks of `concurrency` (default 1).
  // Within each chunk requests are parallel; chunks are sequential with a
  // polite delay so Oxylabs doesn't rate-limit us.

  async lookupBatch(
    addresses:  string[],
    options:    LookupOptions = {}
  ): Promise<ZillowEstimate[]> {
    const concurrency = Math.max(1, options.concurrency ?? 1);
    const results:  ZillowEstimate[] = [];

    for (let i = 0; i < addresses.length; i += concurrency) {
      const chunk = addresses.slice(i, i + concurrency);

      logger.info(
        `[zillow-enricher] Batch chunk ${Math.floor(i / concurrency) + 1} / ` +
        `${Math.ceil(addresses.length / concurrency)} (${chunk.length} address(es))`
      );

      const chunkResults = await Promise.all(chunk.map(a => this.lookup(a)));
      results.push(...chunkResults);

      if (i + concurrency < addresses.length) {
        await sleep(BETWEEN_LOOKUP_MS);
      }
    }

    const found = results.filter(r => r.found).length;
    logger.info(`[zillow-enricher] Batch done — ${found}/${results.length} found`);
    return results;
  }
}

// ── Convenience function ──────────────────────────────────────────────────────
//
// For one-off calls without instantiating the class:
//   import { lookupZillowEstimate } from "./zillow.address-enricher";
//   const est = await lookupZillowEstimate("1657 Sullivant Avenue, Columbus, Franklin, OH 43223");

export async function lookupZillowEstimate(address: string): Promise<ZillowEstimate> {
  return new ZillowAddressEnricher().lookup(address);
}