/**
 * Crexi to Propwire Address Normalizer
 * Propwire format: "Street Address, City, State, ZipCode"
 * 
 * Note: Crexi does not provide address data; location info is extracted from title
 */

interface CrexiListing {
  url?: string;
  source?: string;
  title?: string;
  address?: string;
  location?: string;
  price?: number;
  propertyType?: string;
  description?: string;
}

interface AddressComponents {
  street?: string;
  city?: string;
  state?: string;
  zipCode?: string;
}

/**
 * Extracts address components from Crexi listing data
 * Crexi provides limited location info in title; attempts to parse it
 */
function extractAddressComponents(listing: CrexiListing): AddressComponents {
  const components: AddressComponents = {};

  // Search address/title/description/location for address-like text
  const haystack = [listing.address, listing.title, listing.description, listing.location]
    .filter(Boolean)
    .join("\n");

  // Regex 1: street, city, county (optional contains 'County'), state ZIP
  const reFull = /([0-9]+\s+[^,]+),\s*([^,]+),\s*([^,]*County[^,]*|[^,]+?),\s*([A-Za-z]{2})\s*(\d{5})/i;
  const m1 = haystack.match(reFull);
  if (m1) {
    components.street = m1[1].trim();
    components.city = m1[2].trim();
    // county is in m1[3] but we don't need it for Propwire
    components.state = m1[4].toUpperCase();
    components.zipCode = m1[5];
    return components;
  }

  // Regex 2: street, city, state ZIP (no county)
  const reSimple = /([0-9]+\s+[^,]+),\s*([^,]+),\s*([A-Za-z]{2})\s*(\d{5})/i;
  const m2 = haystack.match(reSimple);
  if (m2) {
    components.street = m2[1].trim();
    components.city = m2[2].trim();
    components.state = m2[3].toUpperCase();
    components.zipCode = m2[4];
    return components;
  }

  // Regex 3: city, county, state ZIP (no street)
  const reCityCounty = /([^,]+),\s*([^,]*County[^,]*),\s*([A-Za-z]{2})\s*(\d{5})/i;
  const m3 = haystack.match(reCityCounty);
  if (m3) {
    components.city = m3[1].trim();
    components.state = m3[3].toUpperCase();
    components.zipCode = m3[4];
    return components;
  }

  // Generic fallback: split on commas and inspect last tokens for state/zip
  const parts = haystack.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length > 0) {
    // Try last part for "ST 12345" or just zip
    const last = parts[parts.length - 1];
    const stZip = last.match(/^([A-Za-z]{2})\s*(\d{5})$/);
    if (stZip) {
      components.state = stZip[1].toUpperCase();
      components.zipCode = stZip[2];
    } else {
      const zipOnly = last.match(/^(\d{5})$/);
      if (zipOnly) components.zipCode = zipOnly[1];
    }

    // Determine street if present (prefer parts[0] when it starts with a number)
    if (!components.street && parts.length >= 3 && /^\d/.test(parts[0])) {
      components.street = parts[0];
    }

    // City: prefer explicit location or the earliest non-state token
    components.city = listing.location || components.city || parts[0];
  }

  return components;
}

/**
 * Formats extracted components to Propwire address format
 * Propwire format: "Street Address, City, State, ZipCode"
 */
function formatAddress(components: AddressComponents): string {
  const parts: string[] = [];

  // Street address (not available from Crexi)
  if (components.street) {
    parts.push(components.street);
  }

  // City
  if (components.city) {
    parts.push(components.city);
  }

  // State
  if (components.state) {
    parts.push(components.state);
  }

  // ZipCode
  if (components.zipCode) {
    parts.push(components.zipCode);
  }

  return parts.join(", ");
}

/**
 * Normalizes Crexi listing to Propwire address format
 */
export function normalizeToPropwireFormat(listing: CrexiListing): string {
  const components = extractAddressComponents(listing);
  // Propwire expects: "Street Address, City, State, ZipCode"
  const parts: string[] = [];
  if (components.street) parts.push(components.street);
  if (components.city) parts.push(components.city);
  if (components.state) parts.push(components.state || "");
  if (components.zipCode) parts.push(components.zipCode);
  // Remove any empty parts
  return parts.filter(Boolean).join(", ");
}
