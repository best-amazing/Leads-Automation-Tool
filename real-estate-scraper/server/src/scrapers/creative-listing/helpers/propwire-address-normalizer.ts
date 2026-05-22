/**
 * Normalize Creative Listing addresses to Propwire format
 * 
 * Propwire format: "Street Address, City, State, ZipCode"
 * Example: "286 Alhambra Way, Akron, OH, 44302"
 */

import { RawListing } from "../../../types/listing";

interface PropwireAddressComponents {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

/**
 * Extract address components from Creative Listing data for Propwire format
 * Creative Listing stores full address as concatenated string: "Street, City, State ZipCode"
 */
export function extractPropwireAddressComponents(
  fullAddress: string | undefined
): PropwireAddressComponents {
  if (!fullAddress) return {};

  // Parse address in format: "Street, City, State ZipCode"
  // Example: "286 Alhambra Way, Akron, OH 44302"
  const parts = fullAddress.split(",").map(p => p.trim());

  let street: string | undefined;
  let city: string | undefined;
  let state: string | undefined;
  let zip: string | undefined;

  if (parts.length >= 1) {
    street = parts[0];
  }

  if (parts.length === 2) {
    // Likely format: "City, State ZipCode" (no street)
    const first = parts[0];
    const second = parts[1];
    // If first starts with a digit assume it's a street; otherwise treat as city
    if (/^\d/.test(first)) {
      street = first;
      // parse second as "City" or "State Zip"
      const maybeStateZip = second.split(/\s+/);
      if (maybeStateZip.length >= 1) {
        // If second starts with a two-letter state code, treat as state
        if (/^[A-Za-z]{2}$/.test(maybeStateZip[0])) {
          state = maybeStateZip[0];
          if (maybeStateZip.length >= 2) zip = maybeStateZip[1];
        } else {
          city = second;
        }
      }
    } else {
      city = first;
      const stateZipParts = second.trim().split(/\s+/);
      if (stateZipParts.length >= 1) state = stateZipParts[0];
      if (stateZipParts.length >= 2) zip = stateZipParts[1];
    }
  }

  if (parts.length >= 3) {
    // Standard: "Street, City, State ZipCode"
    street = street ?? parts[0];
    city = city ?? parts[1];
    const stateZip = parts[2].trim();
    const stateZipParts = stateZip.split(/\s+/);
    if (stateZipParts.length >= 1) {
      state = stateZipParts[0];
    }
    if (stateZipParts.length >= 2) {
      zip = stateZipParts[1];
    }
  }

  return { street, city, state, zip };
}

/**
 * Format address in Propwire style
 * Format: "Street, City, State, ZipCode"
 */
export function formatPropwireAddress(components: PropwireAddressComponents): string | undefined {
  const { street, city, state, zip } = components;

  // If we have a street, prefer the full street format
  if (street && city && state) {
    const parts = [street, city, state];
    if (zip) parts.push(zip);
    return parts.join(", ");
  }

  // Fallback: city/state[/zip] (e.g. "Akron, OH 44306")
  if (city && state) {
    const parts = [city, state];
    if (zip) parts.push(zip);
    return parts.join(", ");
  }

  return undefined;
}

/**
 * Normalize Creative Listing to Propwire address format
 */
export function normalizeToPropwireFormat(listing: RawListing): string | undefined {
  // Creative listing stores full address as concatenated string
  const components = extractPropwireAddressComponents(listing.address);

  return formatPropwireAddress(components);
}
