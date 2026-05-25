/**
 * Normalize Investorlift addresses to Redfin format
 * 
 * Redfin format: "Street Address, City, State, ZipCode"
 * Example: "2053 Mozelle Drive, Marietta, GA, 30062"
 * 
 * When street address is available, includes it for exact matching.
 * When unavailable, falls back to: "City, State, ZipCode"
 */

import { RawListing } from "../../../types/listing";

interface RedfinAddressComponents {
  street?: string;
  city?: string;
  state?: string;
  county?: string;
  zip?: string;
}

/**
 * Extract address components from Investorlift data
 * Supports three formats:
 * 1. County-first: "Ashtabula County, Conneaut, OH 44030"
 * 2. Street address: "169 North Liberty Street, Conneaut, OH 44030"
 * 3. City-first (legacy): "City, County, State, Zip"
 */
export function extractRedfinAddressComponents(
  investorliftAddress: string | undefined
): RedfinAddressComponents {
  if (!investorliftAddress) {
    return {};
  }

  const parts = investorliftAddress.split(",").map((p) => p.trim());

  let city: string | undefined;
  let county: string | undefined;
  let state: string | undefined;
  let zip: string | undefined;
  let street: string | undefined;

  if (parts.length >= 4) {
    // Detect format: county-first, street address, or city-first
    const firstPart = parts[0];
    const containsCounty = /\bcounty\b/i.test(firstPart);
    const startsWithNumber = /^\d/.test(firstPart);

    if (containsCounty) {
      // County-first format: "Ashtabula County, Conneaut, OH 44030"
      county = firstPart;
      city = parts[1];
      state = parts[2];
      zip = parts[3];
    } else if (startsWithNumber) {
      // Street address format: "169 North Liberty Street, Conneaut, OH 44030"
      street = firstPart;
      city = parts[1];
      state = parts[2];
      zip = parts[3];
    } else {
      // City-first format: "City, County, State, Zip"
      city = firstPart;
      county = parts[1];
      state = parts[2];
      zip = parts[3];
    }
  } else if (parts.length === 3) {
    city = parts[0];
    state = parts[1];
    zip = parts[2];
  }

  return { city, state, county, zip, street };
}

/**
 * Format address in Redfin style
 * Includes street address when available for exact matching:
 * - With street: "Street, City, State, ZipCode"
 * - Without street: "City, State, ZipCode"
 */
export function formatRedfinAddress(
  components: RedfinAddressComponents
): string | undefined {
  const { street, city, state, zip } = components;

  if (!city || !state) {
    return undefined;
  }

  // Build Redfin format with street if available: "Street, City, State, ZipCode"
  const parts: string[] = [];
  if (street) {
    parts.push(street);
  }
  parts.push(city, state);
  if (zip) parts.push(zip);

  return parts.join(", ");
}

/**
 * Normalize Investorlift listing to Redfin address format
 */
export function normalizeToRedfinFormat(listing: RawListing): string | undefined {
  const components = extractRedfinAddressComponents(listing.address);
  return formatRedfinAddress(components);
}
