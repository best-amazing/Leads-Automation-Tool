# ADU Research Scraper — Inventory Backfill & Processing

How the ADU research scraper (`npm run scrape:adu-research`) pulls the **entire
inventory** from InvestorLift, Zillow, and Redfin, and how each source tracks
which listings it has already processed.

Entry point: `server/src/scrapers/property-purchase-research/run-adu-research.ts`
Scrapers:
- InvestorLift → `adu-research.scraper.ts`
- Zillow      → `zillow-adu.scraper.ts` (extends `../zillow/zillow.scraper.ts`)
- Redfin      → `redfin-adu.scraper.ts` (extends `../redfin/redfin.scraper.ts`)

---

## 1. The driver loop — `runContinuous()`

`run-adu-research.ts` runs the three sources **in sequence** (InvestorLift,
then Zillow, then Redfin) and, for each one, loops through batches:

```ts
async function runContinuous(scraper) {
  while (true) {
    const results = await scraper.run();          // one batch / full pass
    const lastAudit = read last record of logs/backfill_audit.json;
    if (lastAudit.source === scraper.sourceName
        && lastAudit.processedCount >= 1000) {
      // batch limit hit → run the next batch immediately
    } else {
      break;  // "backfill complete or reached end of inventory"
    }
  }
}
```

So every source follows the same **3-part contract**:

| Piece | File | Purpose |
|---|---|---|
| **Batch cap** | `BACKFILL_BATCH_SIZE = 1000` | each `run()` stops after ~1000 new listings so a run has a bounded length |
| **Cursor** | `<source>_backfill_cursor.json` in `logs/` | persistent record of every processed listing (so re-runs skip them) |
| **Audit** | `logs/backfill_audit.json` | append `{source, processedCount, ...}` each run — the driver reads this to decide whether to run another batch |

After the last batch, the cursor holds the entire inventory and
`processedCount < 1000`, so the driver logs `backfill complete`.

---

## 2. InvestorLift — time-based cursor, full inventory in one API call

### How the calls are made
- A saved browser session (`investorlift-session.json` / `investor-session.json`,
  or `INVESTORLIFT_SESSION_FILE`) is validated with a headless browser, then the
  marketplace page is loaded once so cookies pass Cloudflare.
- Listings come from a **single paginated API**:
  `GET https://investorlift.com/marketplace/api/customer/api/properties`
  (with session cookies; `per_page` up to 1000). The whole inventory is fetched
  in one go — a typical run pulls **~57,000 listings**.

### How processing guarantees full inventory
1. **Sort by `publishedAt` ascending (oldest first)** — `parsed.sort(...)` in
   `adu-research.scraper.ts:786`.
2. Load the seen **listing-ID** set from `logs/il_backfill_cursor.json`
   (`loadSeenListings`), skip anything already seen.
3. Process new listings oldest → newest. When `processedThisBatch >= 1000`,
   stop, save the cursor, and append an audit record that includes the batch's
   time window:
   ```json
   { "source": "investorlift-adu", "processedCount": 1000,
     "oldestDateInBatch": "2026-07-22 09:12:53",
     "newestDateInBatch": "2026-08-03 13:48:54" }
   ```
4. The driver sees `processedCount >= 1000` and runs the next batch, which
   starts **after** the previous batch's newest date.

Because the source is time-ordered and the cursor is a time pointer, each batch
advances through the calendar until the newest listing is reached — genuine
full-inventory coverage. Audit logs show the dates walking forward (e.g.
`1000 → 1000 → 1000 → 172 → 4 → 20`).

---

## 3. Zillow — URL-based dedup cursor over a shallow snapshot

### How the calls are made
- Search pages are fetched through **Oxylabs** (`source: "universal"`,
  `render: "html"`) and parsed from `__NEXT_DATA__`
  (`zillow.scraper.ts:oxylabsFetch`, `extractNextData`).
- URL builder `buildPageUrl()` sets Zillow's `filterState` (`fsba/fsbo` for
  active, `fore/pf` for off-market), `sortSelection: "days"`, and pagination.
- The ADU variant calls `scrapeMarketPage(market, page, true, false)` —
  **ignores the price filter and the 30-day freshness cutoff** so it sees the
  full served snapshot.
- Detail pages are fetched per-listing (also via Oxylabs) to pull the full text
  description, `yearBuilt`, `units`, `schoolRating`, etc.

### How processing guarantees "full inventory"
1. **Reverse pagination** — pages walk `maxPagesPerMarket → 1` (oldest page
   first), `zillow-adu.scraper.ts:87`.
2. Load the seen **URL** set from `logs/zillow_backfill_cursor.json`
   (`loadSeenListings`, shared with the base Zillow scraper). URLs already
   processed are skipped (`skippedAsSeen++`).
3. Process new URLs; stop at `processedThisBatch >= 1000`, save the cursor,
   append `{source:"zillow-adu", processedCount}` to the audit.
4. Driver re-runs while `processedCount >= 1000`; ends when fewer than 1000 new
   URLs remain.

### The important difference vs InvestorLift
Zillow's search API only serves a **shallow snapshot** (~20 pages ≈ 800–1000
listings per market) — it does **not** allow deep historical pagination and
exposes **no timestamp** to walk. So the cursor is a **dedup filter**, not a
time pointer:
- **Oldest-first** comes from reverse pagination, not the cursor.
- "Skipping old and reaching new" happens because the persistent seen-URL set
  excludes everything already processed; only **newly-listed** URLs (which
  Zillow surfaces on page 1, newest-first) remain to be processed on the next
  run.
- A single run covers the entire ~1000-listing window; across daily runs the
  cursor stops you re-processing anything.

Note: `daysOnZillow` values within a page are not strictly sequential — Zillow
mixes priority/featured listings into pages (values like `0` and even `-1`
appear). Verified with `npm run verify:zillow` (`verify-zillow-ordering.ts`):
cross-page age ordering is correct; within-page ordering is Zillow's own.

---

## 4. Redfin — GIS JSON API, offset pagination (tracker currently incomplete)

### How the calls are made
- Redfin's HTML pages are behind AWS WAF, so the scraper hits the internal
  **GIS JSON API** directly through Oxylabs with **no rendering**
  (`render: false`, a plain HTTP GET — WAF ignores these):
  ```
  GET https://www.redfin.com/stingray/api/gis
      ?region_id=<regionId> &region_type=6
      &uipt=1,4               ← house + multi-family
      &max_price=<max> &status=1
      &num_homes=50           ← page size
      &start=<offset>         ← 0-based pagination
      &ord=time-on-redfin-desc ← oldest first
  ```
- Pagination advances `start += pageSize` until `start >= totalCount`
  (`redfin.scraper.ts:480-487`), so it can walk the full served result set per
  market.
- Phase 2 enriches each accepted listing with a Redfin AVM estimate via the
  stingray `avmHistoricalData` → `belowTheFold` → HTML-fallback chain.
- `RedfinAduScraper` then applies location / criteria / keyword filters and
  streams matches through `onMatch`.

### Full-inventory tracking — ✅ fixed
`RedfinScraper.run()` now follows the same contract as the other sources:
1. Loads the seen-URL set from `logs/redfin_backfill_cursor.json` and skips
   already-processed URLs (`redfin.scraper.ts:461`, `545`).
2. Stops the batch at `BACKFILL_BATCH_SIZE = 1000` (market loop + listing loop).
3. After processing, persists the cursor via `saveSeenListings(allSeenUrls)`
   and appends `{source:"redfin-adu", processedCount}` to the audit log —
   so `runContinuous()` chains batches until offset pagination is exhausted.

The batch walk therefore advances through Redfin's result set: each run marks
up to 1000 URLs as seen, the next run skips them and continues deeper into the
GIS result pages (page offsets keep advancing via `start += pageSize`), until
`start >= totalCount`.

---

## 5. Verifying coverage

- **Audit log** — `logs/backfill_audit.json` shows each source's
  `processedCount` per run. A trailing `processedCount < 1000` + driver log
  `backfill complete or reached end of inventory` = full inventory for that run.
- **Cursor files** — `logs/il_backfill_cursor.json`, `logs/zillow_backfill_cursor.json`,
  `logs/redfin_backfill_cursor.json` (once persisted) grow until they hold the
  whole inventory.
- **Ordering** — `npm run verify:zillow` fetches live pages and checks
  within-page / cross-page age ordering and duplicate zpids.

---

## 6. Deployment notes (Render)

- Cursor + audit files live in `logs/`, which is **ephemeral** on Render — a
  redeploy resets them, so a full re-scan occurs. Google Sheets dedup
  (`google-sheets.ts`) prevents duplicate rows being written on re-scans.
- Long runs need `--max-old-space-size=4096` and a ≥2GB instance.
- Secrets not in git: InvestorLift session, Google service-account key,
  Oxylabs creds — see `render.yaml`.