/**
 * Crexi to Zillow Address Normalizer
 * Zillow format: "Street Address, City, State ZipCode, City, State, ZipCode"
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
  const haystack = [listing.address, listing.title, listing.description, listing.location]
    .filter(Boolean)
    .join("\n");

  const reFull = /([0-9]+\s+[^,]+),\s*([^,]+),\s*([^,]*County[^,]*|[^,]+?),\s*([A-Za-z]{2})\s*(\d{5})/i;
  const m1 = haystack.match(reFull);
  if (m1) {
    components.street = m1[1].trim();
    components.city = m1[2].trim();
    components.state = m1[4].toUpperCase();
    components.zipCode = m1[5];
    return components;
  }

  const reSimple = /([0-9]+\s+[^,]+),\s*([^,]+),\s*([A-Za-z]{2})\s*(\d{5})/i;
  const m2 = haystack.match(reSimple);
  if (m2) {
    components.street = m2[1].trim();
    components.city = m2[2].trim();
    components.state = m2[3].toUpperCase();
    components.zipCode = m2[4];
    return components;
  }

  const reCityCounty = /([^,]+),\s*([^,]*County[^,]*),\s*([A-Za-z]{2})\s*(\d{5})/i;
  const m3 = haystack.match(reCityCounty);
  if (m3) {
    components.city = m3[1].trim();
    components.state = m3[3].toUpperCase();
    components.zipCode = m3[4];
    return components;
  }

  // Generic fallback
  const parts = haystack.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length > 0) {
    const last = parts[parts.length - 1];
    const stZip = last.match(/^([A-Za-z]{2})\s*(\d{5})$/);
    if (stZip) {
      components.state = stZip[1].toUpperCase();
      components.zipCode = stZip[2];
    } else {
      const zipOnly = last.match(/^(\d{5})$/);
      if (zipOnly) components.zipCode = zipOnly[1];
    }

    if (!components.street && parts.length >= 3 && /^\d/.test(parts[0])) {
      components.street = parts[0];
    }

    components.city = listing.location || components.city || parts[0];
  }

  return components;
}

/**
 * Formats extracted components to Zillow address format
 * Zillow format: "Street Address, City, State ZipCode, City, State, ZipCode"
 */
function formatAddress(components: AddressComponents): string {
  const parts: string[] = [];

  // Street address (not available from Crexi)
  if (components.street) {
    parts.push(components.street);
  }

  // City, State ZipCode
  if (components.city) {
    let cityPart = components.city;
    if (components.state) {
      cityPart += `, ${components.state}`;
      if (components.zipCode) {
        cityPart += ` ${components.zipCode}`;
      }
    }
    parts.push(cityPart);
  }

  // Repeat City, State, ZipCode for Zillow format
  if (components.city) {
    let repeatPart = components.city;
    if (components.state) {
      repeatPart += `, ${components.state}`;
      if (components.zipCode) {
        repeatPart += `, ${components.zipCode}`;
      }
    }
    parts.push(repeatPart);
  }

  return parts.join(", ");
}

/**
 * Normalizes Crexi listing to Zillow address format
 */
export function normalizeToZillowFormat(listing: CrexiListing): string {
  const components = extractAddressComponents(listing);
  // Zillow expects: "Street, City, State Zip, City, State, Zip"
  if (components.street && components.city && components.state) {
    const first = components.zipCode
      ? `${components.street}, ${components.city}, ${components.state} ${components.zipCode}`
      : `${components.street}, ${components.city}, ${components.state}`;
    const second = components.zipCode
      ? `${components.city}, ${components.state}, ${components.zipCode}`
      : `${components.city}, ${components.state}`;
    return `${first}, ${second}`;
  }

  // Fallback to city,state[,zip] repeated
  if (components.city && components.state) {
    const first = components.zipCode
      ? `${components.city}, ${components.state} ${components.zipCode}`
      : `${components.city}, ${components.state}`;
    const second = components.zipCode
      ? `${components.city}, ${components.state}, ${components.zipCode}`
      : `${components.city}, ${components.state}`;
    return `${first}, ${second}`;
  }

  return "";
}
