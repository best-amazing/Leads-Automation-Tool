export function normalizeStreetToken(value: string): string {
  return value
    .replace(/\b(?:street|st)\.?\b/gi, "st")
    .replace(/\b(?:avenue|ave)\.?\b/gi, "ave")
    .replace(/\b(?:road|rd)\.?\b/gi, "rd")
    .replace(/\b(?:boulevard|blvd)\.?\b/gi, "blvd")
    .replace(/\b(?:drive|dr)\.?\b/gi, "dr")
    .replace(/\b(?:lane|ln)\.?\b/gi, "ln")
    .replace(/\b(?:court|ct)\.?\b/gi, "ct")
    .replace(/\b(?:place|pl)\.?\b/gi, "pl")
    .replace(/\b(?:way)\.?\b/gi, "way")
    .replace(/[^a-z0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function extractZip(address: string): string | undefined {
  const matches = [...address.matchAll(/\b\d{5}(?:-\d{4})?\b/g)].map(
    (m) => m[0],
  );
  return matches.at(-1) ?? matches[0];
}

export function stripLocationSuffix(address: string): string {
  const normalized = address
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const zip = extractZip(normalized);
  if (zip) {
    const withoutZip = normalized
      .replace(new RegExp(`\\b${zip}\\b`, "g"), "")
      .trim();
    const firstChunk = withoutZip
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)[0];

    return firstChunk ?? withoutZip;
  }

  return (
    normalized
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)[0] ?? normalized
  );
}

export function dedupKey(
  listing: Partial<{ address?: string; url?: string }>,
): string {
  if (listing.address) {
    const zip = extractZip(listing.address);
    const streetCore = stripLocationSuffix(listing.address);
    const base = normalizeStreetToken(streetCore || listing.address);
    return zip ? `${base}|${zip}` : base;
  }

  return (listing.url ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}
