// src/services/redfin-enrichment.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Universal Redfin enrichment service for all platforms
//
// Purpose: Take ANY listing from ANY platform (Crexi, Zillow, etc.), pass its
// address to Redfin via Oxylabs API, and if a Redfin estimate is found, create
// Property + Estimate records with source="redfin".
//
// Mirrors the ZillowEnrichmentService pattern exactly.
// ─────────────────────────────────────────────────────────────────────────────

import { RawListing } from "../types/listing";
import { RedfinAddressEnricher, RedfinEstimate } from "../scrapers/redfin/redfin.address.enricher";
import { logger } from "../utils/logger";

/**
 * Check if an address has a street address component (starts with a digit).
 * Filters out addresses like "Columbus, OH 43202" or "Columbus, Franklin County, OH, 43224"
 * that have no street number.
 */
function hasStreetAddress(address: string): boolean {
  if (!address || typeof address !== "string") return false;
  const trimmed = address.trim();
  return /^\d+\s/.test(trimmed);
}

/**
 * Enriched listing with Redfin data
 * Extends RawListing with optional Redfin enrichment fields
 */
export interface EnrichedListingRedfin extends RawListing {
  redfinEstimate?: number;
  redfinEstimateLow?: number;
  redfinEstimateHigh?: number;
}

export class RedfinEnrichmentService {
  private enricher = new RedfinAddressEnricher();

  /**
   * Enrich ANY listings from ANY platform with Redfin estimates
   * Skips listings that already have redfinEstimate populated
   */
  async enrichAllListings(
    listings: RawListing[],
    concurrency: number = 1
  ): Promise<EnrichedListingRedfin[]> {
    const getAddress = (listing: RawListing) => listing.address ?? (listing as any).rawAddress;

    // Filter listings that need enrichment (have address, no redfinEstimate yet)
    // AND must have a street address component (starting with a digit)
    const needsEnrichment = listings.filter((l) => {
      const addr = getAddress(l);
      return (
        addr &&
        hasStreetAddress(addr) &&
        (l.redfinEstimate == null || (l as any).redfinEstimate === undefined)
      );
    });

    if (needsEnrichment.length === 0) {
      logger.info(`[redfin-enrichment] No listings need Redfin enrichment`);
      return listings as EnrichedListingRedfin[];
    }

    logger.info(
      `[redfin-enrichment] Enriching ${needsEnrichment.length}/${listings.length} listings ` +
        `from all platforms (concurrency: ${concurrency})`
    );

    const addresses = needsEnrichment.map((l) => getAddress(l)!);

    // Log skipped addresses (no street address)
    const skipped = listings.filter((l) => {
      const addr = getAddress(l);
      return addr && !hasStreetAddress(addr);
    });
    if (skipped.length > 0) {
      logger.warn(
        `[redfin-enrichment] Skipping ${skipped.length} listing(s) with no street address:`
      );
      skipped.forEach((l, idx) => {
        logger.warn(
          `  [${idx + 1}/${skipped.length}] "${getAddress(l)}" (no leading street number)`
        );
      });
    }

    // Log all addresses being sent to enricher
    logger.info(`[redfin-enrichment] Raw addresses from listings:`);
    addresses.forEach((addr, idx) => {
      logger.info(`  [${idx + 1}/${addresses.length}] "${addr}"`);
    });

    try {
      logger.info(`[redfin-enrichment] Sending ${addresses.length} address(es) to Redfin enricher...`);
      const estimates = await this.enricher.lookupBatch(addresses, { concurrency });

      // Map Redfin estimates back to listings
      const enriched: EnrichedListingRedfin[] = listings.map((listing) => {
        const address = getAddress(listing);
        const estimate = estimates.find((e) => e.rawInput === address);

        if (!estimate) {
          logger.info(
            `[redfin-enrichment] ✗ [${listing.source}] ${address} → no Redfin lookup result`
          );
          return listing as EnrichedListingRedfin;
        }

        if (!estimate.found) {
          logger.info(
            `[redfin-enrichment] ✗ [${listing.source}] ${address} → Redfin page not found or no estimate` +
              ` (error=${estimate.error ?? "unknown"}, propertyId=${estimate.propertyId ?? "N/A"})`
          );
          return listing as EnrichedListingRedfin;
        }

        if (estimate.redfinEstimate == null) {
          logger.info(
            `[redfin-enrichment] ✓ [${listing.source}] ${address} → Redfin property matched but estimate missing` +
              ` (propertyId=${estimate.propertyId ?? "N/A"}, address="${estimate.address}")`
          );
          return {
            ...listing,
            redfinSourceUrl: estimate.url ?? undefined,
          } as EnrichedListingRedfin;
        }

        logger.info(
          `[redfin-enrichment] ✓ [${listing.source}] ${address} → propertyId: ${estimate.propertyId ?? "N/A"}, estimate: $${estimate.redfinEstimate.toLocaleString()}`
        );

        return {
          ...listing,
          redfinEstimate: estimate.redfinEstimate ?? undefined,
          redfinEstimateLow: estimate.redfinEstimateLow ?? undefined,
          redfinEstimateHigh: estimate.redfinEstimateHigh ?? undefined,
          redfinSourceUrl: estimate.url ?? undefined,
        } as EnrichedListingRedfin;
      });

      const succeeded = enriched.filter((l) => l.redfinEstimate != null).length;
      logger.info(
        `[redfin-enrichment] Complete — ${succeeded}/${needsEnrichment.length} ` +
          `listings enriched with Redfin estimate`
      );

      return enriched;
    } catch (err) {
      logger.error(`[redfin-enrichment] Error during enrichment: ${err}`);
      return listings as EnrichedListingRedfin[];
    }
  }
}

export const redfinEnrichmentService = new RedfinEnrichmentService();
