/**
 * Estimate matcher service
 * Finds matching listings in reference tables (Zillow, Redfin, Propwire)
 * based on normalized addresses and extracts estimate values
 * 
 * For LoopNet: Uses component-based matching (address-matcher) instead of substring matching
 */

import { prisma } from "../../db/client";
import { logger } from "../../utils/logger";
import { EstimateSource } from "./address-normalizer";
import { loopnetAddressMatchesPlatform } from "../../scrapers/loopnet/helpers/address-matcher";
import { Listing } from "@prisma/client";

export interface EstimateMatch {
  found: boolean;
  estimateSource: EstimateSource;
  estimateValue: number | null;
  matchedAddress: string | null;
  sourceListingId: string | null; // ID of the ZillowListing/RedfinListing/etc.
}

/**
 * Find matching listing record for a normalized address
 * Queries the appropriate *Listing table based on estimate source
 * 
 * For LoopNet sources: Uses address-matcher for component-based matching
 * For other sources: Uses substring (ILIKE) matching
 */
export async function findEstimateMatch(
  normalizedAddress: string,
  estimateSource: EstimateSource,
  listing?: Listing  // Optional: needed for LoopNet address-matcher
): Promise<EstimateMatch> {
  try {
    if (!normalizedAddress) {
      return {
        found: false,
        estimateSource,
        estimateValue: null,
        matchedAddress: null,
        sourceListingId: null,
      };
    }

    let estimateValue: number | null = null;
    let matchedAddress: string | null = null;
    let sourceListingId: string | null = null;

    // Special handling for LoopNet: uses component-based matching (address-matcher)
    if (listing && listing.source.toLowerCase().startsWith("loopnet")) {
      return findLoopnetEstimateMatch(listing, estimateSource);
    }

    // For other sources: use substring (ILIKE) matching
    if (estimateSource === "zillow") {
      // Query ZillowListing table by address
      logger.debug(`[EstimateMatcher] Searching Zillow for normalized address: "${normalizedAddress}"`);
      const zillowMatch = await prisma.zillowListing.findFirst({
        where: {
          address: {
            contains: normalizedAddress,
            mode: "insensitive",
          },
        },
      });

      if (zillowMatch) {
        estimateValue = zillowMatch.zestimate;
        matchedAddress = zillowMatch.address;
        sourceListingId = zillowMatch.id;
        logger.debug(`[EstimateMatcher] ✓ Zillow match found: "${matchedAddress}" = $${estimateValue}`);
      } else {
        logger.debug(`[EstimateMatcher] ✗ No Zillow match for: "${normalizedAddress}"`);
      }
    } else if (estimateSource === "redfin") {
      // Query RedfinListing table by address
      logger.debug(`[EstimateMatcher] Searching Redfin for normalized address: "${normalizedAddress}"`);
      const redfinMatch = await prisma.redfinListing.findFirst({
        where: {
          address: {
            contains: normalizedAddress,
            mode: "insensitive",
          },
        },
      });

      if (redfinMatch) {
        estimateValue = redfinMatch.estimate;
        matchedAddress = redfinMatch.address;
        sourceListingId = redfinMatch.id;
        logger.debug(`[EstimateMatcher] ✓ Redfin match found: "${matchedAddress}" = $${estimateValue}`);
      } else {
        logger.debug(`[EstimateMatcher] ✗ No Redfin match for: "${normalizedAddress}"`);
      }
      
    } else if (estimateSource === "propwire") {
      // Query PropwireListing table by address
      logger.debug(`[EstimateMatcher] Searching Propwire for normalized address: "${normalizedAddress}"`);
      const propwireMatch = await prisma.propwireListing.findFirst({
        where: {
          address: {
            contains: normalizedAddress,
            mode: "insensitive",
          },
        },
      });

      if (propwireMatch) {
        estimateValue = propwireMatch.estimate;
        matchedAddress = propwireMatch.address;
        sourceListingId = propwireMatch.id;
        logger.debug(`[EstimateMatcher] ✓ Propwire match found: "${matchedAddress}" = $${estimateValue}`);
      } else {
        logger.debug(`[EstimateMatcher] ✗ No Propwire match for: "${normalizedAddress}"`);
      }
    }

    return {
      found: estimateValue !== null && estimateValue !== undefined,
      estimateSource,
      estimateValue,
      matchedAddress,
      sourceListingId,
    };
  } catch (error) {
    logger.error(
      `[EstimateMatcher] Error matching ${estimateSource} listing for address "${normalizedAddress}":`,
      error
    );
    return {
      found: false,
      estimateSource,
      estimateValue: null,
      matchedAddress: null,
      sourceListingId: null,
    };
  }
}

/**
 * Find matching listing for LoopNet using component-based address matching (address-matcher)
 * Iterates through candidates and uses loopnetAddressMatchesPlatform to check for matches
 */
async function findLoopnetEstimateMatch(
  loopnetListing: Listing,
  estimateSource: EstimateSource
): Promise<EstimateMatch> {
  try {
    logger.debug(
      `[EstimateMatcher] LoopNet address matching for ${estimateSource}: "${loopnetListing.rawAddress}"`
    );

    // Convert Listing to RawListing-like object for address-matcher
    // Convert null values to undefined to match RawListing type
    const rawListing = {
      url: loopnetListing.url,
      address: loopnetListing.rawAddress || undefined,
      location: loopnetListing.location || undefined,
      source: loopnetListing.source,
    };

    if (estimateSource === "zillow") {
      // Fetch all Zillow listings and check each with address-matcher
      const zillowListings = await prisma.zillowListing.findMany();
      for (const zListing of zillowListings) {
        if (loopnetAddressMatchesPlatform(rawListing, zListing.address)) {
          logger.debug(
            `[EstimateMatcher] ✓ LoopNet/Zillow match found: "${zListing.address}" = $${zListing.zestimate}`
          );
          return {
            found: true,
            estimateSource: "zillow",
            estimateValue: zListing.zestimate,
            matchedAddress: zListing.address,
            sourceListingId: zListing.id,
          };
        }
      }
      logger.debug(`[EstimateMatcher] ✗ No LoopNet/Zillow match for: "${loopnetListing.rawAddress}"`);
    } else if (estimateSource === "redfin") {
      // Fetch all Redfin listings and check each with address-matcher
      const redfinListings = await prisma.redfinListing.findMany();
      for (const rListing of redfinListings) {
        if (loopnetAddressMatchesPlatform(rawListing, rListing.address)) {
          logger.debug(
            `[EstimateMatcher] ✓ LoopNet/Redfin match found: "${rListing.address}" = $${rListing.estimate}`
          );
          return {
            found: true,
            estimateSource: "redfin",
            estimateValue: rListing.estimate,
            matchedAddress: rListing.address,
            sourceListingId: rListing.id,
          };
        }
      }
      logger.debug(`[EstimateMatcher] ✗ No LoopNet/Redfin match for: "${loopnetListing.rawAddress}"`);
    } else if (estimateSource === "propwire") {
      // Fetch all Propwire listings and check each with address-matcher
      const propwireListings = await prisma.propwireListing.findMany();
      for (const pListing of propwireListings) {
        if (loopnetAddressMatchesPlatform(rawListing, pListing.address)) {
          logger.debug(
            `[EstimateMatcher] ✓ LoopNet/Propwire match found: "${pListing.address}" = $${pListing.estimate}`
          );
          return {
            found: true,
            estimateSource: "propwire",
            estimateValue: pListing.estimate,
            matchedAddress: pListing.address,
            sourceListingId: pListing.id,
          };
        }
      }
      logger.debug(`[EstimateMatcher] ✗ No LoopNet/Propwire match for: "${loopnetListing.rawAddress}"`);
    }

    return {
      found: false,
      estimateSource,
      estimateValue: null,
      matchedAddress: null,
      sourceListingId: null,
    };
  } catch (error) {
    logger.error(
      `[EstimateMatcher] Error in LoopNet address matching for ${estimateSource}:`,
      error
    );
    return {
      found: false,
      estimateSource,
      estimateValue: null,
      matchedAddress: null,
      sourceListingId: null,
    };
  }
}
