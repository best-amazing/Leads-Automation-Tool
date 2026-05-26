/**
 * Enrichment pipeline: Normalize addresses and match against reference tables
 * 1. Normalizes address to zillow/redfin/propwire formats
 * 2. Finds matching records in corresponding *Listing tables
 * 3. Creates Property and Estimate records when matches are found
 */

import { prisma } from "../../db/client";
import { AddressNormalizerService, EstimateSource } from "./address-normalizer";
import { findEstimateMatch } from "./estimate-matcher";
import { logger } from "../../utils/logger";

export interface EnrichmentStats {
  processed: number;
  linked: number;
  estimatesCreated: number;
  skipped: number;
  failed: number;
  duration_ms: number;
}

// Estimate sources to try for each listing
const ESTIMATE_SOURCES: EstimateSource[] = ["zillow", "redfin", "propwire"];

/**
 * Enrich all unlinked listings for a specific source
 * Normalizes addresses to different formats and matches against reference tables
 */
export async function enrichListingsBySource(source: string): Promise<EnrichmentStats> {
  const startTime = Date.now();
  let processed = 0;
  let linked = 0;
  let estimatesCreated = 0;
  let skipped = 0;
  let failed = 0;

  logger.info(`[Enrichment] Starting enrichment for source: ${source}`);

  // Check if this source has normalizers
  if (!AddressNormalizerService.supportsSource(source)) {
    logger.info(`[Enrichment] Source ${source} not yet supported for enrichment — skipping`);
    return {
      processed: 0,
      linked: 0,
      estimatesCreated: 0,
      skipped: 0,
      failed: 0,
      duration_ms: 0,
    };
  }

  try {
    // Get all listings for this source (recheck all, not just unlinked)
    const allListings = await prisma.listing.findMany({
      where: {
        source,
      },
    });

    logger.info(
      `[Enrichment] Found ${allListings.length} listings for ${source}`
    );

    // Process each listing
    for (const listing of allListings) {
      try {
        let propertyId: string | null = null;

        logger.info(
          `[Enrichment] Processing listing ${listing.id}: "${listing.rawAddress || 'N/A'}"`
        );

        // Try each estimate source (zillow, redfin, propwire)
        for (const estimateSource of ESTIMATE_SOURCES) {
          try {
            // Normalize address to this estimate source's format
            const normalized = AddressNormalizerService.normalize(listing, estimateSource);

            if (!normalized.address) {
              logger.debug(
                `[Enrichment] Listing ${listing.id}: Could not normalize to ${estimateSource} format`
              );
              continue;
            }

            logger.debug(
              `[Enrichment] Listing ${listing.id}: Checking ${estimateSource} with normalized address: "${normalized.address}"`
            );

            // Find matching record in reference table
            // For LoopNet: passes listing object to use address-matcher
            const match = await findEstimateMatch(normalized.address, estimateSource, listing);

            if (match.found && match.estimateValue) {
              logger.info(
                `[Enrichment] ✓ MATCH FOUND - Listing ${listing.id} matched on ${estimateSource}: "${normalized.address}" = $${match.estimateValue}`
              );

              // Create or find Property using the normalized address as canonical key
              const property = await prisma.property.upsert({
                where: { normalizedAddress: normalized.address },
                create: {
                  normalizedAddress: normalized.address,
                  address: listing.rawAddress || match.matchedAddress || undefined,
                  url: listing.url,
                },
                update: {
                  url: listing.url,
                  updatedAt: new Date(),
                },
              });

              propertyId = property.id;

              // If we have a sourceListingId, re-fetch the canonical source
              // listing record and use its native estimate field to ensure
              // we copy the exact value from the matched record.
              let valueToUse = match.estimateValue;
              try {
                if (match.sourceListingId) {
                  if (estimateSource === "zillow") {
                    const src = await prisma.zillowListing.findUnique({ where: { id: match.sourceListingId } });
                    if (src && src.zestimate != null) valueToUse = src.zestimate;
                  } else if (estimateSource === "redfin") {
                    const src = await prisma.redfinListing.findUnique({ where: { id: match.sourceListingId } });
                    if (src && src.estimate != null) valueToUse = src.estimate;
                  } else if (estimateSource === "propwire") {
                    const src = await prisma.propwireListing.findUnique({ where: { id: match.sourceListingId } });
                    if (src && src.estimate != null) valueToUse = src.estimate;
                  }
                }
              } catch (e) {
                logger.debug(`[Enrichment] Failed to re-fetch source listing ${match.sourceListingId} from ${estimateSource}: ${e}`);
              }

              // Create or update Estimate record with authoritative value
              await prisma.estimate.upsert({
                where: {
                  propertyId_source: {
                    propertyId: property.id,
                    source: estimateSource,
                  },
                },
                create: {
                  propertyId: property.id,
                  source: estimateSource,
                  value: valueToUse,
                  sourceListingId: match.sourceListingId,
                },
                update: {
                  value: valueToUse,
                  sourceListingId: match.sourceListingId,
                  fetchedAt: new Date(),
                },
              });

              estimatesCreated++;
            }
          } catch (error) {
            logger.error(
              `[Enrichment] Error processing ${estimateSource} for listing ${listing.id}:`,
              error
            );
          }
        }

        // If we found matches and created a property, link the listing
        if (propertyId) {
          await prisma.listing.update({
            where: { id: listing.id },
            data: { propertyId },
          });
          linked++;
        } else {
          logger.info(
            `[Enrichment] ✗ SKIPPED - Listing ${listing.id} (${listing.rawAddress  || 'N/A'}) - No matches found in zillow/redfin/propwire reference tables`
          );
          skipped++;
        }

        processed++;
      } catch (error) {
        logger.error(
          `[Enrichment] Error processing listing ${listing.id}:`,
          error
        );
        failed++;
        processed++;
      }
    }

    const duration_ms = Date.now() - startTime;

    logger.info(
      `[Enrichment] Completed for ${source}: ${linked} linked, ${estimatesCreated} estimates created, ${skipped} skipped, ${failed} failed in ${duration_ms}ms`
    );

    return { processed, linked, estimatesCreated, skipped, failed, duration_ms };
  } catch (error) {
    logger.error(`[Enrichment] Fatal error enriching source ${source}:`, error);
    throw error;
  }
}
