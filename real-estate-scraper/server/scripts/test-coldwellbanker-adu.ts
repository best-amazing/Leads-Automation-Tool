// scripts/test-coldwellbanker-adu.ts
// ─────────────────────────────────────────────────────────────────────────────
// Smoke test for the Coldwell Banker ADU pipeline.
//
//   node -r dotenv/config -r ts-node/register scripts/test-coldwellbanker-adu.ts
//
// Stages:
//   1. Sitemap discovery (new-day) — count OH listing URLs
//   2. Detail fetch + parse of 3 listings — print mapped fields
//   3. Mini end-to-end run of ColdwellBankerAduScraper (MAX_LISTINGS=15)
//      with the real filter chain; matches stream to CSV/JSON locally.
//      Google Sheets upload only when CB_TEST_SHEETS=true.
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import {
  ColdwellBankerScraper,
  discoverTargetListingUrls,
  extractLid,
} from "../src/scrapers/coldwellbanker/coldwellbanker.scraper";
import { ColdwellBankerAduScraper } from "../src/scrapers/property-purchase-research/coldwellbanker-adu.scraper";
import { appendAduResult } from "../src/scrapers/property-purchase-research/adu-csv-writer";
import { AduResearchListing } from "../src/scrapers/property-purchase-research/adu-research.parser";
import { logger } from "../src/utils/logger";

async function stage1Discovery(): Promise<string[]> {
  console.log("\n═══ Stage 1: sitemap discovery ═══");
  const urls = await discoverTargetListingUrls("new-day");
  console.log(`OH URLs discovered: ${urls.length}`);
  if (urls.length > 0) {
    console.log("sample:", urls[0]);
  }
  return urls;
}

async function stage2DetailParse(urls: string[]): Promise<void> {
  console.log("\n═══ Stage 2: detail fetch + parse (3 listings) ═══");
  const scraper = new ColdwellBankerScraper();
  for (const url of urls.slice(0, 3)) {
    const listing = await scraper.fetchListingDetail(url);
    if (!listing) {
      console.log(`✗ ${extractLid(url)} — no data (non-ACTIVE or fetch failed)`);
      continue;
    }
    console.log(`✓ ${extractLid(url)}`);
    console.log(`   address:    ${listing.address}`);
    console.log(`   price:      ${listing.price?.toLocaleString()}`);
    console.log(`   beds/baths: ${listing.bedrooms}/${listing.bathrooms}`);
    console.log(`   sqft/lot:   ${listing.squareFeet ?? "?"} / ${listing.lotSqft ?? "?"}`);
    console.log(`   year:       ${listing.yearBuilt ?? "?"}`);
    console.log(`   status/DOM: ${listing.status} / ${listing.daysOnMarket ?? "?"}`);
    console.log(`   desc:       ${(listing.description ?? "").slice(0, 100).replace(/\n/g, " ")}`);
  }
}

async function stage3Pipeline(): Promise<void> {
  console.log("\n═══ Stage 3: mini ADU pipeline run (MAX_LISTINGS=15) ═══");
  let matchCount = 0;

  const scraper = new ColdwellBankerAduScraper({
    maxListings: 15,
    onMatch: async (listing: AduResearchListing) => {
      matchCount++;
      // Local CSV/JSON only unless CB_TEST_SHEETS=true (avoids polluting prod sheet)
      appendAduResult(listing);
      if (process.env.CB_TEST_SHEETS === "true") {
        const { writeAduResearchToSheets } = await import("../src/utils/google-sheets");
        await writeAduResearchToSheets([listing]);
      }
    },
  });

  const results = await scraper.run();
  console.log(`\nPipeline finished: ${results.length} ADU keyword match(es), onMatch fired ${matchCount}x`);
  for (const r of results) {
    console.log(`   ✓ [${(r as AduResearchListing).matchedKeyword}] ${r.address} @ $${r.price?.toLocaleString()}`);
  }
}

async function main() {
  try {
    const urls = await stage1Discovery();
    if (urls.length === 0) throw new Error("discovery returned 0 OH URLs");
    await stage2DetailParse(urls);
    await stage3Pipeline();
    console.log("\n✅ All stages completed");
  } catch (err) {
    logger.error(`Smoke test failed: ${err instanceof Error ? err.message : err}`);
    process.exitCode = 1;
  } finally {
    process.exit(process.exitCode ?? 0);
  }
}

main();
