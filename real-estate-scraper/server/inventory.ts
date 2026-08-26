import * as fs from "fs";
import { config } from "./src/config";
import { oxylabsFetch } from "./src/scrapers/zillow/zillow.scraper";

async function run() {
  console.log("═══ ADU Inventory Report ═══");

  // 1. Coldwell Banker
  try {
    const cbRes = await fetch("https://www.coldwellbankerhomes.com/sitemapindex-listings.xml");
    const cbXml = await cbRes.text();
    // Count all <loc> tags that end with /oh/ (representing OH chunk sitemaps)
    // Then we would have to fetch each one to count, which is too slow.
    // Instead we can just do a very rough estimate or check the recent one.
    const ohioSitemaps = [...cbXml.matchAll(/<loc>(.*?\/sitemap-listings-oh-.*?\.xml)<\/loc>/g)].map(m => m[1]);
    console.log(`Coldwell Banker: Found ${ohioSitemaps.length} Ohio sitemaps (roughly ${ohioSitemaps.length * 20000} listings max)`);
  } catch (err) {
    console.log("Coldwell Banker: Error fetching sitemap");
  }

  // 2. Redfin (Columbus)
  try {
    const market = config.sources.redfin.markets.find(m => m.name === "Columbus, OH");
    if (market) {
      const rfRes = await fetch(`https://www.redfin.com/stingray/api/gis?al=1&region_id=${market.regionId}&region_type=${market.regionType}&uipt=1,4&max_price=9999999&num_homes=50&start=0&status=1&sf=1,2,3,5,6,7&ord=price-desc`);
      const text = await rfRes.text();
      const jsonStr = text.replace('{}&&', '');
      const data = JSON.parse(jsonStr);
      console.log(`Redfin (Columbus OH): ${data?.payload?.exactMatch?.numHomes ?? data?.payload?.numHomes ?? 'Unknown'} active listings in Columbus.`);
    }
  } catch (err) {
    console.log(`Redfin: Error ${err}`);
  }

  // 3. Craigslist (Columbus)
  try {
    const clUrl = config.sources.craigslist.columbus;
    const clHtml = await oxylabsFetch(clUrl);
    const match = clHtml.match(/1 - \d+ of ([\d,]+)/);
    console.log(`Craigslist (Columbus OH): ${match ? match[1] : 'Unknown'} active listings.`);
  } catch(err) {
    console.log("Craigslist: Error");
  }

  // 4. Zillow
  console.log("Zillow: Check search JSON totalResultCount");
}

run().catch(console.error);
