import type {
  ApiResponse,
  FilterCriteria,
  ListingsPayload,
  PropertiesPayload,
  SavedFilter,
  SourceListingsPayload,
} from "./types";

const API_BASE_URL = "https://leads-automation-tool.onrender.com/api/v1";

async function fetchJson<T>(
  input: RequestInfo,
  init?: RequestInit,
): Promise<T> {
  const response = await fetch(input, {
    headers: {
      "Content-Type": "application/json",
    },
    ...init,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `API request failed: ${response.status} ${response.statusText} - ${errorText}`,
    );
  }

  return response.json();
}

function buildUrl(
  path: string,
  query?: Record<string, string | number | null | undefined>,
) {
  const url = new URL(`${API_BASE_URL}${path}`, window.location.origin);

  if (query) {
    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
  }

  return url.toString();
}

export async function getAllListings(limit = 1000): Promise<ListingsPayload> {
  const url = buildUrl("/listings", { limit });
  const response = await fetchJson<ApiResponse<ListingsPayload>>(url);
  return response.data;
}

export async function getZillowListings(
  limit = 1000,
): Promise<SourceListingsPayload> {
  const url = buildUrl("/listings/zillow", { limit });
  const response = await fetchJson<ApiResponse<SourceListingsPayload>>(url);
  return response.data;
}

export async function getRedfinListings(
  limit = 1000,
): Promise<SourceListingsPayload> {
  const url = buildUrl("/listings/redfin", { limit });
  const response = await fetchJson<ApiResponse<SourceListingsPayload>>(url);
  return response.data;
}

export async function getRealtorListings(
  limit = 1000,
): Promise<SourceListingsPayload> {
  const url = buildUrl("/listings/realtor", { limit });
  const response = await fetchJson<ApiResponse<SourceListingsPayload>>(url);
  return response.data;
}

export async function getPropwireListings(
  limit = 1000,
): Promise<SourceListingsPayload> {
  const url = buildUrl("/listings/propwire", { limit });
  const response = await fetchJson<ApiResponse<SourceListingsPayload>>(url);
  return response.data;
}

export async function getAllProperties(
  limit = 1000,
): Promise<PropertiesPayload> {
  const url = buildUrl("/properties", { limit });
  const response = await fetchJson<ApiResponse<PropertiesPayload>>(url);
  return response.data;
}

export async function getFilter(): Promise<SavedFilter | null> {
  const url = buildUrl("/filters");
  const response = await fetchJson<ApiResponse<SavedFilter | null>>(url);
  return response.data;
}

export async function updateFilter(
  filter: FilterCriteria,
): Promise<SavedFilter> {
  const url = buildUrl("/filters");
  const response = await fetchJson<ApiResponse<SavedFilter>>(url, {
    method: "PUT",
    body: JSON.stringify(filter),
  });
  return response.data;
}

export async function triggerScraper(source: string = "all"): Promise<any> {
  const url = buildUrl("/scrape/trigger");
  const response = await fetchJson<any>(url, {
    method: "POST",
    body: JSON.stringify({ source }),
  });
  return response;
}

export async function stopScraper(): Promise<any> {
  const url = buildUrl("/scrape/stop");
  const response = await fetchJson<any>(url, {
    method: "POST",
  });
  return response;
}

export async function getScrapeStatus(): Promise<any> {
  const url = buildUrl("/scrape/status");
  const response = await fetch(url, {
    headers: { "Content-Type": "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch scrape status: ${response.status}`);
  }
  return response.json();
}

/**
 * Export utilities for downloading data as CSV or JSON
 */

export function exportToCSV<T extends Record<string, any>>(
  data: T[],
  filename: string,
  columns?: (keyof T)[],
): void {
  if (data.length === 0) {
    console.warn("No data to export");
    return;
  }

  // Determine columns
  const cols = columns || (Object.keys(data[0]) as (keyof T)[]);

  // Create CSV header
  const header = cols.map((col) => `"${String(col)}"`).join(",");

  // Create CSV rows
  const rows = data.map((row) =>
    cols
      .map((col) => {
        const value = row[col];
        if (value === null || value === undefined) return "";
        const stringValue = String(value);
        // Escape quotes and wrap in quotes if contains comma or newline
        if (
          stringValue.includes(",") ||
          stringValue.includes('"') ||
          stringValue.includes("\n")
        ) {
          return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return `"${stringValue}"`;
      })
      .join(","),
  );

  const csv = [header, ...rows].join("\n");
  downloadFile(csv, filename, "text/csv");
}

export function exportToJSON<T>(data: T[], filename: string): void {
  const json = JSON.stringify(data, null, 2);
  downloadFile(json, filename, "application/json");
}

function downloadFile(
  content: string,
  filename: string,
  mimeType: string,
): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

// ── Delete operations ────────────────────────────────────────────────────────

export async function deleteListing(listingId: string): Promise<void> {
  const url = buildUrl(`/listings/${listingId}`);
  const response = await fetchJson<any>(url, {
    method: "DELETE",
  });
  return response.data;
}

export async function deleteEstimate(estimateId: string): Promise<void> {
  const url = buildUrl(`/estimates/${estimateId}`);
  const response = await fetchJson<any>(url, {
    method: "DELETE",
  });
  return response.data;
}

export async function deleteProperty(propertyId: string): Promise<void> {
  const url = buildUrl(`/properties/${propertyId}`);
  const response = await fetchJson<any>(url, {
    method: "DELETE",
  });
  return response.data;
}
