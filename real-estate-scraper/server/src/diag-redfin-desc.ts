import * as fs from "fs";
import { parseRedfinApiResponse } from "./scrapers/redfin/redfin.parser";
import { AduResearchListing } from "./scrapers/property-purchase-research/adu-research.parser";
import { ADU_KEYWORDS } from "./scrapers/property-purchase-research/adu-keywords";
import { ADU_SHEET_HEADERS, buildAduSheetRow } from "./utils/google-sheets";

const content = fs.readFileSync("/tmp/opencode/gis_4145.json", "utf-8");
const { listings } = parseRedfinApiResponse(content, "Cleveland", false);

const withDesc = listings.filter((l) => l.description && l.description.length > 0);
console.log(`listings: ${listings.length}, with non-empty description: ${withDesc.length}`);
console.log(`avg desc length: ${Math.round(withDesc.reduce((a, l) => a + l.description!.length, 0) / (withDesc.length || 1))}`);

// Mirror RedfinAduScraper's mapping + keyword match on the first 3 with descriptions
for (const raw of withDesc.slice(0, 3)) {
  const haystack = [raw.title, raw.description, raw.address].join(" ").toLowerCase();
  const matchedKeyword = ADU_KEYWORDS.find((kw) =>
    new RegExp(`\\b${kw.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, "\\$&")}\\b`, "i").test(haystack)
  );
  const adu = { ...raw, source: "redfin-adu", totalBedrooms: raw.bedrooms, matchedKeyword } as AduResearchListing;
  const row = buildAduSheetRow(adu);
  const i = ADU_SHEET_HEADERS.indexOf("Description Preview");
  const j = ADU_SHEET_HEADERS.indexOf("Matched Keyword");
  console.log(`\n${row[ADU_SHEET_HEADERS.indexOf("Address")]} | kw="${matchedKeyword ?? "none"}"`);
  console.log(`  sheet Description Preview: "${String(row[i]).slice(0, 140)}"`);
}

process.exit(0);
