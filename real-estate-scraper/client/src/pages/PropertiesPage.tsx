import React, { useMemo } from 'react';
import { Header, PageContainer } from '@/components/layout';
import { ExportButton } from '@/components/common';
import { useProperties } from '@/hooks';

// Unified listing format for display
interface UnifiedListing {
  id: string;
  address: string;
  price?: number;
  url?: string;
  source: string;
  createdAt?: string;
  estimatedArv?: number; // After Repair Value (median estimate)
  arv?: number; // (price + 50000) / estimatedArv, rounded to 2 decimals
  zillowEstimate?: number;
  redfinEstimate?: number;
  propwireEstimate?: number;
  realtorEstimate?: number;
}

// Helper: Calculate median of values
const calculateMedian = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

// Helper: Calculate ARV ratio (price + repair cost) / estimatedArv
const calculateArv = (price?: number, estimatedArv?: number): number | undefined => {
  if (price === undefined || estimatedArv === undefined || estimatedArv === 0) return undefined;
  const ratio = (price + 50000) / estimatedArv;
  return Math.round(ratio * 100) / 100; // Round to 2 decimal places
};

export const PropertiesPage: React.FC = () => {
  const { properties, loading, error, refetch } = useProperties();

  // Combine all listings into unified format
  const unifiedListings = useMemo(() => {
    const listings: UnifiedListing[] = [];

    // Build unified listings only from the `properties` endpoint
    properties.forEach((property) => {
      const estimatedArv = calculateMedian(property.estimates.map((est) => est.value));

        property.listings.forEach((listing) => {
          const arv = calculateArv(listing.price, estimatedArv);

          // Extract per-source estimates (if present)
          const zillowEst = property.estimates.find((e) => e.source === 'zillow')?.value;
          const redfinEst = property.estimates.find((e) => e.source === 'redfin')?.value;
          const propwireEst = property.estimates.find((e) => e.source === 'propwire')?.value;
          const realtorEst = property.estimates.find((e) => e.source === 'realtor')?.value;

          listings.push({
            id: listing.id,
            address: property.normalizedAddress || property.address || 'N/A',
            price: listing.price,
            url: listing.url,
            source: listing.source,
            createdAt: listing.createdAt,
            estimatedArv,
            arv,
            zillowEstimate: zillowEst,
            redfinEstimate: redfinEst,
            propwireEstimate: propwireEst,
            realtorEstimate: realtorEst,
          });
        });
    });

    return listings;
  }, [properties]);

  const handleRefresh = async () => {
    // Only refetch properties on this page
    await refetch();
  };

  const getSourceBadgeColor = () => 'bg-gray-100 text-gray-800';

  return (
    <PageContainer>
      <Header
        title="All Listings"
        subtitle="Unified view of property listings with address, price, estimated ARV, ARV, and URL"
      />

      <div className="p-8">
        <div className="mb-6 flex gap-4 flex-wrap items-center">
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed font-medium flex items-center gap-2"
          >
            {loading ? (
              <>
                <span className="inline-block h-4 w-4 border-2 border-white border-t-transparent rounded-full animate-spin"></span>
                Refreshing...
              </>
            ) : (
              <>
                <span>🔄</span>
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

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-800 px-4 py-3 rounded mb-4">
            <p>Properties Error: {error.message}</p>
          </div>
        )}

        {loading ? (
          <div className="text-center py-12">
            <p className="text-gray-500">Loading listings...</p>
          </div>
        ) : (
          <div>
            {unifiedListings.length === 0 ? (
              <div className="text-center py-12 bg-gray-50 rounded">
                <p className="text-gray-500">No listings found</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                  <thead>
                    <tr className="bg-gray-100 border-b-2 border-gray-300">
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Address</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Price</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Source</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Date Scrapped</th>
                      
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Estimated ARV</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">ARV</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Zillow Estimate</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Redfin Estimate</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Propwire Estimate</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">Realtor Estimate</th>
                      <th className="px-4 py-3 text-left font-semibold text-gray-900">URL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unifiedListings.map((listing) => (
                      <tr
                        key={listing.id}
                        className="border-b border-gray-200 hover:bg-gray-50 transition-colors"
                      >
                        <td className="px-4 py-3 text-sm text-gray-900 font-medium max-w-xs truncate">
                          {listing.address}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {listing.price ? `$${listing.price.toLocaleString()}` : 'N/A'}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`px-3 py-1 rounded-full text-xs font-semibold capitalize ${getSourceBadgeColor()}`}>
                            {listing.source}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {listing.createdAt ? new Date(listing.createdAt).toLocaleString() : 'N/A'}
                        </td>
                        
                        <td className="px-4 py-3 text-sm text-gray-600 font-medium">
                          {listing.estimatedArv ? `$${listing.estimatedArv.toLocaleString()}` : 'N/A'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600 font-medium">
                          {listing.arv !== undefined ? listing.arv.toFixed(2) : 'N/A'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {listing.zillowEstimate ? `$${listing.zillowEstimate.toLocaleString()}` : 'N/A'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {listing.redfinEstimate ? `$${listing.redfinEstimate.toLocaleString()}` : 'N/A'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {listing.propwireEstimate ? `$${listing.propwireEstimate.toLocaleString()}` : 'N/A'}
                        </td>
                        <td className="px-4 py-3 text-sm text-gray-600">
                          {listing.realtorEstimate ? `$${listing.realtorEstimate.toLocaleString()}` : 'N/A'}
                        </td>
                        <td className="px-4 py-3 text-sm">
                          {listing.url ? (
                            <a
                              href={listing.url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:text-blue-800 hover:underline truncate max-w-xs inline-block"
                              title={listing.url}
                            >
                              {listing.url.length > 40
                                ? `${listing.url.substring(0, 40)}...`
                                : listing.url}
                            </a>
                          ) : (
                            <span className="text-gray-400">N/A</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="mt-6 p-4 bg-gray-50 rounded border border-gray-200">
              <h3 className="font-semibold text-gray-900 mb-3">Summary</h3>
              <div className="grid grid-cols-2 md:grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-gray-600">Total Listings</p>
                  <p className="text-2xl font-bold text-gray-900">{unifiedListings.length}</p>
                </div>
                <div>
                  <p className="text-xs text-gray-600">Total Properties</p>
                  <p className="text-2xl font-bold text-gray-900">{properties.length}</p>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
};

export default PropertiesPage;
