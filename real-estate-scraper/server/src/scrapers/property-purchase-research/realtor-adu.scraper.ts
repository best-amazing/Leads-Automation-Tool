import { RawListing } from "../../types/listing";
import { RealtorScraper } from "../realtor/realtor.scraper";
import { ScraperOptions } from "../base.scraper";
import { AduResearchListing } from "./adu-research.parser";
import { passesAduFilter } from "./adu-research.scraper";
import { logger } from "../../utils/logger";
import { ADU_KEYWORDS } from "./adu-keywords";

export class RealtorAduScraper extends RealtorScraper {
  readonly sourceName = "realtor-adu";

  constructor(options: ScraperOptions = {}) {
    super(options);
  }

  async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting ADU research scrape via Realtor`);
    
    // Call base run() which scrapes all configured markets
    const rawResults = await super.run();
    
    const aduListings: AduResearchListing[] = rawResults.map(listing => {
      // Find matching keyword for QA
      const haystack = [listing.title, listing.description, listing.address]
          .join(" ")
          .toLowerCase();
      
      const matchedKeyword = ADU_KEYWORDS.find((kw) => {
        const regex = new RegExp(`\\b${kw}\\b`, 'i');
        return regex.test(haystack);
      });

      // Extract zip from address
      let zip: string | undefined;
      if (listing.address) {
        const match = listing.address.match(/\b\d{5}(-\d{4})?\b/);
        if (match) zip = match[0];
      }

      return {
        ...listing,
        source: this.sourceName,
        totalBedrooms: listing.bedrooms, // Fallback to main bed count
        matchedKeyword,
        zip,
      } as AduResearchListing;
    });

    const filtered = aduListings.filter(l => passesAduFilter(l));
    
    logger.info(`[${this.sourceName}] ✓ ${filtered.length} listings passed ADU keyword filter (out of ${aduListings.length} total)`);
    
    return filtered;
  }
}
