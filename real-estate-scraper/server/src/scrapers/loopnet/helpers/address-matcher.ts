// src/scrapers/loopnet/normalizers/address-matcher.ts

import { RawListing } from "../../../types/listing";

interface AddressComponents {
  street?: string;
  city?:   string;
  state?:  string;
  zip?:    string;
}

/**
 * Parse a LoopNet address into components.
 * LoopNet format: "2370 Losantiville Ave Cincinnati, OH 45237"
 * (no comma between street and city)
 */
function parseLoopnetAddress(address: string): AddressComponents {
  const cleaned = address.replace(/\s+near\s+.+$/i, "").trim();

  // Match: <street> <City>, <ST> <zip>
  // e.g.  "2370 Losantiville Ave Cincinnati, OH 45237"
  const full = cleaned.match(
    /^(.+?)\s+((?:[A-Z][a-z]+\s*)+),\s*([A-Z]{2})\s+(\d{5})/
  );
  if (full) {
    return {
      street: full[1].trim(),
      city:   full[2].trim(),
      state:  full[3].trim(),
      zip:    full[4].trim(),
    };
  }

  // No zip — match: <street> <City>, <ST>
  const noZip = cleaned.match(
    /^(.+?)\s+((?:[A-Z][a-z]+\s*)+),\s*([A-Z]{2})\s*$/
  );
  if (noZip) {
    return {
      street: noZip[1].trim(),
      city:   noZip[2].trim(),
      state:  noZip[3].trim(),
    };
  }

  // Fallback — return the whole thing as street
  return { street: cleaned };
}

/**
 * Normalize a string for comparison:
 * lowercase, expand common abbreviations, strip punctuation/extra spaces.
 */
function normalize(value: string): string {
  return value
    .toLowerCase()
    .replace(/\bst\b\.?/g,   "street")
    .replace(/\bave?\b\.?/g, "avenue")
    .replace(/\bblvd\b\.?/g, "boulevard")
    .replace(/\bdr\b\.?/g,   "drive")
    .replace(/\brd\b\.?/g,   "road")
    .replace(/\bln\b\.?/g,   "lane")
    .replace(/\bct\b\.?/g,   "court")
    .replace(/\bpl\b\.?/g,   "place")
    .replace(/\bpkwy\b\.?/g, "parkway")
    .replace(/\bhwy\b\.?/g,  "highway")
    .replace(/\bcir\b\.?/g,  "circle")
    .replace(/\bter\b\.?/g,  "terrace")
    .replace(/[^\w\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Check whether a platform-stored address (Zillow, Propwire, Redfin) contains
 * all parsed components of the LoopNet address.
 *
 * Each component is checked independently so differences in punctuation,
 * comma placement, and spacing between platforms don't cause false negatives.
 *
 * Examples that all match the same LoopNet address:
 *   LoopNet:  "2370 Losantiville Ave Cincinnati, OH 45237"
 *   Zillow:   "2370 Losantiville Ave, Cincinnati, OH 45237, Cincinnati, OH, 45237"
 *   Propwire: "2370 Losantiville Ave, Cincinnati, OH, 45237"
 *   Redfin:   "2370 Losantiville Ave, Cincinnati, OH, 45237"
 */
export function loopnetAddressMatchesPlatform(
  loopnetListing: RawListing,
  platformAddress: string | undefined | null
): boolean {
  if (!platformAddress || !loopnetListing.address) return false;

  const components = parseLoopnetAddress(loopnetListing.address);
  const target     = normalize(platformAddress);

  const checks: boolean[] = [];

  if (components.street) checks.push(target.includes(normalize(components.street)));
  if (components.city)   checks.push(target.includes(normalize(components.city)));
  if (components.state)  checks.push(target.includes(normalize(components.state)));
  if (components.zip)    checks.push(target.includes(normalize(components.zip)));

  // All present components must appear in the platform address
  return checks.length > 0 && checks.every(Boolean);
}