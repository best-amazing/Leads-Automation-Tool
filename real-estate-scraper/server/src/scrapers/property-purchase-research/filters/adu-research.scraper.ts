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
import {
  findAduKeyword,
  STATE_ZIP_PREFIXES,
  TARGET_STATES,
} from "../core/adu-keywords";
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

/** True when `zipValue` is a 5-digit ZIP starting with one of `prefixes`. */
export function isZipAllowedForState(
  state: string,
  zipValue?: string | number | null,
): boolean {
  const prefixes = STATE_ZIP_PREFIXES[state.toUpperCase()];
  if (!prefixes) return true; // unrestricted state
  const normalized = String(zipValue ?? "")
    .trim()
    .replace(/[^\d]/g, "")
    .slice(0, 5);
  return (
    /^\d{5}$/.test(normalized) && prefixes.some((p) => normalized.startsWith(p))
  );
}

export function isIndianaZipAllowed(
  zipValue?: string | number | null,
): boolean {
  return isZipAllowedForState("IN", zipValue);
}

/**
 * Which ZIP-restricted state a listing is in. Prefers the explicit state
 * field; falls back to ", XX" / " XX " in the address when it is empty.
 */
function restrictedStateOf(
  listing: Pick<AduResearchListing, "state" | "address">,
): string | undefined {
  const restricted = Object.keys(STATE_ZIP_PREFIXES);
  const stateUpper = (listing.state ?? "").trim().toUpperCase();
  if (stateUpper) return restricted.find((s) => s === stateUpper);

  const addressUpper = (listing.address ?? "").toUpperCase();
  return restricted.find(
    (s) => addressUpper.includes(`, ${s}`) || addressUpper.includes(` ${s} `),
  );
}

/**
 * Per-state ZIP gate (see STATE_ZIP_PREFIXES): e.g. Indiana leads must be
 * 46xxx, Wisconsin 53xxx. Runs in the location filter and again right before
 * a lead is written to outputs.
 */
export function validateLeadZip(
  listing: Pick<AduResearchListing, "state" | "address" | "zip">,
): boolean {
  const state = restrictedStateOf(listing);
  if (!state) return true;

  const zipValue =
    String(listing.zip ?? "").trim() ||
    ((listing.address ?? "").match(/\b\d{5}(?:-\d{4})?\b/g) ?? []).pop() ||
    "";

  const allowed = isZipAllowedForState(state, zipValue);
  if (!allowed) {
    logger.warn(
      `[adu-filter] ${state} lead rejected (allowed ZIPs: ${STATE_ZIP_PREFIXES[state].map((p) => `${p}xxx`).join(", ")}): zip="${zipValue || "(missing)"}" address="${(listing.address ?? "(empty)").slice(0, 120)}"`,
    );
  }

  return allowed;
}

/** @deprecated Use validateLeadZip — now covers every ZIP-restricted state. */
export const validateIndianaLeadZip = validateLeadZip;

/** Two-letter state of a lead: the state field, else ", XX 12345" in the address. */
function leadStateOf(
  listing: Pick<AduResearchListing, "state" | "address">,
): string | undefined {
  const field = (listing.state ?? "").trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(field)) return field;
  const matches = [
    ...(listing.address ?? "")
      .toUpperCase()
      .matchAll(/,\s*([A-Z]{2})(?=\s*,?\s*\d{5}\b|\s*$)/g),
  ];
  return matches.at(-1)?.[1];
}

/**
 * Final gate before a lead is written: its state must be in TARGET_STATES.
 * Catches detail jobs that were queued before TARGET_STATES changed (e.g. a
 * temporary ADU_TARGET_STATES focus). Leads whose state can't be determined
 * pass — the location filter already ran when they were queued.
 */
export function passesTargetStateGate(
  listing: Pick<AduResearchListing, "state" | "address" | "url">,
): boolean {
  const state = leadStateOf(listing);
  if (!state || TARGET_STATES.includes(state)) return true;
  logger.info(
    `[adu-filter] Excluding lead outside target states (${state} not in ${TARGET_STATES.join(",")}): ${listing.address || listing.url}`,
  );
  return false;
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

  const isZipValid = validateLeadZip(listing);
  const passed = !!matchedState && isZipValid;

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
        `zipOk=${isZipValid}`,
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

  const matchedKeyword = findAduKeyword(haystack);

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

// ── New construction exclusion ──────────────────────────────────────────────
// We don't purchase new builds. Anything built in or after
// NEW_CONSTRUCTION_MIN_YEAR (default: last calendar year, so 2025+ in 2026)
// is excluded, as is any listing described as new / under / future
// construction.
const NEW_CONSTRUCTION_MIN_YEAR = Number(
  process.env.NEW_CONSTRUCTION_MIN_YEAR ?? new Date().getFullYear() - 1,
);

const NEW_CONSTRUCTION_RE =
  /\b(new[- ]construction|newly (?:constructed|built)|new[- ]build|to[- ]be[- ]built|under construction|pre[- ]?construction|proposed construction|spec home|est(?:\.|imated)? completion)\b/gi;

// A phrase followed closely by one of these describes an improvement on an
// older home ("newly built 20x20 garage"), not the house itself.
const IMPROVEMENT_RE =
  /^[^.;!]{0,30}?\b(garage|barn|pole barn|shed|deck|porch|patio|addition|fence|driveway|roof|carport|workshop|outbuilding)s?\b/i;

/** Why a listing counts as new construction, or null when it doesn't. */
export function newConstructionReason(
  listing: Pick<AduResearchListing, "yearBuilt" | "title" | "description">,
): string | null {
  const year = Number(listing.yearBuilt);
  if (year > 0) {
    // A known build year is authoritative: recent → excluded; older → the
    // home isn't new, whatever the marketing copy says ("feels like a
    // brand-new build").
    return year >= NEW_CONSTRUCTION_MIN_YEAR
      ? `new construction (built ${year})`
      : null;
  }

  const text = `${listing.title ?? ""} ${listing.description ?? ""}`;
  for (const m of text.matchAll(NEW_CONSTRUCTION_RE)) {
    const after = text.slice(m.index! + m[0].length);
    if (IMPROVEMENT_RE.test(after)) continue;
    return `new construction ("${m[0].toLowerCase()}")`;
  }
  return null;
}

/**
 * Final gate before a lead is written: runs once the full description and
 * the public-record year built are known (earlier filters may have only
 * seen search-page data).
 */
export function passesNewConstructionGate(
  listing: Partial<
    Pick<
      AduResearchListing,
      "yearBuilt" | "title" | "description" | "address" | "url"
    >
  >,
): boolean {
  const reason = newConstructionReason(listing);
  if (reason) {
    logger.info(
      `[adu-filter] Excluding ${reason}: ${listing.address || listing.url}`,
    );
  }
  return !reason;
}

// ── Second spreadsheet ("strict" criteria) ──────────────────────────────────
// A lead goes to the second spreadsheet only if it already qualified for the
// main one AND meets these tighter criteria. Like the main sheet, a value the
// source doesn't provide passes (it's written as-is for manual review); a
// value that IS known must meet the bar.
export const STRICT_CRITERIA = {
  maxPrice: 200_000,
  minBeds: 4,
  minBaths: 2,
  minSqft: 1_500,
  minLotSqft: 0.5 * 43_560, // 0.5 acres
  minYearBuilt: 1955,
};

const STRICT_EXCLUDED_HOME_TYPES =
  /^(condo|condominium|townhouse|townhome|co-?op|manufactured|mobile|lot|land|vacant land|timeshare)/i;
const STRICT_EXCLUDED_TEXT: Array<[RegExp, string]> = [
  [/\b(condo|condominium|townhouse|townhome|mobile home|manufactured home)\b/i, "property type"],
  [/\b(vacant land|bare land|land only|lot only)\b/i, "land only"],
  [/\bbungalows?\b/i, "bungalow"],
  [/\b(55\+|55 and older|55 and over|active adult|senior community)/i, "55+ community"],
  [/\bauctions?\b/i, "auction"],
  [/\b(foreclosures?|bank[- ]owned|reo)\b/i, "foreclosure"],
  [/\bshort sale\b/i, "short sale"],
];
// "HOA" mentioned, but not in a negation like "no HOA" / "HOA: none"
const HOA_TEXT_RE =
  /\b(hoa|home ?owners?'? association|home owner'?s? association)\b/i;
const NO_HOA_TEXT_RE =
  /\b(no|without|zero|free of)\s+(an?\s+)?(hoa|home ?owners?'? association)\b|\bhoa\s*(fees?)?\s*[:\-]?\s*(none|no|n\/a|\$?0\b)/i;

/** First reason a lead fails the second spreadsheet's criteria, or null. */
export function strictCriteriaFailure(
  listing: Partial<AduResearchListing>,
): string | null {
  const c = STRICT_CRITERIA;
  const known = (v: unknown): v is number =>
    typeof v === "number" && Number.isFinite(v) && v > 0;

  if (known(listing.price) && listing.price > c.maxPrice)
    return `price > $${c.maxPrice.toLocaleString()} (${listing.price})`;
  if (known(listing.bedrooms) && listing.bedrooms < c.minBeds)
    return `beds < ${c.minBeds} (${listing.bedrooms})`;
  if (known(listing.bathrooms) && listing.bathrooms < c.minBaths)
    return `baths < ${c.minBaths} (${listing.bathrooms})`;
  if (known(listing.squareFeet) && listing.squareFeet < c.minSqft)
    return `sqft < ${c.minSqft} (${listing.squareFeet})`;
  if (known(listing.lotSqft) && listing.lotSqft < c.minLotSqft)
    return `lot < 0.5 acres (${(listing.lotSqft / 43_560).toFixed(2)} ac)`;
  if (known(listing.yearBuilt) && listing.yearBuilt < c.minYearBuilt)
    return `built before ${c.minYearBuilt} (${listing.yearBuilt})`;

  const newBuild = newConstructionReason(listing);
  if (newBuild) return newBuild;

  if (known(listing.hoaFee)) return `HOA ($${listing.hoaFee}/mo)`;

  const typeLabel = String(listing.homeType ?? listing.propertyType ?? "");
  if (STRICT_EXCLUDED_HOME_TYPES.test(typeLabel)) return `property type (${typeLabel})`;

  const text = `${listing.title ?? ""} ${listing.description ?? ""}`;
  if (HOA_TEXT_RE.test(text) && !NO_HOA_TEXT_RE.test(text)) return "HOA (mentioned)";
  for (const [re, reason] of STRICT_EXCLUDED_TEXT) {
    if (re.test(text)) return reason;
  }
  return null;
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
      // Word boundary so "shoal" / "Hoagland" don't false-positive
      /\bhoa\b/.test(haystack) ||
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
    } else if (newConstructionReason(listing)) {
      passed = false;
      failReason = newConstructionReason(listing)!;
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

