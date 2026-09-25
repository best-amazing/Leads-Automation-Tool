// src/scrapers/property-purchase-research/adu-research.scraper.ts
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// ADU Property Purchase Research Scraper
//
// Extends the existing InvestorLiftScraper to:
//   1. Replace price/location passesFilter() with keyword-based ADU matching
//   2. Match listings in the configured target states
//   3. Capture extended fields (description, units, yearBuilt, schoolRating)
//   4. Output results to CSV + JSON instead of the database
//
// Usage:
//   npm run scrape:adu-research
//   node -r ts-node/register index.ts --source adu-research
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

import { chromium, Browser } from "playwright";
import * as fs from "fs";
import * as path from "path";

// How many listings to log detailed diagnostics for (avoids log spam)
const DIAGNOSTIC_LOG_LIMIT = 10;

import axios from "axios";
import { BaseScraper, ScraperOptions } from "../../base.scraper";
import { BrowserHandle, sleep } from "../../../utils/browser";
import { RawListing } from "../../../types/listing";
import { logger } from "../../../utils/logger";
import {
  loadSeenListings as loadSeenFromDb,
  saveSeenListings as saveSeenToDb,
} from "../../../utils/backfill-store";
import { ADU_KEYWORDS, TARGET_STATES } from "../core/adu-keywords";
import {
  AduResearchListing,
  parseAduApiResponse,
} from "../core/adu-research.parser";

// â”€â”€ Constants (reuse from InvestorLift) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

const MARKETPLACE_URL = "https://investorlift.com/marketplace/";
const PROPERTIES_API_URL =
  "https://investorlift.com/marketplace/api/customer/api/properties";
const ADDRESS_INQUIRY_URL =
  "https://investorlift.com/marketplace/api/customer/api/inquiry";

const ADDRESS_LIMIT_SENTINEL =
  "You have reached the daily address request limit";
const ADDRESS_FETCH_LIMIT = 5;
const ADDRESS_REQUEST_DELAY = 800;

const SERVER_ROOT = path.resolve(__dirname, "../../../..");
const SESSION_FILE_DEFAULT = process.env.INVESTORLIFT_SESSION_FILE
  ? path.resolve(process.env.INVESTORLIFT_SESSION_FILE)
  : path.join(SERVER_ROOT, "investorlift-session.json");
const SESSION_FILE_FALLBACK = path.join(SERVER_ROOT, "investor-session.json");
const SESSION_FILE =
  fs.existsSync(SESSION_FILE_FALLBACK) && !fs.existsSync(SESSION_FILE_DEFAULT)
    ? SESSION_FILE_FALLBACK
    : SESSION_FILE_DEFAULT;
const DEBUG_DIR = path.resolve("logs");

// How many new listings to process per run
const BACKFILL_BATCH_SIZE = Number(process.env.IL_BACKFILL_BATCH_SIZE ?? 500);
const IL_LOOKBACK_DAYS = Number(process.env.IL_LOOKBACK_DAYS ?? 90);

// How many raw XHR payloads to save for inspection (avoids disk spam if there are many requests)
const MAX_RAW_SAVES = 3;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const BASE_HEADERS = {
  "User-Agent": USER_AGENT,
  Origin: "https://investorlift.com",
  Referer: "https://investorlift.com/marketplace/",
};

const CHROMIUM_ARGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

// â”€â”€ Error types â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

class DailyLimitReachedError extends Error {
  constructor() {
    super("Daily address request limit reached");
    this.name = "DailyLimitReachedError";
  }
}

class SessionExpiredError extends Error {
  constructor() {
    super("InvestorLift session expired or missing");
    this.name = "SessionExpiredError";
  }
}

// â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function extractListingId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const m = url.match(/\/(?:deal|p)\/([^/?#]+)/);
  return m?.[1];
}

// â”€â”€ ADU Filters (split into location + keyword stages) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// Counter for diagnostic logging (reset per run)
let _locationDiagCount = 0;
let _keywordDiagCount = 0;
let _criteriaDiagCount = 0;

/** Reset diagnostic counters â€” call at the start of each run */
export function resetDiagCounters(): void {
  _locationDiagCount = 0;
  _keywordDiagCount = 0;
  _criteriaDiagCount = 0;
}

export function isIndianaZipAllowed(
  zipValue?: string | number | null,
): boolean {
  const normalized = String(zipValue ?? "")
    .trim()
    .replace(/[^\d]/g, "");

  return /^46\d{3}$/.test(normalized);
}

export function validateIndianaLeadZip(
  listing: Pick<AduResearchListing, "state" | "address" | "zip">,
): boolean {
  const stateUpper = (listing.state ?? "").toUpperCase();
  const addressUpper = (listing.address ?? "").toUpperCase();
  const zipValue = listing.zip ?? "";

  const isIndiana =
    stateUpper === "IN" ||
    addressUpper.includes(", IN") ||
    addressUpper.includes(" IN ");
  if (!isIndiana) return true;

  const hasIndianaZip = isIndianaZipAllowed(zipValue);
  if (!hasIndianaZip) {
    logger.warn(
      `[adu-filter] Indiana lead rejected: zip="${String(zipValue ?? "").trim() || "(missing)"}" address="${(listing.address ?? "(empty)").slice(0, 120)}"`,
    );
  }

  return hasIndianaZip;
}

/**
 * Stage 1: Check if a listing is located in one of TARGET_STATES.
 * Logs diagnostic details for the first N listings.
 */
export function passesLocationFilter(listing: AduResearchListing): boolean {
  const addressUpper = (listing.address ?? "").toUpperCase();
  const stateUpper = (listing.state ?? "").toUpperCase();

  const matchedState = TARGET_STATES.find((s) => {
    if (stateUpper === s) return true;
    return addressUpper.includes(`, ${s}`);
  });

  const isIndianaZipValid = validateIndianaLeadZip(listing);
  const passed = !!matchedState && isIndianaZipValid;

  // Diagnostic logging for first N listings
  if (_locationDiagCount < DIAGNOSTIC_LOG_LIMIT) {
    _locationDiagCount++;
    logger.info(
      `[adu-filter] LOCATION [${_locationDiagCount}] ` +
        `${passed ? "âœ“ PASS" : "âœ— FAIL"} | ` +
        `state field="${listing.state ?? "(empty)"}" | ` +
        `zip="${String(listing.zip ?? "(empty)").slice(0, 20)}" | ` +
        `address="${(listing.address ?? "(empty)").slice(0, 80)}" | ` +
        `matched="${matchedState ?? "none"}" | ` +
        `indianaZipOk=${isIndianaZipValid}`,
    );
  }

  return passed;
}

/**
 * Stage 2: Check if a listing contains at least one ADU_KEYWORD
 * in title/description/address.
 * Logs diagnostic details for the first N listings.
 */

export function passesKeywordFilter(listing: AduResearchListing): boolean {
  const titlePart = listing.title ?? "";
  const descriptionPart = listing.description ?? "";
  const addressPart = listing.address ?? "";

  const haystack = [titlePart, descriptionPart, addressPart]
    .join(" ")
    .toLowerCase();

  const matchedKeyword = ADU_KEYWORDS.find((kw) => {
    const regex = new RegExp(`\\b${kw}\\b`, "i");
    return regex.test(haystack);
  });

  const passed = !!matchedKeyword;

  // Diagnostic logging for first N listings
  if (_keywordDiagCount < DIAGNOSTIC_LOG_LIMIT) {
    _keywordDiagCount++;
    logger.info(
      `[adu-filter] KEYWORD [${_keywordDiagCount}] ` +
        `${passed ? "âœ“ PASS" : "âœ— FAIL"} | ` +
        `title="${titlePart.slice(0, 60)}" | ` +
        `desc length=${descriptionPart.length} | ` +
        `desc preview="${descriptionPart.slice(0, 100)}" | ` +
        `address="${addressPart.slice(0, 60)}" | ` +
        `matchedKw="${matchedKeyword ?? "none"}" | ` +
        `haystack (300 chars)="${haystack.slice(0, 300)}"`,
    );
  }

  return passed;
}

/**
 * Stage 3: Check strict property criteria (Price, Beds, Baths, Year, HOA, etc.)
 */

export function passesPropertyCriteria(listing: AduResearchListing): boolean {
  let passed = true;
  let failReason = "";

  // 1. Price <= $600,000
  if (listing.price != null && listing.price > 600000) {
    passed = false;
    failReason = `price > 600k (${listing.price})`;
  }
  // 2. Bedrooms >= 3
  else if (listing.bedrooms != null && listing.bedrooms < 3) {
    passed = false;
    failReason = `bedrooms < 3 (${listing.bedrooms})`;
  }
  // 3. Bathrooms >= 2
  else if (listing.bathrooms != null && listing.bathrooms < 2) {
    passed = false;
    failReason = `bathrooms < 2 (${listing.bathrooms})`;
  }
  // 4. Year Built >= 1950
  else if (listing.yearBuilt != null && listing.yearBuilt < 1950) {
    passed = false;
    failReason = `year built < 1950 (${listing.yearBuilt})`;
  }
  // 5. Exclude HOA, 55+, New Construction, Auctions, Foreclosures, Short Sales
  else {
    const haystack = [listing.title, listing.description, listing.address]
      .join(" ")
      .toLowerCase();

    // Property Type constraint (Single Family Home or Multi-Family only) -> exclude condo/townhouse/mobile/land/lot
    // Use word boundaries so "Woodland" or "1 acre lot" don't false-positive
    const propertyTypeRe =
      /\b(condo|townhouse|townhome|mobile home|manufactured|mobile|vacant land|bare land|lot only)\b/i;
    if (propertyTypeRe.test(haystack)) {
      passed = false;
      failReason = "property type (not SFH/Multi)";
    } else if (
      haystack.includes("hoa") ||
      haystack.includes("homeowners association") ||
      haystack.includes("home owner association") ||
      haystack.includes("home owner's association") ||
      haystack.includes("homeowner's association")
    ) {
      passed = false;
      failReason = "has HOA";
    } else if (
      haystack.includes("55+") ||
      haystack.includes("55 and older") ||
      haystack.includes("active adult") ||
      haystack.includes("senior community")
    ) {
      passed = false;
      failReason = "55+ community";
    } else if (
      haystack.includes("new construction") ||
      haystack.includes("to be built") ||
      haystack.includes("under construction") ||
      haystack.includes("pre-construction")
    ) {
      passed = false;
      failReason = "new construction";
    } else if (haystack.includes("auction")) {
      passed = false;
      failReason = "auction";
    } else if (
      haystack.includes("foreclosure") ||
      haystack.includes("reo ") ||
      haystack.includes("bank owned")
    ) {
      passed = false;
      failReason = "foreclosure";
    } else if (haystack.includes("short sale")) {
      passed = false;
      failReason = "short sale";
    }
  }

  // Diagnostic logging for first N listings
  if (_criteriaDiagCount < DIAGNOSTIC_LOG_LIMIT) {
    _criteriaDiagCount++;
    logger.info(
      `[adu-filter] CRITERIA [${_criteriaDiagCount}] ` +
        `${passed ? "âœ“ PASS" : "âœ— FAIL"} | ` +
        `reason="${failReason}" | ` +
        `price=${listing.price} beds=${listing.bedrooms} baths=${listing.bathrooms} year=${listing.yearBuilt} dom=${listing.daysOnMarket} status=${listing.status}`,
    );
  }

  return passed;
}

/**
 * Combined filter: location + criteria + keyword (backward compatible).
 * Use passesLocationFilter + passesPropertyCriteria + passesKeywordFilter separately when
 * you need to inspect the intermediate set.
 */
export function passesAduFilter(listing: AduResearchListing): boolean {
  return (
    passesLocationFilter(listing) &&
    passesPropertyCriteria(listing) &&
    passesKeywordFilter(listing)
  );
}

