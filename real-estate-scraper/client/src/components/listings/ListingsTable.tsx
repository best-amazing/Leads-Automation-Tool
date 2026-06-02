import React, { useState } from "react";
import type { Listing } from "@/services";
import { deleteListing } from "@/services/api";
import { ListingRow } from "./ListingRow";
import { ListingDrawer } from "./ListingDrawer";

interface ListingsTableProps {
  listings: Listing[];
  loading?: boolean;
  onListingDeleted?: () => void;
}

export const ListingsTable: React.FC<ListingsTableProps> = ({
  listings,
  loading = false,
  onListingDeleted,
}) => {
  const [selectedListing, setSelectedListing] = useState<Listing | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{
    id: string;
    address: string;
  } | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async () => {
    if (!deleteConfirm) return;

    setDeleteLoading(true);
    setDeleteError(null);

    try {
      await deleteListing(deleteConfirm.id);
      setDeleteConfirm(null);
      onListingDeleted?.();
    } catch (err: any) {
      setDeleteError(err.message || "Failed to delete listing");
    } finally {
      setDeleteLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">Loading listings...</p>
      </div>
    );
  }

  if (listings.length === 0) {
    return (
      <div className="text-center py-12">
        <p className="text-gray-500">No listings found</p>
      </div>
    );
  }

  return (
    <>
      <div className="overflow-x-auto">
        <div className="min-w-full max-h-[640px] overflow-y-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left border-b bg-gray-100">
                <th className="px-4 py-3 font-semibold text-gray-700">
                  Address
                </th>
                <th className="px-4 py-3 font-semibold text-gray-700">Price</th>
                <th className="px-4 py-3 font-semibold text-gray-700">
                  Source
                </th>
                <th className="px-4 py-3 font-semibold text-gray-700">
                  Date Scrapped
                </th>
                <th className="px-4 py-3 font-semibold text-gray-700">URL</th>
                <th className="px-4 py-3 font-semibold text-gray-700 text-center">
                  Actions
                </th>
              </tr>
            </thead>
            <tbody>
              {listings.map((listing) => (
                <ListingRow
                  key={listing.id}
                  listing={listing}
                  onClick={() => setSelectedListing(listing)}
                  onDelete={() =>
                    setDeleteConfirm({
                      id: listing.id,
                      address:
                        listing.rawAddress || listing.location || "unknown",
                    })
                  }
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selectedListing && (
        <ListingDrawer
          listing={selectedListing}
          onClose={() => setSelectedListing(null)}
        />
      )}

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
                  Delete Listing?
                </h3>
                <p className="mt-2 text-sm text-slate-600">
                  Are you sure you want to delete the listing from{" "}
                  <span className="font-medium">{deleteConfirm.address}</span>?
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
    </>
  );
};
