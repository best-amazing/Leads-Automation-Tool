// src/scrapers/property-purchase-research/sources/offmarket-adu.scraper.ts

import { RawListing } from "../../../types/listing";
import { OffmarketScraper } from "../../offmarket/offmarket.scraper";
import { ScraperOptions } from "../../base.scraper";
import { AduResearchListing } from "../core/adu-research.parser";
import {
  passesLocationFilter,
  passesKeywordFilter,
  passesPropertyCriteria,
} from "../filters/adu-research.scraper";
import { logger } from "../../../utils/logger";
import { ADU_KEYWORDS, TARGET_STATES } from "../core/adu-keywords";

export class OffmarketAduScraper extends OffmarketScraper {
  readonly sourceName: string = "offmarket-adu";

  constructor(options: ScraperOptions = {}) {
    // offmarket.com geo-blocks non-US IPs; the rotating PROXY_URLS pool is
    // currently dead for this site, so fall back to the Creative Listing US
    // residential proxy (known to work from the count script).
    const proxyUrl =
      options.proxyUrl !== undefined
        ? options.proxyUrl
        : process.env.CL_PROXY_URL || null;

    super({ ...options, states: TARGET_STATES, cities: [], proxyUrl });
  }

  /**
   * Bypass the base price/location/relevance filter — the ADU keyword +
   * criteria pipeline decides what matches. We still want every offmarket
   * listing that survives the scraper's own state/detail enrichment.
   */
  protected passesFilter(_listing: RawListing): boolean {
    return true;
  }

  protected isRelevant(_listing: RawListing): boolean {
    return true;
  }

  async run(): Promise<RawListing[]> {
    logger.info(
      `[${this.sourceName}] Starting ADU research scrape via offmarket.com (states: ${TARGET_STATES.join(", ")})`,
    );

    const rawResults = await super.run();

    const aduListings: AduResearchListing[] = rawResults.map((listing) => {
      const haystack = [listing.title, listing.description, listing.address]
        .join(" ")
        .toLowerCase();

      const matchedKeyword = ADU_KEYWORDS.find((kw) => {
        const regex = new RegExp(
          `\\b${kw.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}\\b`,
          "i",
        );
        return regex.test(haystack);
      });

      let zip: string | undefined;
      if (listing.address) {
        const match = listing.address.match(/\b\d{5}(?:-\d{4})?\b/);
        if (match) zip = match[0];
      }

      return {
        ...listing,
        source: this.sourceName,
        totalBedrooms: listing.bedrooms,
        matchedKeyword,
        zip,
      } as AduResearchListing;
    });

    const filtered = aduListings.filter(
      (l) =>
        passesLocationFilter(l) &&
        passesKeywordFilter(l) &&
        passesPropertyCriteria(l),
    );

    logger.info(
      `[${this.sourceName}] ✓ ${filtered.length} listings passed ADU filters (out of ${aduListings.length} total)`,
    );

    if (this.options.onMatch) {
      for (const item of filtered) {
        await this.options.onMatch(item);
      }
    }

    return filtered;
  }
}