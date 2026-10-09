// src/scrapers/property-purchase-research/core/strict-sheet.ts
// ─────────────────────────────────────────────────────────────────────────────
// Routing for the second ("strict") property lead spreadsheet.
//
// Every lead written to the main spreadsheet is also checked against
// STRICT_CRITERIA (≤ $200k, 4+ beds, 2+ baths, ≥ 1,500 sqft, ≥ 0.5 acre lot,
// built 1955+, no HOA; SFH/MFH/apartments; no condos, bungalows, land, 55+,
// auctions, foreclosures, short sales or new construction). Same states, ZIP
// rules, sources and keywords as the main sheet — the strict criteria are a
// subset, so nothing the second sheet needs is filtered out upstream.
//
// Written to the "Second Property Research Spreadsheet" tab of the same
// workbook as the main tab (override with SPREADSHEET_ID_STRICT /
// ADU_STRICT_SHEET_TAB).
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "../../../utils/logger";
import { isSheetTargetConfigured } from "../../../utils/google-sheets";
import { strictCriteriaFailure } from "../filters/adu-research.scraper";
import { AduResearchListing } from "./adu-research.parser";

let warnedUnconfigured = false;

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
