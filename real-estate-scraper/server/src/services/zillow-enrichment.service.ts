// src/services/zillow-enrichment.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Universal Zillow enrichment service for all platforms
//
// Purpose: Take ANY listing from ANY platform (Crexi, Redfin, etc.), pass its
// address to Zillow via Oxylabs API, and if a zestimate is found, create
// Property + Estimate records with source="zillow".
//
// This replaces the old address-matching enrichment pipeline.
// ─────────────────────────────────────────────────────────────────────────────

import { RawListing } from "../types/listing";
import { ZillowAddressEnricher, ZillowEstimate } from "../scrapers/zillow/zillow.address.enricher";
import { logger } from "../utils/logger";

/**
 * Enriched listing with Zillow data
 * Extends RawListing with optional enrichment fields
 */
export interface EnrichedListing extends RawListing {
  zestimateLow?: number;
  zestimateHigh?: number;
}

export class ZillowEnrichmentService {
  private enricher = new ZillowAddressEnricher();

  /**
   * Enrich ANY listings from ANY platform with Zillow zestimates
   * Skips listings that already have zestimate populated
   */
  async enrichAllListings(
    listings: RawListing[],
    concurrency: number = 2
  ): Promise<EnrichedListing[]> {
    const getAddress = (listing: RawListing) => listing.address ?? (listing as any).rawAddress;

    // Filter listings that need enrichment (have address, no zestimate yet)
    const needsEnrichment = listings.filter(
      (l) => getAddress(l) && (l.zestimate == null || (l as any).zestimate === undefined)
    );

    if (needsEnrichment.length === 0) {
      logger.info(`[zillow-enrichment] No listings need enrichment`);
      return listings as EnrichedListing[];
    }

    logger.info(
      `[zillow-enrichment] Enriching ${needsEnrichment.length}/${listings.length} listings ` +
        `from all platforms (concurrency: ${concurrency})`
    );

    const addresses = needsEnrichment.map((l) => getAddress(l)!);

    // Log all addresses being sent to enricher
    logger.info(`[zillow-enrichment] Raw addresses from listings:`);
    addresses.forEach((addr, idx) => {
      logger.info(`  [${idx + 1}/${addresses.length}] "${addr}"`);
    });

    try {
      logger.info(`[zillow-enrichment] Sending ${addresses.length} address(es) to Zillow enricher...`);
      const estimates = await this.enricher.lookupBatch(addresses, { concurrency });

      // Map zestimates back to listings
      const enriched: EnrichedListing[] = listings.map((listing) => {
        const address = getAddress(listing);
        const estimate = estimates.find((e) => e.rawInput === address);

        if (!estimate) {
          logger.info(
            `[zillow-enrichment] ✗ [${listing.source}] ${address} → no Zillow lookup result`
          );
          return listing as EnrichedListing;
        }

        if (!estimate.found) {
          logger.info(
            `[zillow-enrichment] ✗ [${listing.source}] ${address} → Zillow page not found or no estimate` +
              ` (error=${estimate.error ?? "unknown"}, zpid=${estimate.zpid ?? "N/A"}, address="${estimate.address}")`
          );
          return listing as EnrichedListing;
        }

        if (estimate.zestimate == null) {
          logger.info(
            `[zillow-enrichment] ✓ [${listing.source}] ${address} → Zillow property matched but zestimate missing` +
              ` (zpid=${estimate.zpid ?? "N/A"}, address="${estimate.address}")`
          );
          return {
            ...listing,
            zpid: estimate.zpid ?? undefined,
          } as EnrichedListing;
        }

        logger.info(
          `[zillow-enrichment] ✓ [${listing.source}] ${address} → zpid: ${estimate.zpid ?? "N/A"}, zestimate: $${estimate.zestimate.toLocaleString()}`
        );

        return {
          ...listing,
          zpid: estimate.zpid ?? undefined,
          zestimate: estimate.zestimate ?? undefined,
          zestimateLow: estimate.zestimateLow ?? undefined,
          zestimateHigh: estimate.zestimateHigh ?? undefined,
        } as EnrichedListing;
      });

      const succeeded = enriched.filter((l) => l.zestimate != null).length;
      logger.info(
        `[zillow-enrichment] Complete — ${succeeded}/${needsEnrichment.length} ` +
          `listings enriched with Zillow zestimate`
      );

      return enriched;
    } catch (err) {
      logger.error(`[zillow-enrichment] Error during enrichment: ${err}`);
      return listings as EnrichedListing[];
    }
  }
}

export const zillowEnrichmentService = new ZillowEnrichmentService();
