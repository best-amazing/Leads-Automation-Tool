// scripts/reprocess-il-logs.ts
// ─────────────────────────────────────────────────────────────────────────────
// Re-processes saved InvestorLift API response logs (il_adu_raw_response_*.json).
//
// Features:
//   1. Reads all raw response JSON log files from the server/logs directory.
//   2. Parses all properties using the enhanced ADU parser.
//   3. Fetches missing descriptions/details & full addresses (with disk caching).
//   4. Applies ADU keyword and location filters.
//   5. Stream-writes new matches to CSV, JSON, and Google Sheets.
//
// Usage:
//   npm run reprocess:il-logs
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import { parseAduApiResponse, AduResearchListing } from "../src/scrapers/property-purchase-research/adu-research.parser";
import { passesLocationFilter, passesKeywordFilter } from "../src/scrapers/property-purchase-research/adu-research.scraper";
import { ADU_KEYWORDS } from "../src/scrapers/property-purchase-research/adu-keywords";
import { appendAduResult } from "../src/scrapers/property-purchase-research/adu-csv-writer";
import { writeAduResearchToSheets } from "../src/utils/google-sheets";
import { logger } from "../src/utils/logger";

const LOGS_DIR = path.join(__dirname, "..", "logs");
const CACHE_FILE = path.join(LOGS_DIR, "il_details_cache.json");
const SESSION_FILE = path.join(__dirname, "..", "investorlift-session.json");

const BASE_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36",
  "Origin": "https://investorlift.com",
  "Referer": "https://investorlift.com/marketplace/",
};

function getCookieHeader(): string | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const state = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    const cookies = (state.cookies ?? []) as Array<{ name: string; value: string }>;
    if (cookies.length === 0) return null;
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch {
    return null;
  }
}

function loadCache(): Record<string, any> {
  try {
    if (fs.existsSync(CACHE_FILE)) {
      return JSON.parse(fs.readFileSync(CACHE_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveCache(cache: Record<string, any>): void {
  try {
    if (!fs.existsSync(LOGS_DIR)) {
      fs.mkdirSync(LOGS_DIR, { recursive: true });
    }
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), "utf-8");
  } catch {}
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchDetails(listingId: string, cookieHeader: string | null, cache: Record<string, any>): Promise<any> {
  if (cache[listingId]) {
    return cache[listingId];
  }
  if (!cookieHeader) return null;

  try {
    const res = await fetch(`https://investorlift.com/marketplace/api/customer/api/properties/${listingId}`, {
      headers: { ...BASE_HEADERS, Cookie: cookieHeader },
    });
    if (res.ok) {
      const data = await res.json();
      cache[listingId] = data;
      saveCache(cache);
      return data;
    }
  } catch (err) {
    logger.warn(`[reprocessor] Error fetching details for ${listingId}: ${err}`);
  }
  return null;
}

function extractListingId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/\/(?:deal|p)\/([^/?#]+)/);
  return m?.[1];
}

async function runReprocessor() {
  logger.info("=======================================================");
  logger.info("InvestorLift Offline Log Reprocessor & Match Extractor");
  logger.info("=======================================================");

  if (!fs.existsSync(LOGS_DIR)) {
    logger.warn(`[reprocessor] No logs directory found at ${LOGS_DIR}`);
    return;
  }

  const files = fs.readdirSync(LOGS_DIR).filter((f) => f.startsWith("il_adu_raw_response_") && f.endsWith(".json"));
  if (files.length === 0) {
    logger.info("[reprocessor] No raw InvestorLift response files found in logs/.");
    return;
  }

  logger.info(`[reprocessor] Found ${files.length} raw response file(s): ${files.join(", ")}`);

  const cache = loadCache();
  const cookieHeader = getCookieHeader();

  const allListingsMap = new Map<string, AduResearchListing>();

  for (const file of files) {
    const filePath = path.join(LOGS_DIR, file);
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const json = JSON.parse(content);
      const parsed = parseAduApiResponse(json, "investorlift");
      logger.info(`[reprocessor] ${file}: Parsed ${parsed.length} raw listings`);

      for (const listing of parsed) {
        if (listing.url && !allListingsMap.has(listing.url)) {
          allListingsMap.set(listing.url, listing);
        }
      }
    } catch (err) {
      logger.error(`[reprocessor] Failed to parse ${file}: ${err}`);
    }
  }

  const allListings = Array.from(allListingsMap.values());
  logger.info(`[reprocessor] Total unique listings across logs: ${allListings.length}`);

  // Location filter
  const locationMatches = allListings.filter(passesLocationFilter);
  logger.info(`[reprocessor] Listings passing location filter: ${locationMatches.length}`);

  let matchCount = 0;

  for (let i = 0; i < locationMatches.length; i++) {
    const listing = { ...locationMatches[i] };
    const listingId = extractListingId(listing.url);

    if (listingId) {
      const details = await fetchDetails(listingId, cookieHeader, cache);
      if (details) {
        if (details.description) {
          listing.description = details.description.replace(/<[^>]*>?/gm, " ");
        }
        if (details.year_built && !listing.yearBuilt) {
          listing.yearBuilt = Number(details.year_built);
        }
        if (details.units && !listing.units) {
          listing.units = Number(details.units);
        }
        if (!listing.ownerName) {
          listing.ownerName = details.dispositions_manager?.name || details.account?.title;
        }
        if (!listing.bedrooms && details.bedrooms) {
          listing.bedrooms = Number(details.bedrooms);
        }
        if (!listing.bathrooms && details.bathrooms) {
          listing.bathrooms = Number(details.bathrooms);
        }
        if (!listing.squareFeet && details.sq_footage) {
          listing.squareFeet = Number(details.sq_footage);
        }
        if (!listing.lotSqft && details.lot_size) {
          listing.lotSqft = Number(details.lot_size);
        }

        if (!listing.arvEstimate && details.arv_estimate != null) {
          listing.arvEstimate = Number(details.arv_estimate);
        }
        if (!listing.arvPercentage && details.arv_percentage != null) {
          listing.arvPercentage = Number(details.arv_percentage);
        }
        if (!listing.grossMargin && details.gross_margin != null) {
          listing.grossMargin = Number(details.gross_margin);
        }
        if (!listing.views && details.views != null) {
          listing.views = Number(details.views);
        }
        if (!listing.entryFee && details.entry_fee != null) {
          listing.entryFee = Number(details.entry_fee);
        }
        if (!listing.propertyTypeId && details.property_type_id != null) {
          listing.propertyTypeId = Number(details.property_type_id);
        }
        if (!listing.parkingTypeId && details.parking_type_id != null) {
          listing.parkingTypeId = Number(details.parking_type_id);
        }
        if (!listing.publishedAt && details.published_at) {
          listing.publishedAt = details.published_at;
        }
        if (!listing.latitude && details.latitude != null) {
          listing.latitude = Number(details.latitude);
        }
        if (!listing.longitude && details.longitude != null) {
          listing.longitude = Number(details.longitude);
        }
        if (!listing.tags && details.tags) {
          listing.tags = details.tags;
        }
        if (!listing.isVerified && details.is_verified != null) {
          listing.isVerified = Boolean(details.is_verified);
        }
        if (!listing.buyNowPrice && details.buy_now_price != null) {
          listing.buyNowPrice = Number(details.buy_now_price);
        }
        if (!listing.repairEstimateMin && details.repair_estimate_min != null) {
          listing.repairEstimateMin = Number(details.repair_estimate_min);
        }
        if (!listing.repairEstimateMax && details.repair_estimate_max != null) {
          listing.repairEstimateMax = Number(details.repair_estimate_max);
        }
        if (!listing.occupancy && details.occupancy?.value) {
          listing.occupancy = details.occupancy.value;
        }
        if (!listing.condition && details.condition?.value) {
          listing.condition = details.condition.value;
        }
        if (!listing.halfBathrooms && details.half_bathrooms != null) {
          listing.halfBathrooms = Number(details.half_bathrooms);
        }
        if (!listing.lotSizeUnit && details.lot_size_unit) {
          listing.lotSizeUnit = details.lot_size_unit;
        }
        if (!listing.accountType && details.account?.account_type) {
          listing.accountType = details.account.account_type;
        }
        if (!listing.expiresAt && details.expires_at) {
          listing.expiresAt = details.expires_at;
        }
        if (!listing.publicAddress && details.public_address) {
          listing.publicAddress = details.public_address;
        }
        if (!listing.propertyPageUrl && details.property_page_url) {
          listing.propertyPageUrl = details.property_page_url;
        }
      }
      await sleep(200);
    }

    if (passesKeywordFilter(listing)) {
      matchCount++;
      if (!listing.matchedKeyword) {
        const kHaystack = [listing.title, listing.description, listing.address].join(" ").toLowerCase();
        listing.matchedKeyword = ADU_KEYWORDS.find((kw) => new RegExp(`\\b${kw}\\b`, "i").test(kHaystack));
      }

      logger.info(`[reprocessor] ✓ MATCH #${matchCount}: ${listing.address || listing.url} | keyword="${listing.matchedKeyword ?? ""}"`);

      appendAduResult(listing);
      await writeAduResearchToSheets([listing]);
    }
  }

  logger.info("=======================================================");
  logger.info(`[reprocessor] Reprocessing complete! ${matchCount} total match(es) processed & updated.`);
  logger.info("=======================================================");
}

runReprocessor();
