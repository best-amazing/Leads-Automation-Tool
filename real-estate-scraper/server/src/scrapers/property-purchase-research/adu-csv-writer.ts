// src/scrapers/property-purchase-research/adu-csv-writer.ts
// ─────────────────────────────────────────────────────────────────────────────
// Writes ADU research results to CSV + JSON files matching the target
// spreadsheet columns.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import * as path from "path";
import { logger } from "../../utils/logger";
import { AduResearchListing } from "./adu-research.parser";

// ── CSV column definitions ────────────────────────────────────────────────

const CSV_COLUMNS = [
  { header: "Property Address",    field: "address" },
  { header: "Asking Price",        field: "price" },
  { header: "Number of Units",     field: "units" },
  { header: "Bedrooms (Main)",     field: "bedrooms" },
  { header: "Total Bedrooms",      field: "totalBedrooms" },
  { header: "Year Built",          field: "yearBuilt" },
  { header: "High School Rating",  field: "schoolRating" },
  { header: "Matched Keyword",     field: "matchedKeyword" },
  { header: "Source URL",          field: "url" },
  { header: "Description Preview", field: "descriptionPreview" },
] as const;

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Escape a value for CSV: wrap in quotes if it contains commas, quotes,
 * or newlines. Double any existing quotes.
 */
function csvEscape(val: unknown): string {
  if (val == null || val === "") return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

// ── Writer ─────────────────────────────────────────────────────────────────

export function writeAduResults(
  listings: AduResearchListing[],
  outputDir: string = path.join(process.cwd(), "logs"),
): { csvPath: string; jsonPath: string } {
  fs.mkdirSync(outputDir, { recursive: true });

  const csvPath  = path.join(outputDir, "adu-research.csv");
  const jsonPath = path.join(outputDir, "adu-research.json");

  // ── CSV ──────────────────────────────────────────────────────────────────

  const headerRow = CSV_COLUMNS.map((c) => c.header).join(",");
  const dataRows = listings.map((listing) => {
    return CSV_COLUMNS.map((col) => {
      if (col.field === "descriptionPreview") {
        // Truncate description for CSV readability
        const desc = listing.description ?? "";
        return csvEscape(desc.slice(0, 200));
      }
      if (col.field === "price") {
        return listing.price != null ? `$${listing.price.toLocaleString()}` : "";
      }
      const value = (listing as any)[col.field];
      return csvEscape(value);
    }).join(",");
  });

  const csvContent = [headerRow, ...dataRows].join("\n");
  fs.writeFileSync(csvPath, csvContent, "utf-8");
  logger.info(`[adu-research] CSV written: ${csvPath} (${listings.length} rows)`);

  // ── JSON ─────────────────────────────────────────────────────────────────

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
      matchedKeyword: l.matchedKeyword,
      url:            l.url,
      description:    l.description,
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
  const dataRows = listings.map((listing) => {
    return CSV_COLUMNS.map((col) => {
      if (col.field === "descriptionPreview") {
        const desc = listing.description ?? "";
        return csvEscape(desc.slice(0, 200));
      }
      if (col.field === "price") {
        return listing.price != null ? `$${listing.price.toLocaleString()}` : "";
      }
      const value = (listing as any)[col.field];
      return csvEscape(value);
    }).join(",");
  });

  const csvContent = [headerRow, ...dataRows].join("\n");
  fs.writeFileSync(csvPath, csvContent, "utf-8");
  logger.info(`[adu-research] CSV written: ${csvPath} (${listings.length} rows)`);
}
