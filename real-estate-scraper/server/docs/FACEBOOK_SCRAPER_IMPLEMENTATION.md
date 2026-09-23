# Facebook Scraper Implementation - Current (June 2026)

## Overview

The Facebook Scraper (`FacebookScraper`) is a specialized web scraper that extracts real estate listings from Facebook groups. It extends the `BaseScraper` class but launches its own dedicated Chromium browser instance (bypassing the proxy-managed browser pool). It implements a multi-step process: authentication, session management, group navigation, feed scrolling, content parsing, and deduplication.

**Key Files:**

- `server/src/scrapers/facebook/facebook.scraper.ts` - Scraper logic (450 lines)
- `server/src/scrapers/facebook/facebook.parser.ts` - HTML parsing & listing extraction (450 lines)

---

## Architecture & Design

### Class Structure

```typescript
export class FacebookScraper extends BaseScraper {
  readonly sourceName = "facebook";
  // ... implementation
}
```

The `FacebookScraper` extends `BaseScraper`, but:

- **Does NOT use inherited browser handle** — launches own Chromium instance via direct `chromium.launch()`
- **Bypasses proxy layer** — connects directly (Facebook blocks proxies reliably)
- **Single-page operation** — only `scrapePage(handle, 1)` returns results; other pages return `[]`
- Implements dedicated authentication flow with session persistence
- Inherits filtering logic from `BaseScraper` for price/location validation

### Configuration

**Environment Variables Required:**

```env
FACEBOOK_USERNAME=<your-email@example.com>
FACEBOOK_PASSWORD=<your-password>
FACEBOOK_GROUP_URLS=<comma-separated group URLs on ONE LINE>
```

**Session Persistence:**

- Session file: `facebook-session.json` (root directory)
- Stores browser context state (cookies, localStorage) via Playwright's `storageState()`
- Survives across scraper runs (persistent login)
- Automatically deleted and regenerated if session expires
- Expires when Facebook invalidates the underlying cookies (weeks to months)

---

## Core Methods

### 1. Constructor

```typescript
constructor(options: ScraperOptions = {}) {
  super(options);
  // Validates environment variables and parses group URLs
}
```

**Features:**

- Validates `FACEBOOK_USERNAME` and `FACEBOOK_PASSWORD` are set
- Parses and normalizes group URLs from `FACEBOOK_GROUP_URLS`
- Handles multiple URL formats:
  - Full URLs: `https://www.facebook.com/groups/123/`
  - Relative paths: `/groups/123/`
  - Normalizes `web.facebook.com` → `www.facebook.com` (for cookie scope)
  - Deduplicates URLs
- Logs number of target groups on initialization

**URL Parsing:**

```typescript
function parseFacebookGroupUrls(raw: string): string[] {
  return raw
    .split(/[\s,]+/) // split on whitespace or comma
    .map((u) => u.trim().replace(/[`"']/g, ""))
    .filter((u) => u.length > 0)
    .map((u) => {
      if (/^https?:\/\//i.test(u)) {
        return u.replace(
          /^https?:\/\/web\.facebook\.com/i,
          "https://www.facebook.com",
        );
      }
      if (u.startsWith("/")) return `https://www.facebook.com${u}`;
      return `https://www.facebook.com/${u}`;
    })
    .filter((url, index, all) => all.indexOf(url) === index); // deduplicate
}
```

---

## Session Management

### Session File Location

- **Path:** `facebook-session.json` (root of server directory)
- **Format:** Playwright browser context storage state (JSON)

### Session Lifecycle

**First Run:**

```
Start → No session file → Login with credentials → Save session to file
```

**Subsequent Runs:**

```
Start → Load session from file → Verify on homepage
         ↓
    Still valid?
    ├─ YES: Use loaded session, proceed to groups
    └─ NO: Delete stale file → Login fresh → Save new session
```

### Key Methods

#### `sessionExists(): boolean`

Checks if session file exists at `facebook-session.json`

#### `verifySession(page): Promise<boolean>`

- Navigates to Facebook homepage
- Checks if redirected to login page
- Returns `true` if logged in, `false` if session expired
- Used to determine whether to reuse saved session

---

## Authentication Flow

### `login(page: Page): Promise<boolean>`

**Steps:**

1. **Navigate to Facebook Homepage**
   - URL: `https://www.facebook.com/`
   - Wait condition: `domcontentloaded`
   - Timeout: 60 seconds
   - Post-load wait: 2.5-4.0 seconds

2. **Dismiss Cookie Consent Banner**
   - Tries selectors in order:
     - `[data-cookiebanner="accept_button"]`
     - `button[title="Accept All"]`
     - `button[title="Allow all cookies"]`
     - `[aria-label="Allow all cookies"]`
     - `button:has-text('Accept All')`
     - `button:has-text('Allow essential and optional cookies')`
     - `button:has-text('Allow essential')`
   - Waits 2 seconds after clicking

3. **Wait for Email Input**
   - Waits for email field to be available
   - Timeout: 20 seconds

4. **Fill Email/Username**
   - Tries selectors in order:
     - `#email`
     - `input[name="email"]`
     - `input[type="email"]`
     - `input[autocomplete="username"]`
   - Uses `.fill()` method
   - Randomized delay: 600-1100ms

5. **Fill Password**
   - Tries selectors in order:
     - `#pass`
     - `input[name="pass"]`
     - `input[type="password"]`
   - First clears field with `.fill("")`
   - Then types character-by-character with random delays
   - Per-character delay: 75-150ms
   - Mimics human typing to evade bot detection
   - Total password entry delay: 800-1300ms

6. **Submit Login**
   - Presses Enter key on password field
   - Waits for navigation (up to 30s)
   - Waits additional 3.5-5.5 seconds for page stabilization
   - Saves HTML debug file: `after_login_attempt.html`

7. **Handle 2FA/Checkpoint**
   - Detects indicators:
     - URL contains: `checkpoint` or `two_step_verification`
     - HTML contains: "confirm your identity", "two-factor", "approval code"
   - Saves session for manual intervention
   - Calls `handleTwoFactorOrCheckpoint()`
   - Returns `true` if manual intervention successful, `false` otherwise

8. **Validate Login Success**
   - Checks URL and HTML:
     - If URL contains `login` → login failed
     - If HTML contains "wrong password" → login failed
   - Returns `false` on failure
   - Returns `true` on success
   - Saves session cookies: `facebook-session.json`

**Error Handling:**

- All errors logged with `[facebook]` prefix
- HTML snapshots saved to `logs/facebook_*.html` for debugging
- Returns `false` on any exception (graceful failure)

---

## Group Navigation & Scraping

### `navigateToGroup(page, groupUrl): Promise<boolean>`

**Purpose:** Navigate to a Facebook group and verify the feed is loaded

**Steps:**

1. **Navigate to Group URL**
   - Uses provided `groupUrl`
   - Wait condition: `domcontentloaded`
   - Timeout: 90 seconds
   - Post-load wait: 3 seconds

2. **Dismiss Modals**
   - Calls `dismissModals(page)`
   - Waits 1.5 seconds after dismissal

3. **Check for Login Redirect**
   - Verifies URL doesn't contain "login"
   - Returns `false` if redirected (session invalid for this URL)

4. **Wait for Feed Elements**
   - Tries multiple selectors in order:
     - `[role='feed']` (standard feed role)
     - `[data-pagelet='GroupFeed']` (Facebook group feed)
     - `[data-pagelet='GroupDiscussionFeed']` (discussion version)
     - `[role='article']` (article element)
     - `a[href*='/posts/']` (post links)
     - `a[href*='/permalink/']` (permalink links)
   - Per-selector timeout: 15 seconds
   - First matching selector indicates feed loaded

5. **Debug Output**
   - Saves HTML snapshot: `group_page_no_feed.html` if feed not found
   - Saves HTML snapshot: `group_page_<group_id>.html` if feed found

**Return:**

- `true` if feed loaded successfully
- `false` if feed didn't render or redirected to login

---

### `scrollFeed(page): Promise<void>`

**Purpose:** Lazy-load all posts on the group feed

**Algorithm:**

1. **Initialization**
   - Max scroll passes: 50
   - Scroll distance per pass: 1200px
   - Initial post count: 0
   - Stability threshold: 3 consecutive passes with same count

2. **Scroll Loop**
   - For each pass (0 to 49):
     - Dismiss any open modals
     - Execute scroll: `window.scrollBy(0, 1200)`
     - Wait for content to load:
       - Every 5th pass (4, 9, 14, ...): 4000ms
       - Other passes: 1800-2800ms (random)
     - Count visible post links:
       - Selector: `a[href*='/posts/']` + `a[href*='/permalink/']`
     - Log post count

3. **Stability Detection**
   - If post count same as previous pass:
     - Increment stability counter
     - If counter >= 3: Feed fully loaded, break
   - If post count changed:
     - Reset stability counter to 0

4. **Completion**
   - Scroll back to top: `window.scrollTo(0, 0)`
   - Wait 1.5 seconds for render stabilization

**Why This Works:**

- Facebook lazy-loads posts as user scrolls
- Stable post count = all posts loaded
- Extensive waits avoid "too fast" detection
- Random delays mimic human scrolling

---

### `expandPosts(page): Promise<void>`

**Purpose:** Click "See more" buttons to reveal hidden text in posts

**Implementation:**

1. **Find All "See More" Buttons**
   - Selectors:
     - `[data-ad-rendering-role="story_message"] [role="button"]:has-text("See more")`
     - `[aria-label="See more"]`

2. **Click Buttons**
   - Limits to first 30 buttons (for efficiency)
   - For each button:
     - Dismiss modals first
     - Click with 5-second timeout
     - Wait 250ms before next click
   - Errors are silently ignored (continue to next button)

3. **Error Handling**
   - Entire method wrapped in try-catch
   - No errors logged (graceful degradation)
   - Partial button clicks are OK (some is better than none)

**Why Limited to 30:**

- Time efficiency
- Most important listings appear first
- Avoids excessive interaction detection
- Diminishing returns beyond first 30

---

### `scrapeGroup(page, groupUrl): Promise<RawListing[]>`

**Orchestrates the group scraping flow:**

```
1. Navigate to group
   ↓ (if fails, return [])
2. Scroll feed (lazy-load all posts)
   ↓
3. Expand "See more" buttons (reveal hidden text)
   ↓
4. Dismiss modals (clean up any popups)
   ↓
5. Wait 1 second (let page settle)
   ↓
6. Capture final HTML
   ↓
7. Parse listings from HTML
   ↓
8. Log and return results
```

**Parsing:**

- Uses `parseFacebookGroupPosts(html, groupUrl, "facebook")` parser
- Extracts:
  - Property addresses
  - Prices
  - Descriptions (full text from expanded posts)
  - URLs (for deduplication)
  - Owner/contact info (if available)

**Debug Output:**

- Saves HTML snapshot: `final_<group_id>.html`
- Logs number of listings found

---

## Main Scraping Method

### `scrapePage(handle, pageNumber): Promise<RawListing[]>`

**Key Design:**

- Only runs on page 1 (single-page scraper)
- Returns empty array if `pageNumber !== 1` or no group URLs configured
- Launches dedicated Chromium browser (ignores proxy pool)

**Flow:**

1. **Launch Browser**

   ```typescript
   const browser = await chromium.launch({
     headless: true,
     args: [
       "--no-sandbox",
       "--disable-setuid-sandbox",
       "--disable-dev-shm-usage",
       "--disable-blink-features=AutomationControlled",
       "--disable-infobars",
       "--disable-gpu",
       "--no-zygote",
       "--single-process",
       "--window-size=1440,900",
       "--disable-features=IsolateOrigins",
       "--disable-site-isolation-trials",
     ],
   });
   ```

   - `headless: true` — no UI window
   - `--no-sandbox` — allow container execution
   - `--disable-blink-features=AutomationControlled` — hide automation detection
   - `--window-size=1440,900` — realistic window dimensions

2. **Load or Create Session**

   ```
   Session file exists?
   ├─ YES: Load cookies from file → Verify session is valid
   │       ├─ Still valid: Use existing session
   │       └─ Expired: Delete file → Perform fresh login
   └─ NO: Perform fresh login
   ```

   - Context created with viewport: 1366x900
   - User-agent: Chrome 124.0.0.0 on Windows 10
   - Locale: en-US, Timezone: America/New_York

3. **Iterate Through All Groups**
   - For each group URL:
     - Log: `Group N/M: <url>`
     - Call `scrapeGroup(page, groupUrl)`
     - Accumulate listings
     - Log running total
     - Error handling: log error, continue to next group
     - Between-group pause: 5-9 seconds (random)

4. **Save Updated Session**
   - After all groups: `context.storageState({ path: SESSION_FILE })`
   - Ensures next run can reuse this session
   - Errors silently ignored (non-critical)

5. **Deduplicate Across Groups**
   - Calls `deduplicateAcrossGroups(allListings)`
   - Removes duplicate listings found in multiple groups
   - Logs dedup count and final total

6. **Return Results**
   - Only listings that passed deduplication
   - Individual listings logged during iteration
   - Browser and context always closed in `finally` block

**Error Handling:**

- Entire flow wrapped in try-catch
- Errors logged with full message
- Returns empty array on failure
- Browser always closed (finally block)

---

## Deduplication

### `deduplicateAcrossGroups(listings): RawListing[]`

**Purpose:** Remove duplicate listings found across multiple groups

**Algorithm:**

1. Create `Set<string>` to track seen listings
2. Create output array: `deduped: RawListing[] = []`
3. For each listing:
   - Compute stable key: `stableKey(listing.description ?? listing.title ?? "")`
   - If key already in set:
     - Log as duplicate
     - Skip this listing
   - Else:
     - Add key to set
     - Add listing to deduped array
4. Calculate and log dropped count

**Stable Key Function:**

- Normalizes text (from parser's `stableKey()` function)
- Removes punctuation, extra whitespace
- Lowercase comparison
- Same listings posted to multiple groups = same key

**Why This Matters:**

- Same property often cross-posted to 3-5 groups
- Deduplication ensures accurate listing counts
- Improves data quality in database
- Avoids duplicate records and scoring

---

## Utility Methods

### `dismissModals(page): Promise<void>`

**Purpose:** Remove popup dialogs that block content

**Strategy:**

1. **Detect Modal**
   - Check for: `div[role='dialog']` or `div[aria-modal='true']`
   - If no modal found, return

2. **Try Escape Key**
   - Keyboard.press("Escape")
   - Wait 500ms
   - Check if modal still open

3. **Try Close Buttons**
   - If still open, try selectors in order:
     ```typescript
     [
       '[aria-label="Close"]',
       '[aria-label="close"]',
       "div[role='dialog'] div[role='button']:has-text('Not Now')",
       "div[role='dialog'] div[role='button']:has-text('Not now')",
       "div[role='dialog'] div[role='button']:has-text('Close')",
       "div[role='dialog'] [data-testid='dialog-close-button']",
     ];
     ```
   - For each selector:
     - Get element
     - Skip if element not found
     - Get tag name
     - Skip if `<a>` tag (never click links)
     - Click with 3-second timeout
     - Log selector used
     - Wait 500ms
     - Break (stop after first success)

4. **Error Handling**
   - All errors silently ignored
   - Best-effort approach

---

### `handleTwoFactorOrCheckpoint(page): Promise<void>`

**Purpose:** Handle 2FA/checkpoint detection

**Current Implementation:**

- Logs three warning messages:
  1. "2FA / Checkpoint detected in headless mode"
  2. "Automatic 2FA resolution is not available in headless mode"
  3. "Please provide a pre-authenticated session file or run with headless=false for manual intervention"
- Attempts to save partial session for manual intervention
- Errors silently ignored

**Why No Automation:**

- SMS/email OTP requires external service
- CAPTCHA solving would require OCR/API
- Manual intervention is simpler and more reliable

**Manual Workaround:**

1. Delete `facebook-session.json` file
2. Change launcher to `headless: false`
3. Run scraper
4. Complete 2FA manually in browser window
5. Session auto-saves when complete
6. Change back to `headless: true`
7. Next run uses saved session

---

### `saveDebug(html, label): void`

**Purpose:** Save HTML snapshots for debugging

**Files Created:**

- Location: `logs/facebook_<label>.html`
- Creates `logs/` directory if not exists

**Debug Points:**

- `homepage_loaded` - Facebook homepage after load
- `after_login_attempt` - After pressing Enter on login
- `logged_in` - After successful login
- `checkpoint` - If 2FA/checkpoint detected
- `group_page_no_feed` - Group page with no feed rendered
- `group_page_<group_id>` - Group page before scrolling
- `final_<group_id>` - Group page after scrolling (post-final HTML)

**Usage:**

- Download HTML file from logs/
- Open in browser to see exact page state
- Inspect selectors with DevTools
- Helps diagnose parsing failures
- Identifies UI changes by Facebook

---

### `slugify(url): string`

**Purpose:** Convert group URL to filesystem-safe filename

**Implementation:**

```typescript
url
  .replace(/https?:\/\/[^/]+\/groups\//, "") // remove domain
  .replace(/\//g, "") // remove slashes
  .slice(0, 40); // first 40 chars
```

**Example:**

- Input: `https://www.facebook.com/groups/1185152819072240/`
- Output: `1185152819072240` (or shorter if ID is short)

---

## Error Handling & Logging

### Log Levels

**ERROR** (critical failures):

- Could not find email/password inputs
- Login failed
- Navigation failed
- Parsing failed
- Session verify error
- Transport/network errors

**WARN** (recoverable issues):

- Session expired
- Feed didn't render
- 2FA/Checkpoint detected
- Redirected to login during group nav
- Scroll failed
- No response from endpoint

**INFO** (progress):

- Login successful
- Session verified
- Group navigated
- Posts counted
- Listings found
- Dedup stats
- Running totals

**DEBUG** (detailed):

- Step-by-step method execution
- Selector matching
- Button clicking
- Browser operations

### Log Format

All logs prefixed with `[facebook]`:

```
[facebook] Logging in…
[facebook] ✓ Logged in successfully
[facebook] Scraping market: Cleveland, OH
[facebook] ✓ Group feed loaded
```

---

## Performance & Timing

### Typical Execution

| Step                | Time         | Notes                       |
| ------------------- | ------------ | --------------------------- |
| Load homepage       | 2-3s         | Include 2.5-4s wait         |
| Dismiss consent     | 1-2s         | Try multiple selectors      |
| Fill credentials    | 2-3s         | Char-by-char typing         |
| Navigate & redirect | 3-5s         | Include post-login wait     |
| Navigate to group   | 3-5s         | Load + modal dismiss        |
| Scroll feed         | 60-120s      | 50 passes × variable delays |
| Expand posts        | 5-10s        | 30 buttons × 250ms          |
| Parse & dedupe      | 1-2s         | HTML parsing                |
| **Per Group Total** | **~75-150s** | **1.5-2.5 min**             |

### Total Execution Time

- First run: ~40-80 minutes (includes login)
- Subsequent runs: ~30-70 minutes (reuses session)
- Depends on:
  - Number of groups (each: 1.5-2.5 min)
  - Number of posts per group
  - Network speed
  - Server load

---

## Session Persistence

### File Format

```json
{
  "cookies": [
    {
      "name": "c_user",
      "value": "100001234567890",
      "domain": ".facebook.com",
      "path": "/",
      "expires": 9999999999,
      "httpOnly": true,
      "secure": true,
      "sameSite": "None"
    }
  ],
  "origins": [
    {
      "origin": "https://www.facebook.com",
      "localStorage": []
    }
  ]
}
```

### Lifetime

- Cookies expire at high timestamp (9999999999 = year 2286)
- localStorage has no expiration
- Session remains valid until Facebook invalidates cookies
- Typically: weeks to months

---

## Known Limitations & Workarounds

### Limitation 1: 2FA Detection

**Problem:** 2FA detected → can't auto-complete in headless mode

**Workaround:**

- Delete `facebook-session.json`
- Change launcher to `headless: false`
- Run scraper
- Complete 2FA manually in browser window
- Session auto-saves
- Change back to `headless: true`
- Next run uses saved session

### Limitation 2: Rate Limiting

**Problem:** Too many group requests → temporary IP ban

**Workaround:**

- 5-9 second delays between groups (already implemented)
- Random delays in scrolling (already implemented)
- User-agent and browser match real browser (already implemented)

### Limitation 3: Dynamic Content

**Problem:** Some listings rendered after page load via JavaScript

**Workaround:**

- Scroll extensively (50 passes) — triggers lazy loading
- Click "See more" buttons — reveals expanded text
- Wait for stable post counts — indicates loading complete

---

## Debugging Tips

### 1. Check Debug HTML Files

```bash
ls -lh server/logs/facebook_*.html
```

### 2. Force Fresh Login

```bash
rm facebook-session.json
npm run scrape:facebook
```

### 3. Monitor Logs

Check console output for `[facebook]` prefixed logs showing progress

---

## Configuration Examples

### Minimal Setup

```env
FACEBOOK_USERNAME=your-email@gmail.com
FACEBOOK_PASSWORD=your-password
FACEBOOK_GROUP_URLS=https://www.facebook.com/groups/1185152819072240/
```

### Production Setup

```env
FACEBOOK_USERNAME=business-account@company.com
FACEBOOK_PASSWORD=complex-password
FACEBOOK_GROUP_URLS=https://www.facebook.com/groups/group1/,https://www.facebook.com/groups/group2/
```

---

## References

- [Playwright Documentation](https://playwright.dev)
- [Chromium Launch Options](https://github.com/microsoft/playwright/blob/main/packages/playwright-core/src/server/chromium/chromium.ts)
- [Facebook Groups](https://www.facebook.com)
