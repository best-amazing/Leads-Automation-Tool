import React, { useMemo } from 'react';
import { Header, PageContainer } from '@/components/layout';
import { ExportButton } from '@/components/common';
import { useProperties } from '@/hooks';

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
  redfinEstimate?: number;
  propwireEstimate?: number;
  realtorEstimate?: number;
}

const calculateMedian = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

const calculateArv = (price?: number, estimatedArv?: number): number | undefined => {
  if (price === undefined || estimatedArv === undefined || estimatedArv === 0) return undefined;
  return Math.round(((price + 50000) / estimatedArv) * 100) / 100;
};

const fmt = (n?: number) => (n ? `$${n.toLocaleString()}` : '—');

export const PropertiesPage: React.FC = () => {
  const { properties, loading, error, refetch } = useProperties();

  const unifiedListings = useMemo(() => {
    const listings: UnifiedListing[] = [];
    properties.forEach((property) => {
      const estimatedArv = calculateMedian(property.estimates.map((e) => e.value));
      property.listings.forEach((listing) => {
        listings.push({
          id: listing.id,
          address: property.normalizedAddress || property.address || 'N/A',
          price: listing.price,
          url: listing.url,
          source: listing.source,
          createdAt: listing.createdAt,
          estimatedArv,
          arv: calculateArv(listing.price, estimatedArv),
          zillowEstimate: property.estimates.find((e) => e.source === 'zillow')?.value,
          redfinEstimate: property.estimates.find((e) => e.source === 'redfin')?.value,
          propwireEstimate: property.estimates.find((e) => e.source === 'propwire')?.value,
          realtorEstimate: property.estimates.find((e) => e.source === 'realtor')?.value,
        });
      });
    });
    return listings;
  }, [properties]);

  const handleRefresh = async () => { await refetch(); };

  /* ARV colour coding */
  const arvColor = (arv?: number) => {
    if (arv === undefined) return '#64748b';
    if (arv <= 0.7) return '#4ade80';   // green – good deal
    if (arv <= 0.85) return '#f0a500';  // amber – fair
    return '#f87171';                   // red – expensive
  };

  return (
    <PageContainer>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

        .pp-root {
          --bg:       #0d1117;
          --surface:  #161b22;
          --surface2: #1c2230;
          --border:   #2a3343;
          --amber:    #f0a500;
          --text:     #e2e8f0;
          --muted:    #64748b;
          --danger:   #f87171;

          background: var(--bg);
          min-height: 100vh;
          font-family: 'Syne', sans-serif;
          color: var(--text);
        }
        .pp-root * { box-sizing: border-box; }

        /* Header */
        .pp-header {
          padding: 2rem 2.5rem 1.25rem;
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
        }
        .pp-eyebrow {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.65rem;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: var(--amber);
          margin-bottom: 0.35rem;
        }
        .pp-title {
          font-size: 1.75rem;
          font-weight: 800;
          letter-spacing: -0.02em;
          margin: 0;
          line-height: 1;
        }
        .pp-sub {
          font-size: 0.8rem;
          color: var(--muted);
          margin-top: 0.35rem;
          font-weight: 400;
        }

        /* Body */
        .pp-body { padding: 2rem 2.5rem; }

        /* Section label */
        .pp-label {
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
        .pp-label::after { content:''; flex:1; height:1px; background:var(--border); }

        /* Toolbar */
        .pp-toolbar {
          display: flex;
          gap: 0.75rem;
          align-items: center;
          flex-wrap: wrap;
          margin-bottom: 2rem;
        }

        /* Buttons */
        .pp-btn {
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
          background: var(--amber);
          color: #0d1117;
          transition: background 0.15s;
        }
        .pp-btn:hover:not(:disabled) { background: #ffb830; }
        .pp-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .pp-spin {
          display: inline-block;
          width: 0.85rem; height: 0.85rem;
          border: 2px solid currentColor;
          border-top-color: transparent;
          border-radius: 50%;
          animation: pp-spin 0.7s linear infinite;
        }
        @keyframes pp-spin { to { transform: rotate(360deg); } }

        /* Error */
        .pp-error {
          background: rgba(248,113,113,0.08);
          border: 1px solid rgba(248,113,113,0.3);
          color: var(--danger);
          border-radius: 8px;
          padding: 0.85rem 1.1rem;
          font-size: 0.82rem;
          margin-bottom: 1.25rem;
        }

        /* Loading */
        .pp-loading {
          text-align: center;
          padding: 5rem 2rem;
          font-size: 0.82rem;
          color: var(--muted);
          font-family: 'JetBrains Mono', monospace;
        }

        /* Empty */
        .pp-empty {
          padding: 4rem 2rem;
          text-align: center;
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 10px;
        }
        .pp-empty p { color: var(--muted); font-size: 0.85rem; }

        /* Table */
        .pp-table-wrap {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 10px;
          overflow: auto;
        }
        .pp-table-wrap::-webkit-scrollbar { width: 4px; height: 4px; }
        .pp-table-wrap::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

        table.pp-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 0.78rem;
        }
        table.pp-table thead tr {
          border-bottom: 1px solid var(--border);
          background: var(--surface2);
          position: sticky;
          top: 0;
          z-index: 1;
        }
        table.pp-table th {
          padding: 0.8rem 1rem;
          text-align: left;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.6rem;
          letter-spacing: 0.1em;
          text-transform: uppercase;
          color: var(--muted);
          font-weight: 500;
          white-space: nowrap;
        }
        table.pp-table tbody tr {
          border-bottom: 1px solid var(--border);
          transition: background 0.1s;
        }
        table.pp-table tbody tr:last-child { border-bottom: none; }
        table.pp-table tbody tr:hover { background: var(--surface2); }

        table.pp-table td {
          padding: 0.75rem 1rem;
          color: var(--text);
          vertical-align: middle;
          white-space: nowrap;
        }

        .pp-address {
          max-width: 200px;
          overflow: hidden;
          text-overflow: ellipsis;
          font-weight: 600;
          color: var(--text);
        }
        .pp-price {
          font-family: 'JetBrains Mono', monospace;
          font-weight: 500;
        }
        .pp-source-badge {
          display: inline-block;
          padding: 0.2rem 0.55rem;
          border-radius: 4px;
          font-size: 0.65rem;
          font-family: 'JetBrains Mono', monospace;
          letter-spacing: 0.05em;
          background: var(--surface2);
          border: 1px solid var(--border);
          color: var(--muted);
          text-transform: capitalize;
        }
        .pp-date {
          font-family: 'JetBrains Mono', monospace;
          color: var(--muted);
          font-size: 0.72rem;
        }
        .pp-est {
          font-family: 'JetBrains Mono', monospace;
          color: var(--muted);
        }
        .pp-arv {
          font-family: 'JetBrains Mono', monospace;
          font-weight: 700;
          font-size: 0.82rem;
        }
        .pp-link {
          color: var(--amber);
          text-decoration: none;
          font-size: 0.72rem;
          max-width: 180px;
          display: inline-block;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .pp-link:hover { text-decoration: underline; }
        .pp-na { color: var(--border); }

        /* Summary strip */
        .pp-summary {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 1px;
          background: var(--border);
          border: 1px solid var(--border);
          border-radius: 10px;
          overflow: hidden;
          margin-top: 1.5rem;
        }
        .pp-stat {
          background: var(--surface);
          padding: 1.25rem 1.5rem;
        }
        .pp-stat-label {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.6rem;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: var(--muted);
          margin-bottom: 0.4rem;
        }
        .pp-stat-value {
          font-size: 2rem;
          font-weight: 800;
          letter-spacing: -0.03em;
          color: var(--text);
          line-height: 1;
        }
      `}</style>

      <div className="pp-root">
        {/* Header */}
        <div className="pp-header">
          <div>
            <div className="pp-eyebrow">Property Intelligence</div>
            <h1 className="pp-title">All Listings</h1>
            <p className="pp-sub">Unified view with address, price, ARV estimates, and source data</p>
          </div>
        </div>

        <div className="pp-body">
          {/* Toolbar */}
          <div className="pp-toolbar">
            <button className="pp-btn" onClick={handleRefresh} disabled={loading}>
              {loading ? <><span className="pp-spin" />Refreshing…</> : <>↻ Refresh Data</>}
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
            <div className="pp-error">⚠ Properties Error: {error.message}</div>
          )}

          {loading ? (
            <div className="pp-loading">Loading listings…</div>
          ) : unifiedListings.length === 0 ? (
            <div className="pp-empty"><p>No listings found</p></div>
          ) : (
            <>
              <div className="pp-label">Results</div>
              <div className="pp-table-wrap">
                <table className="pp-table">
                  <thead>
                    <tr>
                      <th>Address</th>
                      <th>Price</th>
                      <th>Source</th>
                      <th>Date Scraped</th>
                      <th>Est. ARV</th>
                      <th>ARV Ratio</th>
                      <th>Zillow</th>
                      <th>Redfin</th>
                      <th>Propwire</th>
                      <th>Realtor</th>
                      <th>URL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {unifiedListings.map((listing) => (
                      <tr key={listing.id}>
                        <td><div className="pp-address" title={listing.address}>{listing.address}</div></td>
                        <td><span className="pp-price">{fmt(listing.price)}</span></td>
                        <td><span className="pp-source-badge">{listing.source}</span></td>
                        <td>
                          <span className="pp-date">
                            {listing.createdAt
                              ? new Date(listing.createdAt).toLocaleString()
                              : <span className="pp-na">—</span>}
                          </span>
                        </td>
                        <td><span className="pp-est">{fmt(listing.estimatedArv)}</span></td>
                        <td>
                          <span className="pp-arv" style={{ color: arvColor(listing.arv) }}>
                            {listing.arv !== undefined ? listing.arv.toFixed(2) : <span className="pp-na">—</span>}
                          </span>
                        </td>
                        <td><span className="pp-est">{fmt(listing.zillowEstimate)}</span></td>
                        <td><span className="pp-est">{fmt(listing.redfinEstimate)}</span></td>
                        <td><span className="pp-est">{fmt(listing.propwireEstimate)}</span></td>
                        <td><span className="pp-est">{fmt(listing.realtorEstimate)}</span></td>
                        <td>
                          {listing.url
                            ? <a className="pp-link" href={listing.url} target="_blank" rel="noopener noreferrer" title={listing.url}>
                                {listing.url.length > 36 ? `${listing.url.substring(0, 36)}…` : listing.url}
                              </a>
                            : <span className="pp-na">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Summary */}
              <div className="pp-summary">
                <div className="pp-stat">
                  <div className="pp-stat-label">Total Listings</div>
                  <div className="pp-stat-value">{unifiedListings.length}</div>
                </div>
                <div className="pp-stat">
                  <div className="pp-stat-label">Total Properties</div>
                  <div className="pp-stat-value">{properties.length}</div>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </PageContainer>
  );
};

export default PropertiesPage;
