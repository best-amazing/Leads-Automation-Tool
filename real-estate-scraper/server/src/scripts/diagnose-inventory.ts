import { config } from "../config";
import { oxylabsFetch } from "../scrapers/zillow/zillow.scraper";
import { discoverOhioListingUrls } from "../scrapers/coldwellbanker/coldwellbanker.scraper";

async function run() {
  console.log("=========================================");
  console.log("        ADU INVENTORY DIAGNOSTIC         ");
  console.log("=========================================\n");

  // 1. Coldwell Banker — uses the scraper's own HTTP (correct domain + UA)
  try {
    const ohUrls = await discoverOhioListingUrls("full");
    const newDayUrls = await discoverOhioListingUrls("new-day").catch(() => [] as string[]);

    console.log(`[COLDWELL BANKER]`);
    console.log(` - Active Ohio Listings: ${ohUrls.length}`);
    console.log(` - New Ohio Listings Today: ${newDayUrls.length}\n`);
  } catch (err) {
    console.log(`[COLDWELL BANKER] Error: ${err}\n`);
  }

  // 2. Redfin — Oxylabs proxy, request large batch and count homes array
  try {
    const markets = config.sources.redfin.markets;
    console.log(`[REDFIN]`);
    for (const market of markets) {
      const url = `https://www.redfin.com/stingray/api/gis?al=1&region_id=${market.regionId}&region_type=${market.regionType}&uipt=1,4&max_price=9999999&num_homes=9999&start=0&status=1&sf=1,2,3,5,6,7&ord=price-desc`;
      try {
        const raw = await oxylabsFetch(url);
        if (!raw) { console.log(` - ${market.name}: No response`); continue; }
        const jsonStr = raw.replace("{}&&", "");
        const data = JSON.parse(jsonStr);
        const homes = data?.payload?.homes;
        const total = Array.isArray(homes) ? homes.length : "Unknown";
        console.log(` - ${market.name}: ${total} active listings`);
      } catch (e) {
        console.log(` - ${market.name}: Error — ${e}`);
      }
    }
    console.log();
  } catch (err) {
    console.log(`[REDFIN] Error: ${err}\n`);
  }

  // 3. Craigslist — count data-pid elements on first page + check high offset
  try {
    const cities = Object.entries(config.sources.craigslist);
    console.log(`[CRAIGSLIST]`);
    for (const [cityName, baseUrl] of cities) {
      try {
        const clHtml = await oxylabsFetch(baseUrl as string);
        if (!clHtml) { console.log(` - ${cityName}: No response`); continue; }

        const firstPageCount = (clHtml.match(/data-pid=/gi) || []).length;

        console.log(` - ${cityName}: ~${firstPageCount} listings on first page`);
      } catch (e) {
        console.log(` - ${cityName}: Error — ${e}`);
      }
    }
    console.log();
  } catch (err) {
    console.log(`[CRAIGSLIST] Error: ${err}\n`);
  }

  // 4. Zillow — parse __NEXT_DATA__ for totalResultCount
  try {
    const markets = config.sources.zillow.markets;
    console.log(`[ZILLOW]`);
    for (const market of markets) {
      try {
        const html = await oxylabsFetch(market.baseUrl);
        if (!html) { console.log(` - ${market.name}: No response`); continue; }

        const nextDataMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
        if (nextDataMatch) {
          const jsonData = JSON.parse(nextDataMatch[1]);
          const findTotal = (obj: any, depth = 0): number | undefined => {
            if (depth > 8 || !obj || typeof obj !== "object") return undefined;
            if (typeof obj.totalResultCount === "number") return obj.totalResultCount;
            for (const v of Object.values(obj)) {
              const r = findTotal(v, depth + 1);
              if (r != null) return r;
            }
            return undefined;
          };
          const total = findTotal(jsonData);
          console.log(` - ${market.name} (${market.listingType}): ${total ?? "Unknown"} active listings`);
        } else {
          console.log(` - ${market.name}: No __NEXT_DATA__ found`);
        }
      } catch (e) {
        console.log(` - ${market.name}: Error — ${e}`);
      }
    }
    console.log();
  } catch (err) {
    console.log(`[ZILLOW] Error: ${err}\n`);
  }

  console.log("=========================================");
}

run().catch(console.error);
