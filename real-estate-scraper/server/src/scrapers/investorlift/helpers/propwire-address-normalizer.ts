/**
 * Normalize Investorlift addresses to Propwire format
 * 
 * ⚠️  ONLY processes listings with COMPLETE STREET ADDRESSES
 * If the address doesn't have a street number, returns undefined to skip enrichment.
 * 
 * Propwire format: "Street Address, City, State, ZipCode"
 * Example: "2053 Mozelle Drive, Marietta, GA, 30062"
 * 
 * Listings without street addresses are skipped entirely (not enriched).
 */

import { RawListing } from "../../../types/listing";

interface PropwireAddressComponents {
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
export function extractPropwireAddressComponents(
  investorliftAddress: string | undefined
): PropwireAddressComponents {
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
 * Format address in Propwire style
 * ⚠️  ONLY returns a normalized address if street is present
 * Returns undefined for addresses without street numbers
 * 
 * With street: "Street, City, State, ZipCode"
 * Example: "2053 Mozelle Drive, Marietta, GA, 30062"
 */
export function formatPropwireAddress(
  components: PropwireAddressComponents
): string | undefined {
  const { street, city, state, zip } = components;

  // REQUIRE street address to process this listing
  if (!street || !city || !state) {
    return undefined;
  }

  // Build format with street (street is REQUIRED): "Street, City, State, ZipCode"
  const parts: string[] = [street, city, state];
  if (zip) parts.push(zip);

  return parts.join(", ");
}

/**
 * Normalize Investorlift listing to Propwire address format
 */
export function normalizeToPropwireFormat(listing: RawListing): string | undefined {
  const components = extractPropwireAddressComponents(listing.address);
  return formatPropwireAddress(components);
}
