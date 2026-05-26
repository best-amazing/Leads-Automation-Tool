/**
 * Unified address normalization service
 * Routes to source-specific normalizers to normalize addresses to different formats
 * (zillow, redfin, propwire) for matching against reference listing tables
 */

import { Listing } from "@prisma/client";
import { logger } from "../../utils/logger";

// Craigslist normalizers
import { normalizeToZillowFormat as craigslistToZillow } from "../../scrapers/craigslist/helpers/zillow-address-normalizer";
import { normalizeToRedfinFormat as craigslistToRedfin } from "../../scrapers/craigslist/helpers/redfin-address-normalizer";
import { normalizeToPropwireFormat as craigslistToPropwire } from "../../scrapers/craigslist/helpers/propwire-address-normalizer";

// Crexi normalizers
import { normalizeToZillowFormat as crexiToZillow } from "../../scrapers/crexi/helpers/zillow-address-normalizer";
import { normalizeToRedfinFormat as crexiToRedfin } from "../../scrapers/crexi/helpers/redfin-address-normalizer";
import { normalizeToPropwireFormat as crexiToPropwire } from "../../scrapers/crexi/helpers/propwire-address-normalizer";

// InvestorLift normalizers
import { normalizeToZillowFormat as investorliftToZillow } from "../../scrapers/investorlift/helpers/zillow-address-normalizer";
import { normalizeToRedfinFormat as investorliftToRedfin } from "../../scrapers/investorlift/helpers/redfin-address-normalizer";
import { normalizeToPropwireFormat as investorliftToPropwire } from "../../scrapers/investorlift/helpers/propwire-address-normalizer";

// Creative Listing normalizers
import { normalizeToZillowFormat as creativelistingToZillow } from "../../scrapers/creative-listing/helpers/zillow-address-normalizer";
import { normalizeToRedfinFormat as creativelistingToRedfin } from "../../scrapers/creative-listing/helpers/redfin-address-normalizer";
import { normalizeToPropwireFormat as creativelistingToPropwire } from "../../scrapers/creative-listing/helpers/propwire-address-normalizer";

export type EstimateSource = "zillow" | "redfin" | "propwire";

export interface NormalizedAddress {
  address: string | null;
  estimateSource: EstimateSource;
  listingSource: string;
}

/**
 * Main service: Routes listing address normalization to source-specific normalizers
 * Supports normalization to different estimate sources (zillow, redfin, propwire)
 */
export class AddressNormalizerService {
  /**
   * Normalize a Listing's address to a specific estimate source format
   * Routes based on listing source and target estimate source
   */
  static normalize(
    listing: Listing,
    targetEstimateSource: EstimateSource
  ): NormalizedAddress {
    try {
      const sourceLower = listing.source.toLowerCase();
      let normalizedAddress: string | undefined = undefined;

      // Create mock listing object with required fields
      const mockListing = {
        url: listing.url,
        address: listing.rawAddress || undefined,
        location: listing.location || undefined,
        source: listing.source
      };

      // Route to source-specific normalizer based on listing source AND target format
      if (sourceLower.startsWith("craigslist_")) {
        if (targetEstimateSource === "zillow") {
          normalizedAddress = craigslistToZillow(mockListing);
        } else if (targetEstimateSource === "redfin") {
          normalizedAddress = craigslistToRedfin(mockListing);
        } else if (targetEstimateSource === "propwire") {
          normalizedAddress = craigslistToPropwire(mockListing);
        }
      } else if (sourceLower.startsWith("crexi")) {
        if (targetEstimateSource === "zillow") {
          normalizedAddress = crexiToZillow(mockListing);
        } else if (targetEstimateSource === "redfin") {
          normalizedAddress = crexiToRedfin(mockListing);
        } else if (targetEstimateSource === "propwire") {
          normalizedAddress = crexiToPropwire(mockListing);
        }
      } else if (sourceLower.startsWith("investorlift")) {
        if (targetEstimateSource === "zillow") {
          normalizedAddress = investorliftToZillow(mockListing);
        } else if (targetEstimateSource === "redfin") {
          normalizedAddress = investorliftToRedfin(mockListing);
        } else if (targetEstimateSource === "propwire") {
          normalizedAddress = investorliftToPropwire(mockListing);
        }
      }

      // LoopNet: uses component-based matching (address-matcher) instead of format normalization
      // Returns raw address; estimate-matcher will use loopnetAddressMatchesPlatform() for matching
      else if (sourceLower.startsWith("loopnet")) {
        normalizedAddress = listing.rawAddress || undefined;
      } else if (sourceLower.startsWith("creativelisting")) {
        // Creative Listing stores addresses as concatenated strings
        const clMockListing = {
          url: listing.url,
          address: listing.rawAddress || undefined,
          location: listing.location || undefined,
          source: listing.source
        };
        if (targetEstimateSource === "zillow") {
          normalizedAddress = creativelistingToZillow(clMockListing);
        } else if (targetEstimateSource === "redfin") {
          normalizedAddress = creativelistingToRedfin(clMockListing);
        } else if (targetEstimateSource === "propwire") {
          normalizedAddress = creativelistingToPropwire(clMockListing);
        }
      }

      return {
        address: normalizedAddress ?? null,
        estimateSource: targetEstimateSource,
        listingSource: listing.source,
      };
    } catch (error) {
      logger.error(
        `[AddressNormalizer] Error normalizing listing ${listing.id} from ${listing.source} to ${targetEstimateSource}:`,
        error
      );
      return {
        address: null,
        estimateSource: targetEstimateSource,
        listingSource: listing.source,
      };
    }
  }

  /**
   * Check if a source has normalizers available
   */
  static supportsSource(source: string): boolean {
    const sourceLower = source.toLowerCase();
    return (
      sourceLower.startsWith("craigslist_") ||
      sourceLower.startsWith("crexi") ||
      sourceLower.startsWith("investorlift") ||
      sourceLower.startsWith("loopnet") ||
      sourceLower.startsWith("creativelisting")
    );
  }
}
