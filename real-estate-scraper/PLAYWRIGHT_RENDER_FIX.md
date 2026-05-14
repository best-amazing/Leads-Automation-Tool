# Playwright + Render Deployment Fix

## Changes Implemented

### ✅ 1. Removed Hardcoded executablePath
All references to `executablePath: process.env.PLAYWRIGHT_CHROMIUM_PATH || ...` have been removed from:
- `src/utils/browser.ts` - Removed from `createBrowser()` function
- `src/scrapers/crexi/crexi.scraper.ts` - Removed from `launchBrowser()`
- `src/scrapers/facebook/facebook.scraper.ts` - Removed from browser launch
- `src/scrapers/marketplace/marketplace.scraper.ts` - Removed from browser launch

### ✅ 2. Removed Environment Variable from npm Scripts
Updated `package.json` - Removed `PLAYWRIGHT_CHROMIUM_PATH=/usr/bin/chromium-browser` from all npm scripts:
- `scrape`
- `scrape:craigslist`
- `scrape:all`
- `scrape:investorlift`
- `scrape:offmarket`
- `scrape:facebook`
- `scrape:marketplace`
- `scrape:crexi`
- `scrape:creativelisting`
- `scrape:loopnet`
- `scrape:zillow`
- `scrape:realtor`
- `scrape:redfin`
- `scrape:propwire`
- `enrich:zillow`
- `enrich:zillow:dry`
- `test:zillow`
- `test:zillow:debug`
- `test:scraperapi`

### ✅ 3. Removed from Shell Scripts
Updated `scripts/daily-scrape.sh` - Removed the hardcoded path fallback

### ✅ 4. Added Render-Compatible Launch Arguments
Added sandbox-related flags to browser launch configurations:
```javascript
args: [
  "--no-sandbox",
  "--disable-setuid-sandbox",
]
```

These are essential for Render's containerized environment.

---

## Recommended Render Configuration

### Build Command
Set in Render dashboard under **Build Command**:
```bash
npm install && npx playwright install --with-deps chromium
```

This ensures:
- Dependencies are installed
- Playwright downloads Chromium into `/ms-playwright/`
- Browser binaries are available for the runtime environment

### Start Command
Set in Render dashboard under **Start Command**:
```bash
npm start
```

### Environment Variables (Optional)
No special Playwright environment variables are needed. Playwright will automatically:
- Detect its installed Chromium
- Use the browser from `/ms-playwright/`
- Apply headless mode as configured

---

## Why This Works

### The Problem
- Hardcoding `/usr/bin/chromium-browser` assumes Chromium is installed at that system path
- On Render, Chromium doesn't exist at that location
- The deployment would fail trying to launch the browser

### The Solution
- Let **Playwright manage its own Chromium** via `chromium.launch()`
- During build, `npx playwright install --with-deps chromium` downloads Chromium to `/ms-playwright/`
- At runtime, Playwright automatically finds and uses this managed Chromium
- No manual path configuration needed

### Key Benefits
✅ Works locally and on Render without code changes  
✅ Playwright handles browser discovery automatically  
✅ Cleaner, more maintainable code  
✅ Follows Playwright best practices for production  

---

## Verification

To verify the fix locally:

```bash
# Install dependencies and Playwright browsers
npm install && npx playwright install --with-deps chromium

# Try a scraping command
npm run scrape:craigslist

# Or run the server
npm start
```

The application should now work without any executable path errors.

---

## Current Playwright Setup

**Package**: `playwright` (v1.43.1)  
**Browser**: Managed Chromium with stealth plugins  
**Proxy Support**: Configured via `src/utils/browser.ts`  
**Headless**: `true` for production, `false` for UI-based scrapers  

All configurations now follow Playwright's recommended practices for containerized deployments.
