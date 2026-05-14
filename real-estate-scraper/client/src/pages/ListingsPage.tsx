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
      {/* Inject scoped styles */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

        .lp-root {
          --bg:        #0d1117;
          --surface:   #161b22;
          --surface2:  #1c2230;
          --border:    #2a3343;
          --amber:     #f0a500;
          --amber-dim: #7a5300;
          --text:      #e2e8f0;
          --muted:     #64748b;
          --danger:    #f87171;
          --blue:      #60a5fa;

          background: var(--bg);
          min-height: 100vh;
          font-family: 'Syne', sans-serif;
          color: var(--text);
        }

        .lp-root * { box-sizing: border-box; }

        /* ── Page header ── */
        .lp-header {
          padding: 2rem 2.5rem 0;
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          padding-bottom: 1.25rem;
        }
        .lp-header-eyebrow {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.65rem;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: var(--amber);
          margin-bottom: 0.35rem;
        }
        .lp-header-title {
          font-size: 1.75rem;
          font-weight: 800;
          letter-spacing: -0.02em;
          color: var(--text);
          margin: 0;
          line-height: 1;
        }
        .lp-header-sub {
          font-size: 0.8rem;
          color: var(--muted);
          margin-top: 0.35rem;
          font-weight: 400;
        }
        .lp-header-meta {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.7rem;
          color: var(--muted);
          text-align: right;
        }

        /* ── Inner layout ── */
        .lp-body { padding: 2rem 2.5rem; }

        /* ── Section labels ── */
        .lp-section-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.6rem;
          letter-spacing: 0.18em;
          text-transform: uppercase;
          color: var(--muted);
          margin-bottom: 0.75rem;
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }
        .lp-section-label::after {
          content: '';
          flex: 1;
          height: 1px;
          background: var(--border);
        }

        /* ── Scraper section card ── */
        .lp-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 10px;
          padding: 1.25rem 1.5rem;
          margin-bottom: 1.5rem;
        }

        /* ── Toolbar row ── */
        .lp-toolbar {
          display: flex;
          gap: 0.75rem;
          align-items: center;
          flex-wrap: wrap;
          margin-bottom: 1.5rem;
        }

        /* ── Buttons ── */
        .lp-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          padding: 0.5rem 1rem;
          border-radius: 6px;
          font-family: 'Syne', sans-serif;
          font-size: 0.8rem;
          font-weight: 600;
          cursor: pointer;
          border: none;
          transition: opacity 0.15s, background 0.15s;
        }
        .lp-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        .lp-btn-primary {
          background: var(--amber);
          color: #0d1117;
        }
        .lp-btn-primary:hover:not(:disabled) { background: #ffb830; }

        .lp-btn-ghost {
          background: var(--surface2);
          color: var(--text);
          border: 1px solid var(--border);
        }
        .lp-btn-ghost:hover:not(:disabled) { border-color: var(--amber); color: var(--amber); }

        /* spinner */
        .lp-spin {
          display: inline-block;
          width: 0.85rem; height: 0.85rem;
          border: 2px solid currentColor;
          border-top-color: transparent;
          border-radius: 50%;
          animation: lp-spin 0.7s linear infinite;
        }
        @keyframes lp-spin { to { transform: rotate(360deg); } }

        /* auto-refresh pill */
        .lp-pill {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.3rem 0.75rem;
          background: rgba(240,165,0,0.12);
          border: 1px solid var(--amber-dim);
          border-radius: 99px;
          font-size: 0.72rem;
          font-weight: 600;
          color: var(--amber);
          font-family: 'JetBrains Mono', monospace;
        }
        .lp-pill-dot {
          width: 0.45rem; height: 0.45rem;
          border-radius: 50%;
          background: var(--amber);
          animation: lp-pulse 1.2s ease-in-out infinite;
        }
        @keyframes lp-pulse { 0%,100%{opacity:1} 50%{opacity:0.35} }

        /* ── Error banner ── */
        .lp-error {
          background: rgba(248,113,113,0.08);
          border: 1px solid rgba(248,113,113,0.3);
          color: var(--danger);
          border-radius: 8px;
          padding: 0.85rem 1.1rem;
          display: flex;
          gap: 0.75rem;
          align-items: flex-start;
          margin-bottom: 1.25rem;
          font-size: 0.82rem;
        }
        .lp-error-icon { font-size: 1rem; flex-shrink: 0; }
        .lp-error-title { font-weight: 700; margin-bottom: 0.15rem; }

        /* ── Table wrapper ── */
        .lp-table-wrap {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 10px;
          overflow: hidden;
          max-height: 720px;
          overflow-y: auto;
        }
        /* Subtle scrollbar */
        .lp-table-wrap::-webkit-scrollbar { width: 4px; }
        .lp-table-wrap::-webkit-scrollbar-track { background: transparent; }
        .lp-table-wrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

        /* ── Empty state ── */
        .lp-empty {
          padding: 4rem 2rem;
          text-align: center;
        }
        .lp-empty-title {
          font-size: 1rem;
          font-weight: 700;
          color: var(--text);
          margin-bottom: 0.4rem;
        }
        .lp-empty-sub {
          font-size: 0.78rem;
          color: var(--muted);
        }

        /* ── Footer ── */
        .lp-footer {
          margin-top: 1.25rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.68rem;
          color: var(--muted);
        }
        .lp-footer-count strong { color: var(--text); }
      `}</style>

      <div className="lp-root">
        {/* ── Page header ── */}
        <div className="lp-header">
          <div>
            <div className="lp-header-eyebrow">Property Intelligence</div>
            <h1 className="lp-header-title">Listings</h1>
            <p className="lp-header-sub">Browse all property listings from your scraper sources</p>
          </div>
          <div className="lp-header-meta">
            Last sync<br />
            {new Date(lastRefreshTime).toLocaleTimeString()}
          </div>
        </div>

        <div className="lp-body">

          {/* ── Scraper Controls ── */}
          <div className="lp-section-label">Scraper</div>
          <div className="lp-card">
            <ScraperControls onScrapingStart={handleScrapingStart} />
          </div>

          {/* ── Toolbar ── */}
          <div className="lp-toolbar">
            <button
              className="lp-btn lp-btn-primary"
              onClick={handleRefresh}
              disabled={loading}
            >
              {loading ? (
                <><span className="lp-spin" />Refreshing…</>
              ) : (
                <>↻ Refresh Listings</>
              )}
            </button>

            {/* ExportButton renders its own element; wrap lightly */}
            <span className="lp-btn-ghost" style={{ padding: 0, border: 'none', background: 'none' }}>
              <ExportButton
                data={filteredListings}
                filename="listings"
                dataType="listings"
                disabled={loading}
              />
            </span>

            {autoRefresh && (
              <span className="lp-pill">
                <span className="lp-pill-dot" />
                Auto-refreshing
              </span>
            )}
          </div>

          {/* ── Filter Bar ── */}
          <div className="lp-section-label">Filters</div>
          <div className="lp-card" style={{ marginBottom: '1.5rem' }}>
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
          </div>

          {/* ── Error ── */}
          {error && (
            <div className="lp-error">
              <span className="lp-error-icon">⚠</span>
              <div>
                <p className="lp-error-title">Error loading listings</p>
                <p>{error.message}</p>
              </div>
            </div>
          )}

          {/* ── Table ── */}
          <div className="lp-section-label">Results</div>
          <div className="lp-table-wrap">
            {filteredListings.length === 0 && !loading ? (
              <div className="lp-empty">
                <p className="lp-empty-title">No listings found</p>
                <p className="lp-empty-sub">Run a scraper above to fetch new listings</p>
              </div>
            ) : (
              <ListingsTable listings={filteredListings} loading={loading} />
            )}
          </div>

          {/* ── Footer ── */}
          <div className="lp-footer">
            <span className="lp-footer-count">
              Showing <strong>{filteredListings.length}</strong> listing{filteredListings.length !== 1 ? 's' : ''}
            </span>
            <span>Updated {new Date(lastRefreshTime).toLocaleTimeString()}</span>
          </div>
        </div>
      </div>
    </PageContainer>
  );
};
