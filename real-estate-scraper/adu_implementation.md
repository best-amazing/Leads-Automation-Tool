# Goal Description

The goal is to update the ADU scrapers to:
1. Ensure only "Active" listings are collected, explicitly rejecting Contingent, Pending, or Under Contract statuses.
2. Target older listings (30+ days on market) to increase diversity instead of only scraping newly listed properties.
3. Validate the existence of all scraped fields to ensure robust data collection.

## User Review Required
Please review the finalized proposed changes below. Once approved, I will begin execution.

## Proposed Changes

### 1. Filter Logic & Data Validation
#### [MODIFY] [adu-research.scraper.ts](file:///c:/Users/USERR/work/AB_Group/Leads-Automation-Tool/real-estate-scraper/server/src/scrapers/property-purchase-research/adu-research.scraper.ts)
- Update the `passesPropertyCriteria` function to add two new strict rules:
  - **Status Check**: If the `status` field contains "pending", "contingent", "under contract", or "sold" (case-insensitive), reject the listing.
  - **Days on Market Check**: If the `daysOnMarket` field is less than 30, reject the listing.
- **Comprehensive Data Validation Test**: Before applying filters or saving, the script will execute a validation pass on the extracted data (`status`, `daysOnMarket`, `price`, `bedrooms`, `bathrooms`, `squareFeet`, `yearBuilt`, `lotSqft`, etc.). If a significant number of properties are returning `undefined` for these fields from either Zillow or InvestorLift, the script will log prominent warnings to alert us that the upstream data shape might have changed or we are extracting the wrong fields.

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
