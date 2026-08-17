# Goal Description

The goal is to update the ADU scrapers to:
1. Allow all listing statuses and listing ages (removed non-active status and 30+ days restrictions).
2. Sort listings by newest first so fresh listings are captured daily.
3. Maximize listing intake across InvestorLift, Zillow, Redfin, and Crexi.

## Proposed Changes

### 1. Filter Logic & Criteria
#### [MODIFY] [adu-research.scraper.ts](file:///c:/Users/USER/Work/AB-group/Leads-Automation-Tool/real-estate-scraper/server/src/scrapers/property-purchase-research/adu-research.scraper.ts)
- Removed **Status Check** (pending, contingent, under contract, sold are no longer rejected).
- Removed **Days on Market Check** (properties with less than 30 days on market are now accepted).

### 2. Zillow Sorting
#### [MODIFY] [zillow.scraper.ts](file:///c:/Users/USERR/work/AB_Group/Leads-Automation-Tool/real-estate-scraper/server/src/scrapers/zillow/zillow.scraper.ts)
- In the `buildPageUrl` function, change the Zillow `sortSelection` parameter from `{ value: "days" }` (Newest) to `{ value: "globalrelevanceex" }` (Recommended).
  - *Why this works:* Sorting by "Recommended" ensures Zillow serves a diverse mix of new and old listings across its paginated results. Our scraper will then evaluate this diverse pool and our 30+ days filter will selectively pick out the older listings, ensuring we don't just hit a wall of 0-5 day old properties on the first 5 pages.

## Verification Plan
### Automated Tests
- Run `npm run build` to ensure no TypeScript errors.
### Manual Verification
- Run `npm run scrape:adu-research`.
- **Field Existence Test**: Verify the console output to confirm that all required data fields (including `status`, `daysOnMarket`, `price`, `bedrooms`, etc.) are being successfully extracted and logged, proving we are querying the correct JSON nodes.
- Observe the console logs (which print the fail reason for rejected properties) to ensure that properties with `< 30` days or pending statuses are successfully being rejected based on valid data.
- Verify that the resulting Google Sheet contains only active properties with 30+ days on market, fully populated with the verified data fields.
