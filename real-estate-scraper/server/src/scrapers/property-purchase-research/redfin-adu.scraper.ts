import { RawListing } from "../../types/listing";
import { RedfinScraper } from "../redfin/redfin.scraper";
import { ScraperOptions } from "../base.scraper";
import { AduResearchListing } from "./adu-research.parser";
import { passesLocationFilter, passesKeywordFilter, passesPropertyCriteria } from "./adu-research.scraper";
import { logger } from "../../utils/logger";
import { ADU_KEYWORDS } from "./adu-keywords";

export class RedfinAduScraper extends RedfinScraper {
  readonly sourceName: string = "redfin-adu";

  constructor(options: ScraperOptions = {}) {
    // The ADU pipeline filters on listing.price (from GIS Phase 1), not AVM
    // estimates. belowTheFold is 403-blocked and the HTML fallback is
    // WAF-blocked (405), so Phase 2 would burn ~3 slow Oxylabs calls per
    // listing for no ADU value. Skip it entirely.
    //
    // allListings: the JSON GIS endpoint only ever returns Active listings,
    // so pull the rest (Contingent + Sold) via the GIS CSV endpoint too.
    options = { ...options, skipAvmEnrichment: true, allListings: true };
    super(options);
  }

  async run(): Promise<RawListing[]> {
    logger.info(`[${this.sourceName}] Starting ADU research scrape via Redfin`);
    
    const rawResults = await super.run();
    
    const aduListings: AduResearchListing[] = rawResults.map(listing => {
      const haystack = [listing.title, listing.description, listing.address]
          .join(" ")
          .toLowerCase();
      
      const matchedKeyword = ADU_KEYWORDS.find((kw) => {
        const regex = new RegExp(`\\b${kw.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&')}\\b`, 'i');
        return regex.test(haystack);
      });

      let zip: string | undefined;
      if (listing.address) {
        const match = listing.address.match(/\b\d{5}(-\d{4})?\b/);
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

    const filtered = aduListings.filter(l => 
      passesLocationFilter(l) && 
      passesKeywordFilter(l) && 
      passesPropertyCriteria(l)
    );
    
    logger.info(`[${this.sourceName}] ✓ ${filtered.length} listings passed ADU filters (out of ${aduListings.length} total)`);
    
    if (this.options.onMatch) {
      for (const item of filtered) {
        await this.options.onMatch(item);
      }
    }

    return filtered;
  }
}
