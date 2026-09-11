// src/lib/deed-data/enrich-listings.ts
// ─────────────────────────────────────────────────────────────────────────────
// Standalone batch listing enricher module & CLI script.
// ─────────────────────────────────────────────────────────────────────────────

import * as fs from "fs";
import { normalizeAddress, geocodeAddress } from "./geo-code";
import { getParcelData } from "./parcel-data-service";
import { RawListing, EnrichedListing, EMPTY_PARCEL_RESULT } from "./types";
import { logger } from "../../utils/logger";

function splitForAttom(normalizedAddress: string): { address1: string; address2: string } {
  const [first, ...rest] = normalizedAddress.split(",").map((p) => p.trim());
  return { address1: first, address2: rest.join(", ") };
}

export async function enrichOneListing(raw: RawListing): Promise<EnrichedListing> {
  const normalized = normalizeAddress(raw);

  if (!normalized.hasStreetAddress) {
    return { ...normalized, ...EMPTY_PARCEL_RESULT };
  }

  const point = await geocodeAddress(normalized.normalizedAddress);
  if (!point) {
    return {
      ...normalized,
      ...EMPTY_PARCEL_RESULT,
      enrichmentNote: "Census geocoder found no match for this address.",
    };
  }

  const { address1, address2 } = splitForAttom(normalized.normalizedAddress);
  const parcel = await getParcelData({ lat: point.lat, lon: point.lon, address1, address2 });

  return {
    ...normalized,
    lat: point.lat,
    lon: point.lon,
    ...parcel,
    enrichmentNote: parcel.latestDeedTransferDate
      ? undefined
      : "Geocoded fine, but neither ATTOM nor OGRIP returned a deed date for this parcel.",
  };
}

async function main() {
  const [, , inputPath, outputPath] = process.argv;
  if (!inputPath || !outputPath) {
    logger.error("Usage: node -r ./polyfill-file.js -r ts-node/register src/lib/deed-data/enrich-listings.ts <input.json> <output.json>");
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(inputPath, "utf-8")) as RawListing[];
  const enriched: EnrichedListing[] = [];

  for (const listing of raw) {
    try {
      enriched.push(await enrichOneListing(listing));
    } catch (err: any) {
      logger.error(`Failed on "${listing.address}": ${err.message || err}`);
      enriched.push({
        ...normalizeAddress(listing),
        ...EMPTY_PARCEL_RESULT,
        enrichmentNote: `Enrichment error: ${err.message || err}`,
      });
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  fs.writeFileSync(outputPath, JSON.stringify(enriched, null, 2));

  const withDates = enriched.filter((l) => l.latestDeedTransferDate).length;
  logger.info(
    `Wrote ${enriched.length} listings to ${outputPath} (${withDates} with a deed date, ` +
      `${enriched.length - withDates} without).`
  );
}

if (require.main === module) {
  main();
}
