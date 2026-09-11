// src/lib/deed-data/geo-code.ts
// ─────────────────────────────────────────────────────────────────────────────
// Address cleanup + US Census geocoder.
// ─────────────────────────────────────────────────────────────────────────────

import axios from "axios";
import { RawListing, NormalizedListing } from "./types";
import { logger } from "../../utils/logger";
import { withRetry } from "./retry";

/**
 * Cleans up duplicated "City, OH ZIP, City, OH, ZIP" tails and flags
 * off-market leads without a street number.
 */
export function normalizeAddress(raw: RawListing): NormalizedListing {
  let address = (raw.address || "").trim();

  // Strip trailing duplicated city/state/zip tails (e.g., ", Beachwood, OH, 44122")
  address = address.replace(/(?:,\s*[^,]+,\s*[A-Z]{2}(?:,\s*\d{5})?){2,}$/i, (match) => {
    const parts = match.split(",").map((s) => s.trim()).filter(Boolean);
    // Keep just one city, state, zip set
    return ", " + parts.slice(0, 3).join(", ");
  });

  // Collapse repeated identical adjacent comma segments
  const parts = address.split(",").map((p) => p.trim()).filter(Boolean);
  const deduped: string[] = [];
  for (const part of parts) {
    if (deduped.length === 0 || deduped[deduped.length - 1] !== part) {
      deduped.push(part);
    }
  }
  address = deduped.join(", ");

  // Remove unit/apt/ste numbers for street matching (e.g. "APT 202")
  const cleanForMatching = address
    .replace(/\s+(APT|UNIT|STE|SUITE|#)\s*[\w-]+/gi, "")
    .trim();

  const firstSegment = deduped[0] || "";
  const hasStreetAddress = /^\d+\s+\S/.test(firstSegment);

  return {
    ...raw,
    normalizedAddress: cleanForMatching || address,
    hasStreetAddress,
    enrichmentNote: hasStreetAddress
      ? undefined
      : "No street number in source lead — cannot be parcel-matched by any address/point API.",
  };
}

interface CensusGeocodeResponse {
  result: {
    addressMatches: Array<{
      coordinates: { x: number; y: number }; // x = lon, y = lat
      matchedAddress: string;
    }>;
  };
}

/**
 * US Census Bureau geocoder.
 */
export async function geocodeAddress(
  normalizedAddress: string
): Promise<{ lat: number; lon: number } | null> {
  const url =
    "https://geocoding.geo.census.gov/geocoder/locations/onelineaddress" +
    `?address=${encodeURIComponent(normalizedAddress)}` +
    "&benchmark=Public_AR_Current&format=json";

  try {
    const res = await withRetry(
      () => axios.get<CensusGeocodeResponse>(url, { timeout: 10_000 }),
      { retries: 3, baseDelayMs: 300, logLabel: "geocode" }
    );
    const match = res.data?.result?.addressMatches?.[0];
    if (!match) return null;

    return { lat: match.coordinates.y, lon: match.coordinates.x };
  } catch (err: any) {
    logger.warn(`[geocode] Census geocoder error for "${normalizedAddress}": ${err.message || err}`);
    return null;
  }
}
