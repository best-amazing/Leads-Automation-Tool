// src/scrapers/property-purchase-research/run-adu-research.ts
// ─────────────────────────────────────────────────────────────────────────────
// Standalone entry point for the ADU property purchase research scraper.
//
// Usage:
//   npm run scrape:adu-research
//   node --max-old-space-size=512 -r ./polyfill-file.js -r ts-node/register \
//        src/scrapers/property-purchase-research/run-adu-research.ts
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { ZillowAduScraper } from "./zillow-adu.scraper";
import { RedfinAduScraper } from "./redfin-adu.scraper";
import { ColdwellBankerAduScraper } from "./coldwellbanker-adu.scraper"; // REMOVED
import { CraigslistAduScraper } from "./craigslist-adu.scraper";
import { logger } from "../../utils/logger";
import { getLastBackfillStatus } from "../../utils/backfill-store";
import { ADU_KEYWORDS, TARGET_STATES } from "./adu-keywords";
import {
  appendAduResult,
  writeAduResults,
  writeCsvOnly,
} from "./adu-csv-writer";
import { AduResearchListing } from "./adu-research.parser";
import {
  passesKeywordFilter,
  passesLocationFilter,
} from "./adu-research.scraper";
import { fetchDeedTransferDate } from "./deed-data-resolver";
import * as fs from "fs";
import * as path from "path";
import { writeAduResearchToSheets } from "../../utils/google-sheets";

let capturedCount = 0;
const seenKeys = new Set<string>();

function normalizeStreetToken(value: string): string {
  return value
    .replace(/\b(?:street|st)\.?\b/gi, "st")
    .replace(/\b(?:avenue|ave)\.?\b/gi, "ave")
    .replace(/\b(?:road|rd)\.?\b/gi, "rd")
    .replace(/\b(?:boulevard|blvd)\.?\b/gi, "blvd")
    .replace(/\b(?:drive|dr)\.?\b/gi, "dr")
    .replace(/\b(?:lane|ln)\.?\b/gi, "ln")
    .replace(/\b(?:court|ct)\.?\b/gi, "ct")
    .replace(/\b(?:place|pl)\.?\b/gi, "pl")
    .replace(/\b(?:way)\.?\b/gi, "way")
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function stripLocationSuffix(address: string): string {
  let normalized = address
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const zipMatch = normalized.match(/\b\d{5}(?:-\d{4})?\b/);
  if (zipMatch) {
    normalized = normalized
      .slice(0, zipMatch.index ?? normalized.length)
      .trim();
  }

  normalized = normalized
    .replace(/,\s*[A-Za-z .'-]+,\s*[A-Z]{2}\s*,?\s*$/i, "")
    .replace(/,\s*[A-Za-z .'-]+\s*,?\s*$/i, "")
    .replace(/,\s*[A-Z]{2}\s*,?\s*$/i, "")
    .replace(/\s*,\s*$/g, "")
    .trim();

  return normalized;
}

export function dedupKey(
  listing: Partial<Pick<AduResearchListing, "address" | "url">>,
): string {
  if (listing.address) {
    const streetCore = stripLocationSuffix(listing.address);
    if (streetCore) {
      const zip = listing.address.match(/\b\d{5}(?:-\d{4})?\b/)?.[0];
      return `${normalizeStreetToken(streetCore)}${zip ? `|${zip}` : ""}`;
    }
    return normalizeStreetToken(listing.address);
  }
  return (listing.url ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

async function handleMatch(listing: AduResearchListing) {
  const key = dedupKey(listing);
  if (seenKeys.has(key)) {
    logger.debug(
      `[runner] Skipping duplicate: ${listing.address || listing.url}`,
    );
    return;
  }
  seenKeys.add(key);

  capturedCount++;
  logger.info(
    `[runner] Match #${capturedCount}: ${listing.address || listing.url}`,
  );

  // ── Inline deed transfer date lookup ──────────────────────────────────
  // Requires a real street address: craigslist pins are frequently just the
  // city-default location, and resolving those against the parcel service
  // would attach a stranger's deed date to this lead.
  if (listing.address) {
    try {
      logger.info(
        `[runner] Looking up deed transfer date for: ${listing.address}`,
      );
      const deedDate = await fetchDeedTransferDate({
        address: listing.address,
        city: listing.city,
        state: listing.state,
        zip: listing.zip,
        latitude: listing.latitude,
        longitude: listing.longitude,
      });
      if (deedDate) {
        listing.deedTransferDate = deedDate;
        logger.info(`[runner] ✓ Deed transfer date: ${deedDate}`);
      } else {
        logger.info(`[runner] ✗ No deed transfer date found`);
      }
    } catch (err) {
      logger.warn(`[runner] Deed date lookup failed: ${err}`);
    }
  }

  appendAduResult(listing);
  await writeAduResearchToSheets([listing]);
}

export async function runAduResearch(): Promise<void> {
  logger.info("═".repeat(60));
  logger.info("ADU Property Purchase Research Scraper");
  logger.info("═".repeat(60));
  logger.info(`Target states: ${TARGET_STATES.join(", ")}`);
  logger.info(`Keywords: ${ADU_KEYWORDS.length} patterns loaded`);
  logger.info("─".repeat(60));

  const maxListings = Number(process.env.MAX_LISTINGS ?? 5000);

  // Coldwell Banker removed from the scraper list (2026-08-27).
  const coldwell = new ColdwellBankerAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  const zillow = new ZillowAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  const redfin = new RedfinAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  const craigslist = new CraigslistAduScraper({
    maxListings,
    onMatch: handleMatch,
  });

  try {
    async function runContinuous(scraper: any): Promise<AduResearchListing[]> {
      const sourceName = scraper.sourceName;
      const allResults: AduResearchListing[] = [];
      const batchThreshold = Number(process.env.ADU_BACKFILL_BATCH_SIZE ?? 500);
      while (true) {
        const results = await scraper.run();
        allResults.push(...(results as AduResearchListing[]));
        if (global.gc) global.gc();
        logger.info(
          `Memory after ${sourceName}: ${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)} MB`,
        );

        const { processedCount } = await getLastBackfillStatus(sourceName);

        if (processedCount >= batchThreshold) {
          logger.info(
            `[runner] ${sourceName} backfill hit batch limit, immediately fetching next batch...`,
          );
          // Small 500ms sleep to avoid hammering the DB
          await new Promise((r) => setTimeout(r, 500));
        } else {
          logger.info(
            `[runner] ${sourceName} backfill complete or reached end of inventory.`,
          );
          break;
        }
      }
      return allResults;
    }

    const coldwellResults = await runContinuous(coldwell);
    const redfinResults = await runContinuous(redfin);
    const craigslistResults = await runContinuous(craigslist);
    const zillowResults = await runContinuous(zillow);
    if (global.gc) global.gc();

    const finalResults = [
      ...redfinResults,
      ...craigslistResults,
      ...zillowResults,
      ...coldwellResults,
    ];

    try {
      const DEBUG_DIR = path.resolve("logs");
      fs.mkdirSync(DEBUG_DIR, { recursive: true });
      // Removed the intermediate CSV write as the finalResults are now fully filtered
    } catch (err) {
      logger.warn(`[runner] Failed to save combined CSV: ${err}`);
    }

    logger.info("═".repeat(60));
    logger.info(`ADU Research Complete — ${finalResults.length} matches found`);
    if (finalResults.length > 0) {
      logger.info(
        `Outputs incrementally streamed to CSV, JSON, and Google Sheets`,
      );
    }
    logger.info("═".repeat(60));
  } catch (err: any) {
    logger.error(`ADU Research scraper failed: ${err}`);
    throw err;
  }
}

// ── Direct execution ────────────────────────────────────────────────────────
// When run as `npm run scrape:adu-research`, surface failures and exit non-zero.
// The cron scheduler imports runAduResearch() instead and keeps going on error.
if (require.main === module) {
  runAduResearch().catch(() => {
    process.exit(1);
  });
}
