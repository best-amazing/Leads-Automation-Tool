import React, { useMemo, useState } from "react";
import { Header, PageContainer } from "@/components/layout";
import { ExportButton } from "@/components/common";
import { useProperties } from "@/hooks";
import { deleteListing, deleteEstimate, deleteProperty } from "@/services/api";

interface UnifiedListing {
  id: string;
  address: string;
  price?: number;
  url?: string;
  source: string;
  createdAt?: string;
  estimatedArv?: number;
  arv?: number;
  zillowEstimate?: number;
  zillowSourceUrl?: string;
  redfinEstimate?: number;
  redfinSourceUrl?: string;
  propwireEstimate?: number;
  propwireSourceUrl?: string;
  realtorEstimate?: number;
  realtorSourceUrl?: string;
}

const calculateMedian = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

const calculateArv = (
  price?: number,
  estimatedArv?: number,
): number | undefined => {
  if (price === undefined || estimatedArv === undefined || estimatedArv === 0)
    return undefined;
  const percentage = ((price + 50000) / estimatedArv) * 100;
  return Math.round(percentage * 100) / 100;
};

const fmt = (n?: number) => (n ? `$${n.toLocaleString()}` : "—");

/* ── Column header component ─────────────────────────────────────── */
const Th: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = "",
}) => (
  <th
    className={`
      px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider
      text-slate-400 whitespace-nowrap border-b border-slate-100
      ${className}
    `}
  >
    {children}
  </th>
);

/* ── Table cell ───────────────────────────────────────────────────── */
const Td: React.FC<{ children: React.ReactNode; className?: string }> = ({
  children,
  className = "",
}) => (
  <td
    className={`px-4 py-3 text-sm text-slate-600 border-b border-slate-50 ${className}`}
  >
    {children}
  </td>
);

export const PropertiesPage: React.FC = () => {
  const { properties, loading, error, refetch } = useProperties();
  const [deleteConfirm, setDeleteConfirm] = useState<{
    type: "listing" | "estimate" | "property";
    id: string;
    label: string;
  } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const unifiedListings = useMemo(() => {
    const listings: UnifiedListing[] = [];

    properties.forEach((property) => {
      const estimatedArv = calculateMedian(
        property.estimates.map((e) => e.value),
      );

      property.listings.forEach((listing) => {
        const arv = calculateArv(listing.price, estimatedArv);
        listings.push({
          id: listing.id,
          address: property.normalizedAddress || property.address || "N/A",
          price: listing.price,
          url: listing.url,
          source: listing.source,
          createdAt: listing.createdAt,
          estimatedArv,
          arv,
          zillowEstimate: property.estimates.find((e) => e.source === "zillow")
            ?.value,
          zillowSourceUrl: property.estimates.find((e) => e.source === "zillow")
            ?.sourceUrl,
          redfinEstimate: property.estimates.find((e) => e.source === "redfin")
            ?.value,
          redfinSourceUrl: property.estimates.find((e) => e.source === "redfin")
            ?.sourceUrl,
          propwireEstimate: property.estimates.find(
            (e) => e.source === "propwire",
          )?.value,
          propwireSourceUrl: property.estimates.find(
            (e) => e.source === "propwire",
          )?.sourceUrl,
          realtorEstimate: property.estimates.find(
            (e) => e.source === "realtor",
          )?.value,
          realtorSourceUrl: property.estimates.find(
            (e) => e.source === "realtor",
          )?.sourceUrl,
        });
      });
    });

    return listings;
  }, [properties]);

  const handleDelete = async () => {
    if (!deleteConfirm) return;

    setDeleteLoading(true);
    setDeleteError(null);

    try {
      if (deleteConfirm.type === "listing") {
        await deleteListing(deleteConfirm.id);
      } else if (deleteConfirm.type === "estimate") {
        await deleteEstimate(deleteConfirm.id);
      } else if (deleteConfirm.type === "property") {
        await deleteProperty(deleteConfirm.id);
      }

      // Refresh data after deletion
      await refetch();
      setDeleteConfirm(null);
    } catch (err: any) {
      setDeleteError(err.message || "Failed to delete item");
    } finally {
      setDeleteLoading(false);
    }
  };

  return (
    <PageContainer>
      <Header
        title="All Listings"
        subtitle="Unified view of property listings with ARV analysis"
      />

      <div className="px-8 py-6 space-y-6">
        {/* Action bar */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={refetch}
            disabled={loading}
            className="
              inline-flex items-center gap-2 px-4 py-2 text-sm font-medium
              bg-slate-900 text-white rounded-lg
              hover:bg-slate-700 active:scale-[0.98]
              disabled:opacity-40 disabled:cursor-not-allowed
              transition-all duration-150
            "
          >
            {loading ? (
              <>
                <span className="h-3.5 w-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                Refreshing…
              </>
            ) : (
              <>
                <svg
                  className="h-3.5 w-3.5"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.8"
                >
                  <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" strokeLinecap="round" />
                  <path
                    d="M8 1v4l2.5-2L8 1z"
                    fill="currentColor"
                    stroke="none"
                  />
                </svg>
                Refresh Data
              </>
            )}
          </button>

          <ExportButton
            data={unifiedListings}
            filename="all-listings"
            dataType="properties"
            disabled={loading}
          />
        </div>

        {/* Error */}
        {error && (
          <div className="flex items-start gap-3 bg-red-50 border border-red-100 text-red-700 px-4 py-3 rounded-xl text-sm">
            <svg
              className="h-4 w-4 mt-0.5 shrink-0"
              viewBox="0 0 16 16"
              fill="currentColor"
            >
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 10.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm.75-3.75a.75.75 0 0 1-1.5 0V5a.75.75 0 0 1 1.5 0v2.75z" />
            </svg>
            <p>{error.message}</p>
          </div>
        )}

        {/* Content */}
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <span className="h-6 w-6 border-2 border-slate-200 border-t-slate-500 rounded-full animate-spin" />
          </div>
        ) : unifiedListings.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 bg-white border border-slate-200 rounded-2xl">
            <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center mb-4">
              <svg
                className="h-5 w-5 text-slate-400"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path d="M10.707 2.293a1 1 0 0 0-1.414 0l-7 7a1 1 0 0 0 1.414 1.414L4 10.414V17a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v2a1 1 0 0 0 1 1h3a1 1 0 0 0 1-1v-6.586l.293.293a1 1 0 0 0 1.414-1.414l-7-7z" />
              </svg>
            </div>
            <p className="text-slate-700 font-medium">No listings found</p>
          </div>
        ) : (
          <div className="space-y-4">
            {/* Table */}
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse min-w-[1100px]">
                  <thead className="bg-slate-50/80">
                    <tr>
                      <Th>Address</Th>
                      <Th>Price</Th>
                      <Th>Source</Th>
                      <Th>Date Scraped</Th>
                      <Th>Est. ARV</Th>
                      <Th>ARV %</Th>
                      <Th>Zillow</Th>
                      <Th>Redfin</Th>
                      <Th>Propwire</Th>
                      <Th>Realtor</Th>
                      <Th>URL</Th>
                      <Th className="text-center">Actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {unifiedListings.map((listing) => (
                      <tr
                        key={listing.id}
                        className="hover:bg-slate-50/60 transition-colors duration-100"
                      >
                        <Td className="font-medium text-slate-800 max-w-[180px] truncate">
                          {listing.address}
                        </Td>
                        <Td className="font-medium text-slate-800">
                          {fmt(listing.price)}
                        </Td>
                        <Td>
                          <span className="inline-flex px-2 py-0.5 rounded-md bg-slate-100 text-slate-600 text-xs font-medium capitalize">
                            {listing.source}
                          </span>
                        </Td>
                        <Td>
                          {listing.createdAt
                            ? new Date(listing.createdAt).toLocaleDateString(
                                undefined,
                                {
                                  month: "short",
                                  day: "numeric",
                                  year: "numeric",
                                },
                              )
                            : "—"}
                        </Td>
                        <Td>{fmt(listing.estimatedArv)}</Td>
                        <Td>
                          {listing.arv !== undefined ? (
                            <span
                              className={`font-semibold ${
                                listing.arv <= 70
                                  ? "text-emerald-600"
                                  : listing.arv <= 85
                                    ? "text-amber-500"
                                    : "text-red-500"
                              }`}
                            >
                              {listing.arv.toFixed(2)}%
                            </span>
                          ) : (
                            "—"
                          )}
                        </Td>
                        <Td>
                          {listing.zillowEstimate ? (
                            listing.zillowSourceUrl ? (
                              <a
                                href={listing.zillowSourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-500 hover:text-slate-900 underline underline-offset-2 text-sm font-medium transition-colors"
                                title={listing.zillowSourceUrl}
                              >
                                {fmt(listing.zillowEstimate)}
                              </a>
                            ) : (
                              fmt(listing.zillowEstimate)
                            )
                          ) : (
                            "—"
                          )}
                        </Td>
                        <Td>
                          {listing.redfinEstimate ? (
                            listing.redfinSourceUrl ? (
                              <a
                                href={listing.redfinSourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-500 hover:text-slate-900 underline underline-offset-2 text-sm font-medium transition-colors"
                                title={listing.redfinSourceUrl}
                              >
                                {fmt(listing.redfinEstimate)}
                              </a>
                            ) : (
                              fmt(listing.redfinEstimate)
                            )
                          ) : (
                            "—"
                          )}
                        </Td>
                        <Td>
                          {listing.propwireEstimate ? (
                            listing.propwireSourceUrl ? (
                              <a
                                href={listing.propwireSourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-500 hover:text-slate-900 underline underline-offset-2 text-sm font-medium transition-colors"
                                title={listing.propwireSourceUrl}
                              >
                                {fmt(listing.propwireEstimate)}
                              </a>
                            ) : (
                              fmt(listing.propwireEstimate)
                            )
                          ) : (
                            "—"
                          )}
                        </Td>
                        <Td>
                          {listing.realtorEstimate ? (
                            listing.realtorSourceUrl ? (
                              <a
                                href={listing.realtorSourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-slate-500 hover:text-slate-900 underline underline-offset-2 text-sm font-medium transition-colors"
                                title={listing.realtorSourceUrl}
                              >
                                {fmt(listing.realtorEstimate)}
                              </a>
                            ) : (
                              fmt(listing.realtorEstimate)
                            )
                          ) : (
                            "—"
                          )}
                        </Td>
                        <Td>
                          {listing.url ? (
                            <a
                              href={listing.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-slate-500 hover:text-slate-900 underline underline-offset-2 text-xs truncate max-w-[160px] inline-block transition-colors"
                              title={listing.url}
                            >
                              {listing.url
                                .replace(/^https?:\/\//, "")
                                .substring(0, 36)}
                              …
                            </a>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </Td>
                        <Td className="text-center">
                          <button
                            onClick={() =>
                              setDeleteConfirm({
                                type: "listing",
                                id: listing.id,
                                label: `listing from ${listing.source}`,
                              })
                            }
                            className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 rounded transition-colors"
                            title="Delete listing"
                          >
                            <svg
                              className="h-3.5 w-3.5"
                              viewBox="0 0 16 16"
                              fill="currentColor"
                            >
                              <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" />
                              <path
                                fillRule="evenodd"
                                d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 1a.5.5 0 0 0-.5.5v1h13V1.5a.5.5 0 0 0-.5-.5h-3V1a.5.5 0 0 0-.5-.5h-2a.5.5 0 0 0-.5.5v.5h-3z"
                              />
                            </svg>
                            Delete
                          </button>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-sm mx-4 p-6">
            <div className="flex items-start gap-4">
              <div className="flex-shrink-0">
                <div className="flex items-center justify-center h-10 w-10 rounded-full bg-red-100">
                  <svg
                    className="h-5 w-5 text-red-600"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
                      clipRule="evenodd"
                    />
                  </svg>
                </div>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-slate-900">
                  Delete{" "}
                  {deleteConfirm.type === "listing"
                    ? "Listing"
                    : deleteConfirm.type === "estimate"
                      ? "Estimate"
                      : "Property"}
                  ?
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  Are you sure you want to delete this {deleteConfirm.label}?
                  This action cannot be undone.
                </p>
              </div>
            </div>

            {deleteError && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                {deleteError}
              </div>
            )}

            <div className="mt-6 flex gap-3 justify-end">
              <button
                onClick={() => setDeleteConfirm(null)}
                disabled={deleteLoading}
                className="px-4 py-2 text-sm font-medium text-slate-700 bg-slate-100 hover:bg-slate-200 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleDelete}
                disabled={deleteLoading}
                className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
              >
                {deleteLoading && (
                  <span className="h-3 w-3 border-2 border-white/40 border-t-white rounded-full animate-spin" />
                )}
                {deleteLoading ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageContainer>
  );
};

export default PropertiesPage;
