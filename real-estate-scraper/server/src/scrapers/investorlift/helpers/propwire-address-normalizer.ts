/**
 * Normalize Investorlift addresses to Propwire format
 * 
 * Propwire format: "Street Address, City, State, ZipCode"
 * Example: "367 Effington Ln, Columbus, OH, 43207"
 * 
 * Note: Investorlift doesn't include street addresses, so we format with available data
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
 * Format: "City, State, ZipCode" (no street available from Investorlift)
 */
export function formatPropwireAddress(
  components: PropwireAddressComponents
): string | undefined {
  const { city, state, zip } = components;

  if (!city || !state) {
    return undefined;
  }

  // Build format: "City, State, ZipCode"
  const parts = [city, state];
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
