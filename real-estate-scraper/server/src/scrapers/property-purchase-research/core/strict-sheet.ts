// src/scrapers/property-purchase-research/core/strict-sheet.ts
// ─────────────────────────────────────────────────────────────────────────────
// Routing for the second ("strict") property lead spreadsheet.
//
// Leads are checked against STRICT_CRITERIA (≤ $200k, 4+ beds, 2+ baths,
// ≥ 1,500 sqft, ≥ 0.5 acre lot, built 1955+, no HOA; SFH/MFH/apartments; no
// condos, bungalows, land, 55+, auctions, foreclosures, short sales or new
// construction). Same states, ZIP rules and sources as the main sheet, but NO
// ADU keyword is required: sources keep listings that match a keyword OR meet
// these criteria (passesKeywordOrStrictFilter), and handleMatch writes keyword
// leads to the main sheet and qualifying leads to this one.
//
// Written to the "Eddy Property Research Tool 2" tab (found by tab ID) of the
// same workbook as Tool 1 — see targetConfig in utils/google-sheets.ts.
// ─────────────────────────────────────────────────────────────────────────────
import { logger } from "../../../utils/logger";
import { isSheetTargetConfigured } from "../../../utils/google-sheets";
import { schoolRatingFailure, strictCriteriaFailure } from "../filters/adu-research.scraper";
import { AduResearchListing } from "./adu-research.parser";

let warnedUnconfigured = false;

/**
 * Cheap pre-check before dedupe and public-record lookups: keyword leads are
 * always wanted (main sheet); leads without a keyword only when they could
 * still make the second sheet.
 */
export function isWantedLead(listing: AduResearchListing): boolean {
  // Both sheets: no areas whose high school is rated below 3
  const school = schoolRatingFailure(listing);
  if (school) {
    logger.info(`[strict-sheet] Excluding (${school}): ${listing.address || listing.url}`);
    return false;
  }
  if (listing.matchedKeyword) return true;
  return isSheetTargetConfigured("strict") && strictCriteriaFailure(listing) === null;
}

/** True when the lead should also be written to the second spreadsheet. */
export function qualifiesForStrictSheet(listing: AduResearchListing): boolean {
  if (!isSheetTargetConfigured("strict")) {
    if (!warnedUnconfigured) {
      warnedUnconfigured = true;
      logger.info(
        "[strict-sheet] No spreadsheet configured — second property research tab disabled",
      );
    }
    return false;
  }

  const failure = strictCriteriaFailure(listing);
  if (failure) {
    logger.debug(
      `[strict-sheet] Not added (${failure}): ${listing.address || listing.url}`,
    );
    return false;
  }
  logger.info(`[strict-sheet] ✓ Qualifies: ${listing.address || listing.url}`);
  return true;
}
