/**
 * Normalize Creative Listing addresses to Redfin format
 * 
 * Redfin format: "Street Address, City, State, ZipCode"
 * Example: "286 Alhambra Way, Akron, OH, 44302"
 */

import { RawListing } from "../../../types/listing";

interface RedfinAddressComponents {
  street?: string;
  city?: string;
  state?: string;
  zip?: string;
}

/**
 * Extract address components from Creative Listing data for Redfin format
 * Creative Listing stores full address as concatenated string: "Street, City, State ZipCode"
 */
export function extractRedfinAddressComponents(
  fullAddress: string | undefined
): RedfinAddressComponents {
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
    const first = parts[0];
    const second = parts[1];
    if (/^\d/.test(first)) {
      street = first;
      const maybeStateZip = second.split(/\s+/);
      if (maybeStateZip.length >= 1) {
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
    street = street ?? parts[0];
    city = city ?? parts[1];
    const stateZip = parts[2].trim();
    const stateZipParts = stateZip.split(/\s+/);
    if (stateZipParts.length >= 1) state = stateZipParts[0];
    if (stateZipParts.length >= 2) zip = stateZipParts[1];
  }

  return { street, city, state, zip };
}

/**
 * Format address in Redfin style
 * Format: "Street, City, State, ZipCode"
 */
export function formatRedfinAddress(components: RedfinAddressComponents): string | undefined {
  const { street, city, state, zip } = components;

  // If street present, prefer street format
  if (street && city && state) {
    const parts = [street, city, state];
    if (zip) parts.push(zip);
    return parts.join(", ");
  }

  // Fallback to city/state[/zip]
  if (city && state) {
    const parts = [city, state];
    if (zip) parts.push(zip);
    return parts.join(", ");
  }

  return undefined;
}

/**
 * Normalize Creative Listing to Redfin address format
 */
export function normalizeToRedfinFormat(listing: RawListing): string | undefined {
  // Creative listing stores full address as concatenated string
  const components = extractRedfinAddressComponents(listing.address);

  return formatRedfinAddress(components);
}
