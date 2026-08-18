import * as fs from "fs";
import * as path from "path";
import { logger } from "../../utils/logger";
import { AduResearchListing } from "./adu-research.parser";

const CSV_COLUMNS = [
  { header: "Date Found",          field: "dateFound" },
  { header: "Owner",               field: "owner" },
  { header: "Source",              field: "source" },
  { header: "Listing Status",      field: "status" },
  { header: "Days on Market",      field: "daysOnMarket" },
  { header: "Address",             field: "address" },
  { header: "Zip",                 field: "zip" },
  { header: "Price",               field: "price" },
  { header: "Beds",                field: "bedrooms" },
  { header: "Baths",               field: "bathrooms" },
  { header: "SqFt",                field: "squareFeet" },
  { header: "Lot Size (acres)",    field: "lotSqft" },
  { header: "Property Owner",      field: "ownerName" },
  { header: "Phone Number",        field: "ownerPhone" },
  { header: "Email address",       field: "ownerEmail" },
  { header: "Units",               field: "units" },
  { header: "Total Bedrooms",      field: "totalBedrooms" },
  { header: "Year Built",          field: "yearBuilt" },
  { header: "School Rating",       field: "schoolRating" },
  { header: "Deed Transfer Date",  field: "deedTransferDate" },
  { header: "Matched Keyword",     field: "matchedKeyword" },
  { header: "Link",                field: "url" },
  { header: "Description Preview",  field: "description" },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────

function csvEscape(val: unknown): string {
  if (val == null || val === "") return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

function mapRow(listing: AduResearchListing): string {
  return CSV_COLUMNS.map((col) => {
    if (col.field === "description") {
      const context = extractKeywordContext(listing.description, listing.matchedKeyword);
      return csvEscape(context.replace(/\n/g, " "));
    }
    if (col.field === "price") {
      return listing.price != null ? `$${listing.price.toLocaleString()}` : "";
    }
    if (col.field === "dateFound") {
      return new Date().toLocaleDateString();
    }
    if (col.field === "owner") {
      return "Eddy Ephraim";
    }
    if (col.field === "matchedKeyword") {
      const kw = listing.matchedKeyword;
      return csvEscape(typeof kw === "string" ? kw : (kw as any)?.name || "");
    }
    if (col.field === "lotSqft") {
      const acres = listing.lotSqft != null ? listing.lotSqft / 43560 : undefined;
      return acres != null ? acres.toFixed(2) : "";
    }
    const value = (listing as any)[col.field];
    return csvEscape(value);
  }).join(",");
}

function extractKeywordContext(description: string | undefined, keyword: string | undefined): string {
  if (!description || !keyword) return "";
  const lines = description.split("\n");
  const matched = lines.filter((line) =>
    line.toLowerCase().includes(keyword.toLowerCase())
  );
  return matched.length > 0 ? matched.join("\n") : "";
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export function writeAduResults(
  listings: AduResearchListing[],
  outputDir: string = path.join(process.cwd(), "logs"),
): { csvPath: string; jsonPath: string } {
  fs.mkdirSync(outputDir, { recursive: true });

  const dateStr = today();
  const csvPath  = path.join(outputDir, `adu-research-${dateStr}.csv`);
  const jsonPath = path.join(outputDir, `adu-research-${dateStr}.json`);

  const headerRow = CSV_COLUMNS.map((c) => c.header).join(",");
  const dataRows = listings.map((l) => mapRow(l));

  const csvContent = [headerRow, ...dataRows].join("\n");
  fs.writeFileSync(csvPath, csvContent, "utf-8");
  logger.info(`[adu-research] CSV written: ${csvPath} (${listings.length} rows)`);

  const jsonPayload = {
    generatedAt: new Date().toISOString(),
    totalMatches: listings.length,
    listings: listings.map((l) => ({
      address:        l.address,
      price:          l.price,
      units:          l.units,
      bedrooms:       l.bedrooms,
      totalBedrooms:  l.totalBedrooms,
      yearBuilt:      l.yearBuilt,
      schoolRating:   l.schoolRating,
      deedTransferDate: l.deedTransferDate,
      matchedKeyword: l.matchedKeyword,
      url:            l.url,
      description:    extractKeywordContext(l.description, l.matchedKeyword),
      city:           l.city,
      state:          l.state,
    })),
  };

  fs.writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2), "utf-8");
  logger.info(`[adu-research] JSON written: ${jsonPath} (${listings.length} items)`);

  return { csvPath, jsonPath };
}

export function writeCsvOnly(
  listings: AduResearchListing[],
  csvPath: string
): void {
  const headerRow = CSV_COLUMNS.map((c) => c.header).join(",");
  const dataRows = listings.map((listing) => mapRow(listing));
  const csvContent = [headerRow, ...dataRows].join("\n");
  fs.writeFileSync(csvPath, csvContent, "utf-8");
  logger.info(`[adu-research] CSV written: ${csvPath} (${listings.length} rows)`);
}

export function appendAduResult(
  listing: AduResearchListing,
  outputDir: string = path.join(process.cwd(), "logs"),
): void {
  fs.mkdirSync(outputDir, { recursive: true });

  const dateStr = today();
  const csvPath  = path.join(outputDir, `adu-research-${dateStr}.csv`);
  const jsonPath = path.join(outputDir, `adu-research-${dateStr}.json`);

  if (!fs.existsSync(csvPath)) {
    const headerRow = CSV_COLUMNS.map((c) => c.header).join(",");
    fs.writeFileSync(csvPath, headerRow + "\n", "utf-8");
  }

  const dataRow = mapRow(listing);
  fs.appendFileSync(csvPath, dataRow + "\n", "utf-8");

  let jsonPayload = { generatedAt: new Date().toISOString(), totalMatches: 0, listings: [] as any[] };
  if (fs.existsSync(jsonPath)) {
    try {
      jsonPayload = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
    } catch {}
  }

  jsonPayload.listings.push({
    address:        listing.address,
    price:          listing.price,
    units:          listing.units,
    bedrooms:       listing.bedrooms,
    totalBedrooms:  listing.totalBedrooms,
    yearBuilt:      listing.yearBuilt,
    schoolRating:   listing.schoolRating,
    deedTransferDate: listing.deedTransferDate,
    matchedKeyword: listing.matchedKeyword,
    url:            listing.url,
    description:    extractKeywordContext(listing.description, listing.matchedKeyword),
    city:           listing.city,
    state:          listing.state,
  });
  jsonPayload.totalMatches = jsonPayload.listings.length;
  jsonPayload.generatedAt = new Date().toISOString();

  fs.writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2), "utf-8");
}