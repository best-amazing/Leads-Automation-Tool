import React, { useState } from 'react';
import { Header, PageContainer } from '@/components/layout';
import { FilterForm } from '@/components/filters';
import { useFilter } from '@/hooks';

export const FiltersPage: React.FC = () => {
  const { filter, loading, error, updateFilter } = useFilter();
  const [isSaving, setIsSaving] = useState(false);

  const handleSubmit = async (filterData: any) => {
    setIsSaving(true);
    try {
      await updateFilter(filterData);
    } finally {
      setIsSaving(false);
    }
  };

  const busy = isSaving || loading;

  return (
    <PageContainer>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

        .fp-root {
          --bg:      #0d1117;
          --surface: #161b22;
          --border:  #2a3343;
          --amber:   #f0a500;
          --text:    #e2e8f0;
          --muted:   #64748b;
          --danger:  #f87171;

          background: var(--bg);
          min-height: 100vh;
          font-family: 'Syne', sans-serif;
          color: var(--text);
        }
        .fp-root * { box-sizing: border-box; }

        /* ── Header ── */
        .fp-header {
          padding: 2rem 2.5rem 1.25rem;
          border-bottom: 1px solid var(--border);
        }
        .fp-eyebrow {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.65rem;
          letter-spacing: 0.2em;
          text-transform: uppercase;
          color: var(--amber);
          margin-bottom: 0.35rem;
        }
        .fp-title {
          font-size: 1.75rem;
          font-weight: 800;
          letter-spacing: -0.02em;
          margin: 0;
          line-height: 1;
        }
        .fp-sub {
          font-size: 0.8rem;
          color: var(--muted);
          margin-top: 0.35rem;
          font-weight: 400;
        }

        /* ── Body ── */
        .fp-body {
          padding: 2rem 2.5rem;
          max-width: 760px;
        }

        /* ── Status bar ── */
        .fp-statusbar {
          display: flex;
          align-items: center;
          gap: 0.6rem;
          margin-bottom: 1.5rem;
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.68rem;
        }
        .fp-status-dot {
          width: 0.5rem; height: 0.5rem;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .fp-status-dot.active  { background: #4ade80; box-shadow: 0 0 6px #4ade8080; }
        .fp-status-dot.loading { background: var(--amber); animation: fp-pulse 1.2s ease-in-out infinite; }
        @keyframes fp-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        .fp-status-text { color: var(--muted); }

        /* ── Error ── */
        .fp-error {
          background: rgba(248,113,113,0.08);
          border: 1px solid rgba(248,113,113,0.3);
          color: var(--danger);
          border-radius: 8px;
          padding: 0.85rem 1.1rem;
          font-size: 0.82rem;
          margin-bottom: 1.5rem;
          display: flex;
          gap: 0.6rem;
          align-items: flex-start;
        }

        /* ── Form card ── */
        .fp-card {
          background: var(--surface);
          border: 1px solid var(--border);
          border-radius: 10px;
          overflow: hidden;
        }

        /* Card header strip */
        .fp-card-header {
          padding: 1rem 1.5rem;
          border-bottom: 1px solid var(--border);
          display: flex;
          align-items: center;
          justify-content: space-between;
        }
        .fp-card-title {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.65rem;
          letter-spacing: 0.15em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .fp-card-badge {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.6rem;
          padding: 0.2rem 0.55rem;
          border-radius: 4px;
          background: rgba(240,165,0,0.12);
          border: 1px solid rgba(240,165,0,0.3);
          color: var(--amber);
          letter-spacing: 0.05em;
        }

        /* Card body — form lives here */
        .fp-card-body {
          padding: 1.5rem;
        }

        /* ── Saving overlay indicator ── */
        .fp-saving-bar {
          height: 2px;
          background: linear-gradient(90deg, var(--amber), transparent);
          background-size: 200% 100%;
          animation: fp-bar 1.2s linear infinite;
        }
        @keyframes fp-bar { 0%{background-position:100%} 100%{background-position:-100%} }
      `}</style>

      <div className="fp-root">
        {/* Header */}
        <div className="fp-header">
          <div className="fp-eyebrow">Configuration</div>
          <h1 className="fp-title">Filters</h1>
          <p className="fp-sub">Configure your active search filter</p>
        </div>

        <div className="fp-body">
          {/* Status bar */}
          <div className="fp-statusbar">
            <span className={`fp-status-dot ${busy ? 'loading' : 'active'}`} />
            <span className="fp-status-text">
              {busy ? 'Saving changes…' : 'Filter active'}
            </span>
          </div>

          {/* Error */}
          {error && (
            <div className="fp-error">
              <span>⚠</span>
              <span>Error: {error.message}</span>
            </div>
          )}

          {/* Form card */}
          <div className="fp-card">
            {busy && <div className="fp-saving-bar" />}
            <div className="fp-card-header">
              <span className="fp-card-title">Search Parameters</span>
              <span className="fp-card-badge">Active</span>
            </div>
            <div className="fp-card-body">
              <FilterForm
                initialFilter={filter}
                onSubmit={handleSubmit}
                loading={busy}
              />
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  );
};
