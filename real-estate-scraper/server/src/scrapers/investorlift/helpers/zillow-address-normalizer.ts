/**
 * Normalize Investorlift addresses to Zillow format
 * 
 * Zillow format (with street): "Street, City, State ZipCode, Street, City, State, ZipCode"
 * Example: "2053 Mozelle Drive, Marietta, GA 30062, 2053 Mozelle Drive, Marietta, GA, 30062"
 * 
 * Zillow format (without street): "City, State ZipCode, City, State, ZipCode"
 * When street address is available, includes it for exact matching.
 */

import { RawListing } from "../../../types/listing";

interface ZillowAddressComponents {
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
export function extractZillowAddressComponents(
  investorliftAddress: string | undefined
): ZillowAddressComponents {
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
 * Format address in Zillow style
 * With street: "Street, City, State ZipCode, Street, City, State, ZipCode"
 * Without street: "City, State ZipCode, City, State, ZipCode"
 */
export function formatZillowAddress(components: ZillowAddressComponents): string | undefined {
  const { street, city, state, zip } = components;

  if (!city || !state) {
    return undefined;
  }

  // Build both formats with street if available
  const streetPart = street ? `${street}, ` : "";
  const firstPart = zip 
    ? `${streetPart}${city}, ${state} ${zip}` 
    : `${streetPart}${city}, ${state}`;
  const secondPart = zip 
    ? `${streetPart}${city}, ${state}, ${zip}` 
    : `${streetPart}${city}, ${state}`;

  return `${firstPart}, ${secondPart}`;
}

/**
 * Normalize Investorlift listing to Zillow address format
 */
export function normalizeToZillowFormat(listing: RawListing): string | undefined {
  const components = extractZillowAddressComponents(listing.address);
  return formatZillowAddress(components);
}
