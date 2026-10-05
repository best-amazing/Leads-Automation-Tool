// src/scrapers/property-purchase-research/core/public-records.ts
// ─────────────────────────────────────────────────────────────────────────────
// Shared public-record enrichment for every ADU lead writer: deed transfer
// date plus a backfilled year built (from the same ATTOM call), so the final
// new-construction check sees the most complete year available.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "../../../utils/logger";
import { AduResearchListing } from "./adu-research.parser";
import { fetchDeedRecord } from "./deed-data-resolver";

/**
 * Mutates `listing`: sets deedTransferDate, and yearBuilt when the listing
 * didn't carry one. Requires a real street address — craigslist pins are
 * frequently just the city-default location, and resolving those would
 * attach a stranger's records to this lead.
 */
export async function resolvePublicRecords(
  listing: AduResearchListing,
  scope: string,
): Promise<void> {
  if (!listing.address) return;

  try {
    logger.info(`${scope} Looking up deed transfer date for: ${listing.address}`);
    const record = await fetchDeedRecord({
      address: listing.address,
      city: listing.city,
      state: listing.state,
      zip: listing.zip,
      latitude: listing.latitude,
      longitude: listing.longitude,
    });

    if (record.deedTransferDate) {
      listing.deedTransferDate = record.deedTransferDate;
      logger.info(`${scope} ✓ Deed transfer date: ${record.deedTransferDate}`);
    } else {
      logger.info(`${scope} ✗ No deed transfer date found`);
    }

    if (listing.yearBuilt == null && record.yearBuilt != null) {
      listing.yearBuilt = record.yearBuilt;
      logger.info(`${scope} ✓ Year built (public record): ${record.yearBuilt}`);
    }
  } catch (err) {
    logger.warn(`${scope} Deed date lookup failed: ${err}`);
  }
}
