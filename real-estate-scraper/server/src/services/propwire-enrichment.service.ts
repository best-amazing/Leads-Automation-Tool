// src/services/propwire-enrichment.service.ts
// ─────────────────────────────────────────────────────────────────────────────
// Universal Propwire enrichment service for all platforms
//
// Purpose: Take ANY listing from ANY platform (Crexi, Redfin, Zillow, etc.),
// pass its address to Propwire, and if an estimate is found, attach it to the
// listing payload for later DB upsert and scoring.
// ─────────────────────────────────────────────────────────────────────────────

import { RawListing } from "../types/listing";
import { PropwireAddressEnricher } from "../scrapers/propwire/propwire.address.enricher";
import { logger } from "../utils/logger";

export interface EnrichedListingPropwire extends RawListing {
  propwireEstimate?: number;
}

export class PropwireEnrichmentService {
  private enricher = new PropwireAddressEnricher();

  async enrichAllListings(
    listings: RawListing[],
    concurrency: number = 1
  ): Promise<EnrichedListingPropwire[]> {
    const getAddress = (listing: RawListing) => listing.address ?? (listing as any).rawAddress;

    const needsEnrichment = listings.filter(
      (l) => getAddress(l) && (l.propwireEstimate == null || (l as any).propwireEstimate === undefined)
    );

    if (needsEnrichment.length === 0) {
      logger.info(`[propwire-enrichment] No listings need Propwire enrichment`);
      return listings as EnrichedListingPropwire[];
    }

    logger.info(
      `[propwire-enrichment] Enriching ${needsEnrichment.length}/${listings.length} listings ` +
        `from all platforms (concurrency: ${concurrency})`
    );

    const addresses = needsEnrichment.map((l) => getAddress(l)!);
    logger.info(`[propwire-enrichment] Raw addresses from listings:`);
    addresses.forEach((addr, idx) => {
      logger.info(`  [${idx + 1}/${addresses.length}] "${addr}"`);
    });

    try {
      logger.info(`[propwire-enrichment] Sending ${addresses.length} address(es) to Propwire enricher...`);
      const estimates = await this.enricher.lookupBatch(addresses, { concurrency });

      const enriched: EnrichedListingPropwire[] = listings.map((listing) => {
        const address = getAddress(listing);
        const estimate = estimates.find((e) => e.rawInput === address);

        if (!estimate) {
          logger.info(
            `[propwire-enrichment] ✗ [${listing.source}] ${address} → no Propwire lookup result`
          );
          return listing as EnrichedListingPropwire;
        }

        if (!estimate.found) {
          logger.info(
            `[propwire-enrichment] ✗ [${listing.source}] ${address} → Propwire page not found or no estimate` +
              ` (error=${estimate.error ?? "unknown"}, propertyId=${estimate.propertyId ?? "N/A"}, address="${estimate.address}")`
          );
          return listing as EnrichedListingPropwire;
        }

        if (estimate.propwireEstimate == null) {
          logger.info(
            `[propwire-enrichment] ✓ [${listing.source}] ${address} → Propwire matched but estimate missing` +
              ` (propertyId=${estimate.propertyId ?? "N/A"}, address="${estimate.address}")`
          );
          return {
            ...listing,
            propwireSourceUrl: estimate.url ?? listing.propwireSourceUrl,
          } as EnrichedListingPropwire;
        }

        logger.info(
          `[propwire-enrichment] ✓ [${listing.source}] ${address} → propertyId: ${estimate.propertyId ?? "N/A"}, estimate: $${estimate.propwireEstimate.toLocaleString()}`
        );

        return {
          ...listing,
          propwireEstimate: estimate.propwireEstimate,
          propwireSourceUrl: estimate.url ?? listing.propwireSourceUrl,
        } as EnrichedListingPropwire;
      });

      const succeeded = enriched.filter((l) => l.propwireEstimate != null).length;
      logger.info(
        `[propwire-enrichment] Complete — ${succeeded}/${needsEnrichment.length} listings enriched with Propwire estimate`
      );

      return enriched;
    } catch (err) {
      logger.error(`[propwire-enrichment] Error during enrichment: ${err}`);
      return listings as EnrichedListingPropwire[];
    }
  }
}

export const propwireEnrichmentService = new PropwireEnrichmentService();
