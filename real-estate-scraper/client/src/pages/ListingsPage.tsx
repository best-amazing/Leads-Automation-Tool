import React, { useState, useEffect } from 'react';
import { Header, PageContainer } from '@/components/layout';
import { ListingsTable, ScraperControls } from '@/components/listings';
import { ExportButton } from '@/components/common';
import { FilterBar } from '@/components/filters';
import { useListings } from '@/hooks';
import type { Listing } from '@/services';

interface ListingFilters {
  minPrice: string;
  maxPrice: string;
  source: string;
}

export const ListingsPage: React.FC = () => {
  const { listings, loading, error, refetch } = useListings();
  const [filteredListings, setFilteredListings] = useState<Listing[]>(listings);
  const [filters, setFilters] = useState<ListingFilters>({
    minPrice: '',
    maxPrice: '',
    source: 'all',
  });
  const [appliedFilters, setAppliedFilters] = useState<ListingFilters>(filters);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastRefreshTime, setLastRefreshTime] = useState<string>(new Date().toISOString());
  const [selectedDate, setSelectedDate] = useState<string>(
    new Date().toISOString().split("T")[0]
  );
  const [exportScope, setExportScope] = useState<'filtered' | 'all' | 'date'>('filtered');

  const applyListingFilter = () => {
    setAppliedFilters(filters);
  };

  const handleRefresh = async () => {
    await refetch();
    setLastRefreshTime(new Date().toISOString());
  };

  const handleScrapingStart = () => {
    setAutoRefresh(true);
    const refreshTimer = setTimeout(() => {
      handleRefresh();
      setAutoRefresh(false);
    }, 30000);
    return () => clearTimeout(refreshTimer);
  };

  useEffect(() => {
    const minPriceValue = parseInt(appliedFilters.minPrice, 10);
    const maxPriceValue = parseInt(appliedFilters.maxPrice, 10);

    setFilteredListings(
      listings.filter((listing) => {
        const validPrice = typeof listing.price === 'number';
        const matchesMin =
          !Number.isFinite(minPriceValue) ||
          (validPrice && listing.price! >= minPriceValue);
        const matchesMax =
          !Number.isFinite(maxPriceValue) ||
          (validPrice && listing.price! <= maxPriceValue);
        const matchesSource =
          appliedFilters.source === 'all' || listing.source === appliedFilters.source;
        return matchesMin && matchesMax && matchesSource;
      })
    );
  }, [listings, appliedFilters]);

  React.useEffect(() => {
    setFilteredListings(listings);
  }, [listings]);

  return (
    <PageContainer>
      {/* Page header */}
      <Header
        title="Listings"
        subtitle="Browse all property listings from your scraper sources"
      />

      <div className="px-8 py-6 space-y-6">

        {/* Scraper Controls */}
        <section className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
          <ScraperControls onScrapingStart={handleScrapingStart} />
        </section>

        {/* Action Bar */}
        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={handleRefresh}
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
                {/* Refresh icon */}
                <svg className="h-3.5 w-3.5" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M13.5 8A5.5 5.5 0 1 1 8 2.5" strokeLinecap="round"/>
                  <path d="M8 1v4l2.5-2L8 1z" fill="currentColor" stroke="none"/>
                </svg>
                Refresh Listings
              </>
            )}
          </button>
          <div className="flex items-center gap-3 -ml-3">
            <select
              value={exportScope}
              onChange={(e) => setExportScope(e.target.value as any)}
              className="px-3 py-2 border rounded-lg text-sm"
              disabled={loading}
            >
              <option value="filtered">Export filtered</option>
              <option value="all">Export all</option>
              <option value="date">Export by date</option>
            </select>

            {exportScope === 'date' && (
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => setSelectedDate(e.target.value)}
                className="px-3 py-2 border rounded-lg text-sm"
                disabled={loading}
              />
            )}

            <ExportButton
              data={
                exportScope === 'all'
                  ? listings
                  : exportScope === 'date'
                  ? listings.filter((l) => new Date(l.createdAt).toISOString().split('T')[0] === selectedDate)
                  : filteredListings
              }
              filename={exportScope === 'all' ? `listings-all` : exportScope === 'date' ? `listings-${selectedDate}` : 'listings'}
              dataType="listings"
              disabled={loading}
            />
          </div>

          {autoRefresh && (
            <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 font-medium">
              <span className="h-1.5 w-1.5 bg-emerald-400 rounded-full animate-pulse" />
              Auto-refreshing
            </span>
          )}
        </div>

        {/* Filter Bar */}
        <FilterBar
          minPrice={filters.minPrice}
          maxPrice={filters.maxPrice}
          source={filters.source}
          onMinPriceChange={(value) => setFilters((prev) => ({ ...prev, minPrice: value }))}
          onMaxPriceChange={(value) => setFilters((prev) => ({ ...prev, maxPrice: value }))}
          onSourceChange={(value) => setFilters((prev) => ({ ...prev, source: value }))}
          onApply={applyListingFilter}
          disabled={loading}
        />

        {/* Error */}
        {error && (
          <div className="flex items-start gap-3 bg-red-50 border border-red-100 text-red-700 px-4 py-3 rounded-xl text-sm">
            <svg className="h-4 w-4 mt-0.5 shrink-0" viewBox="0 0 16 16" fill="currentColor">
              <path d="M8 1a7 7 0 1 0 0 14A7 7 0 0 0 8 1zm0 10.5a.75.75 0 1 1 0-1.5.75.75 0 0 1 0 1.5zm.75-3.75a.75.75 0 0 1-1.5 0V5a.75.75 0 0 1 1.5 0v2.75z"/>
            </svg>
            <div>
              <p className="font-semibold">Error loading listings</p>
              <p className="text-red-600/80 mt-0.5">{error.message}</p>
            </div>
          </div>
        )}

        {/* Table */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden max-h-[720px]">
          {filteredListings.length === 0 && !loading ? (
            <div className="flex flex-col items-center justify-center py-20 text-center">
              <div className="h-10 w-10 rounded-full bg-slate-100 flex items-center justify-center mb-4">
                <svg className="h-5 w-5 text-slate-400" viewBox="0 0 20 20" fill="currentColor">
                  <path d="M3 4a1 1 0 0 1 1-1h12a1 1 0 0 1 1 1v2a1 1 0 0 1-.293.707L13 10.414V17a1 1 0 0 1-1.447.894l-4-2A1 1 0 0 1 7 15v-4.586L3.293 6.707A1 1 0 0 1 3 6V4z"/>
                </svg>
              </div>
              <p className="text-slate-700 font-medium">No listings found</p>
              <p className="text-slate-400 text-sm mt-1">Run a scraper above to fetch new listings</p>
            </div>
          ) : (
            <ListingsTable listings={filteredListings} loading={loading} />
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-between items-center text-xs text-slate-400 pt-1">
          <span>
            Showing{' '}
            <span className="font-semibold text-slate-700">{filteredListings.length}</span>{' '}
            listing{filteredListings.length !== 1 ? 's' : ''}
          </span>
          <span>Updated {new Date(lastRefreshTime).toLocaleTimeString()}</span>
        </div>

      </div>
    </PageContainer>
  );
};
