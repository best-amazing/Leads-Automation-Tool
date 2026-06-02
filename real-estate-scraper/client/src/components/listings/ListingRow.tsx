import React from "react";
import { Badge } from "../common";
import type { Listing } from "../../services";

interface ListingRowProps {
  listing: Listing;
  onClick: () => void;
  onDelete?: () => void;
}

export const ListingRow: React.FC<ListingRowProps> = ({
  listing,
  onClick,
  onDelete,
}) => {
  const formatCurrency = (value?: number) => {
    if (value === undefined || value === null) return "N/A";
    return `$${value.toLocaleString()}`;
  };

  const truncateUrl = (url: string, maxLength: number = 40) => {
    if (url.length <= maxLength) return url;
    return url.substring(0, maxLength) + "...";
  };

  return (
    <tr
      onClick={onClick}
      className="border-b hover:bg-gray-50 cursor-pointer transition-colors"
    >
      <td className="px-4 py-3 font-medium text-gray-900">
        {listing.rawAddress || listing.location || "N/A"}
      </td>
      <td className="px-4 py-3">{formatCurrency(listing.price)}</td>
      <td className="px-4 py-3">
        <Badge value={listing.source} variant="info" />
      </td>
      <td className="px-4 py-3 text-sm text-gray-600">
        {listing.createdAt
          ? new Date(listing.createdAt).toLocaleString()
          : "N/A"}
      </td>
      <td className="px-4 py-3">
        {listing.url ? (
          <a
            href={listing.url}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            title={listing.url}
            className="text-blue-600 hover:text-blue-800 hover:underline truncate inline-block max-w-xs"
          >
            {truncateUrl(listing.url)}
          </a>
        ) : (
          "N/A"
        )}
      </td>
      <td className="px-4 py-3 text-center">
        <button
          onClick={(e) => {
            e.stopPropagation();
            onDelete?.();
          }}
          className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 rounded transition-colors"
          title="Delete listing"
        >
          <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path d="M5.5 5.5A.5.5 0 0 1 6 6v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm2.5 0a.5.5 0 0 1 .5.5v6a.5.5 0 0 1-1 0V6a.5.5 0 0 1 .5-.5zm3 .5a.5.5 0 0 0-1 0v6a.5.5 0 0 0 1 0V6z" />
            <path
              fillRule="evenodd"
              d="M14.5 3a1 1 0 0 1-1 1H13v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V4h-.5a1 1 0 0 1-1-1V2a1 1 0 0 1 1-1H6a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1h3.5a1 1 0 0 1 1 1v1zM4.118 4 4 4.059V13a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V4.059L11.882 4H4.118zM2.5 1a.5.5 0 0 0-.5.5v1h13V1.5a.5.5 0 0 0-.5-.5h-3V1a.5.5 0 0 0-.5-.5h-2a.5.5 0 0 0-.5.5v.5h-3z"
            />
          </svg>
          Delete
        </button>
      </td>
    </tr>
  );
};
