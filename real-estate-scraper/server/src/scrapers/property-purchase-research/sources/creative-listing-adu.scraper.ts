import { RawListing } from "../../../types/listing";
import { CreativeListingScraper } from "../../creative-listing/creative-listing.scraper";
import { ScraperOptions } from "../../base.scraper";
import { AduResearchListing } from "../core/adu-research.parser";
import {
  passesLocationFilter,
  passesKeywordFilter,
  passesPropertyCriteria,
} from "../filters/adu-research.scraper";
import { logger } from "../../../utils/logger";
import { ADU_KEYWORDS } from "../core/adu-keywords";

export class CreativeListingAduScraper extends CreativeListingScraper {
  readonly sourceName: string = "creative-listing-adu";

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  async run(): Promise<RawListing[]> {
    logger.info(
      `[${this.sourceName}] Starting ADU research scrape via Creative Listing`,
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
