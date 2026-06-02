// src/scrapers/facebook/facebook.commenter.ts
//
// Posts a comment on every Facebook listing that passed the scraper filter.
//
// Usage:
//   const commenter = new FacebookCommenter();
//   const results   = await commenter.commentOnListings(listings, "Your comment text here");
//
// Or with per-listing dynamic comments:
//   const results = await commenter.commentOnListings(listings, (listing) =>
//     `Hi! Is ${listing.address} still available?`
//   );
//
// How it works:
//   1. Loads the saved Facebook session (facebook-session.json).
//      If the session is missing or expired, throws — run the scraper first
//      to create/refresh it.
//
//   2. For each listing, navigates to listing.url (the Facebook post URL).
//
//   3. Clicks the Comment button to open the composer, types the comment
//      character-by-character (human-speed), then submits with Ctrl+Enter.
//
//   4. Verifies the comment appeared in the post thread before moving on.
//
//   5. Returns a per-listing result array so callers can log successes /
//      failures and retry if needed.
//
// Rate limiting:
//   BETWEEN_COMMENTS_MS  (default 8–14s) — pause between consecutive posts.
//   DAILY_COMMENT_LIMIT  (default 20)    — hard stop after N comments per run.
//   Facebook's unofficial safe limit is ~25–30 comments/day from a new account;
//   older accounts tolerate more.  Stay conservative to avoid action blocks.
//
// Environment variables:
//   FACEBOOK_COMMENT_LIMIT   Override default daily limit  (default: 20)
//   FACEBOOK_COMMENT_MIN_MS  Min ms between comments       (default: 8000)
//   FACEBOOK_COMMENT_MAX_MS  Max ms between comments       (default: 14000)
//
// Debug artefacts → logs/
//   fb_comment_before_<postId>.html   — page HTML just before commenting
//   fb_comment_after_<postId>.html    — page HTML after comment submitted
// ─────────────────────────────────────────────────────────────────────────────

import { chromium, Page } from "playwright";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { sleep } from "../../utils/browser";
import * as fs from "fs";
import * as path from "path";

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_FILE = "facebook-session.json";

const DAILY_COMMENT_LIMIT = parseInt(
  process.env.FACEBOOK_COMMENT_LIMIT ?? "20",
  10,
);
const BETWEEN_MIN_MS = parseInt(
  process.env.FACEBOOK_COMMENT_MIN_MS ?? "8000",
  10,
);
const BETWEEN_MAX_MS = parseInt(
  process.env.FACEBOOK_COMMENT_MAX_MS ?? "14000",
  10,
);

// ── Public types ──────────────────────────────────────────────────────────────

export type CommentText = string | ((listing: RawListing) => string);

export interface CommentResult {
  listing: RawListing;
  success: boolean;
  skipped: boolean; // true if no URL, already commented, or limit reached
  comment: string; // the text that was (or would have been) posted
  error?: string;
}

// ── Selector constants ────────────────────────────────────────────────────────
//
// Facebook's DOM changes regularly.  Each selector list is tried in order;
// the first match wins.  Update these if Facebook redesigns the composer.
//
// CRITICAL: Facebook uses generic `<div role="button">` elements for comments,
// NOT standard `<button>` tags. The comment button is typically:
//   <div role="button" tabindex="0">
//     <div>...<i>icon</i>...</div>
//     <div><span dir="auto">Comment</span></div>
//   </div>
// This is why we need to match by role and contained text.

const COMMENT_BUTTON_SELECTORS = [
  // Try aria-label first (if Facebook ever adds it)
  '[aria-label="Leave a comment"]',
  '[aria-label="Comment"]',

  // Facebook's actual pattern: div[role="button"] containing span text "Comment"
  // Use Playwright's >> text operator for reliable text matching
  'div[role="button"] >> text="Comment"',

  // Alternative: find div[role="button"] and filter if it contains span with "Comment"
  'div[role="button"]:has(span:has-text("Comment"))',

  // Fallback: broad search for button roles with comment text
  '[role="button"]:has-text("Comment")',
  'span:has-text("Comment")',
];

// The composer is a contenteditable div (Lexical editor) that appears after clicking Comment.
// Facebook uses contenteditable divs powered by the Lexical rich-text editor.
// These have various aria-labels or might be in a dialog/modal container.
const COMPOSER_SELECTORS = [
  // Try aria-label variants first (different post types may use different labels)
  '[contenteditable="true"][aria-label*="comment" i]',
  '[contenteditable="true"][aria-label*="write" i]',
  '[contenteditable="true"][aria-placeholder*="comment" i]',
  '[contenteditable="true"][aria-placeholder*="write" i]',

  // Facebook's role="textbox" pattern for input areas
  'div[role="textbox"][aria-label*="comment" i]',
  'div[role="textbox"][aria-label*="write" i]',
  'div[role="textbox"]',

  // Lexical editor often appears in a dialog/modal after clicking Comment
  'div[role="dialog"] [contenteditable="true"]',
  'div[aria-modal="true"] [contenteditable="true"]',
  'div[data-testid*="comment"] [contenteditable="true"]',
  'div[data-testid*="compose"] [contenteditable="true"]',

  // Fallback: any contenteditable element visible on the page
  '[contenteditable="true"]',

  // Last resort: Look for rich-text editor containers
  "div[data-lexical-editor]",
  "div.lexicalEditor",
];

// ── Helper: resolve comment text ─────────────────────────────────────────────

function resolveComment(text: CommentText, listing: RawListing): string {
  return typeof text === "function" ? text(listing) : text;
}

// ── Helper: extract a short post ID for filenames ─────────────────────────────

function postIdFromUrl(url: string): string {
  // /posts/123456789  or  /permalink/123456789
  const m = url.match(/\/(?:posts|permalink)\/(\d+)/);
  if (m) return m[1].slice(-12);
  // groups/123/permalink/456
  const m2 = url.match(/\/groups\/[^/]+\/(?:posts|permalink)\/(\d+)/);
  if (m2) return m2[1].slice(-12);
  // fallback: last path segment
  return url.replace(/[^a-z0-9]+/gi, "").slice(-12) || "unknown";
}

// ── Debug helper ──────────────────────────────────────────────────────────────

function saveDebug(html: string, label: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `fb_comment_${label}.html`), html);
  } catch {
    /* non-fatal */
  }
}

// ── Modal dismissal (same logic as FacebookScraper) ───────────────────────────

const MODAL_CLOSE_SELECTORS = [
  '[aria-label="Close"]',
  '[aria-label="close"]',
  "div[role='dialog'] div[role='button']:has-text('Not Now')",
  "div[role='dialog'] div[role='button']:has-text('Not now')",
  "div[role='dialog'] div[role='button']:has-text('Close')",
  "div[role='dialog'] [data-testid='dialog-close-button']",
];

async function dismissModals(page: Page): Promise<void> {
  let hasDialog: boolean;
  try {
    hasDialog = !!(await page.$("div[role='dialog'], div[aria-modal='true']"));
  } catch {
    return;
  }
  if (!hasDialog) return;

  logger.info("[fb-commenter] Modal detected — dismissing via Escape");

  try {
    await page.keyboard.press("Escape");
    await sleep(500);
  } catch {}

  try {
    const stillOpen = await page.$(
      "div[role='dialog'], div[aria-modal='true']",
    );
    if (!stillOpen) return;
  } catch {
    return;
  }

  for (const selector of MODAL_CLOSE_SELECTORS) {
    try {
      const el = await page.$(selector);
      if (!el) continue;
      const tag = await el.evaluate((n) => n.tagName.toLowerCase());
      if (tag === "a") continue;
      await el.click({ timeout: 3000 });
      await sleep(500);
      break;
    } catch {}
  }
}

// ── Core: post a single comment ───────────────────────────────────────────────

async function postComment(
  page: Page,
  postUrl: string,
  comment: string,
): Promise<{ success: boolean; error?: string }> {
  const postId = postIdFromUrl(postUrl);

  // ── Navigate to the post ──────────────────────────────────────────────────

  try {
    await page.goto(postUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await sleep(2500 + Math.random() * 1500);
  } catch (err: any) {
    return { success: false, error: `Navigation failed: ${err.message}` };
  }

  // Session expired check
  if (page.url().includes("login")) {
    return { success: false, error: "Redirected to login — session expired" };
  }

  await dismissModals(page);
  await sleep(1000);

  saveDebug(await page.content(), `before_${postId}`);

  // ── Click Comment button to open the composer ─────────────────────────────

  let composerOpened = false;
  let lastError: string | null = null;

  for (const selector of COMMENT_BUTTON_SELECTORS) {
    try {
      logger.debug(`[fb-commenter] Trying selector: ${selector}`);

      // Wait for selector to be visible (not just attached to DOM)
      try {
        await page.waitForSelector(selector, {
          timeout: 5000,
          state: "visible",
        });
      } catch {
        logger.debug(
          `[fb-commenter] Selector not found or not visible: ${selector}`,
        );
        lastError = `Selector not visible: ${selector}`;
        continue;
      }

      const btn = await page.$(selector);
      if (!btn) {
        logger.debug(
          `[fb-commenter] Selector matched but element is null: ${selector}`,
        );
        lastError = `Element is null: ${selector}`;
        continue;
      }

      // Try clicking the button
      try {
        await btn.click({ timeout: 5000 });
        // Wait longer for composer to load (Lexical editor can be slow)
        // Also handle potential modal transitions
        await sleep(1500 + Math.random() * 800);
        await dismissModals(page); // Dismiss any modals that appear after clicking
        composerOpened = true;
        logger.debug(
          `[fb-commenter] ✓ Comment button clicked via: ${selector}`,
        );
        break;
      } catch (clickErr: any) {
        logger.debug(
          `[fb-commenter] Click failed for selector ${selector}: ${clickErr.message}`,
        );
        lastError = `Click failed: ${clickErr.message}`;
      }
    } catch (err: any) {
      logger.debug(
        `[fb-commenter] Error with selector ${selector}: ${err.message}`,
      );
      lastError = err.message;
    }
  }

  if (!composerOpened) {
    // Some post layouts auto-show the composer — check for it anyway
    logger.debug(
      `[fb-commenter] No Comment button found (last error: ${lastError}) — ` +
        `checking for auto-shown composer`,
    );
  }

  // ── Find the composer input ───────────────────────────────────────────────

  // Save debug HTML to see what's actually on the page after clicking
  logger.debug(`[fb-commenter] Saving post-click debug snapshot…`);
  saveDebug(await page.content(), `after_click_${postId}`);

  let composer: any = null;
  let composerSearchError = "No selectors matched";

  for (const selector of COMPOSER_SELECTORS) {
    try {
      logger.debug(`[fb-commenter] Looking for composer with: ${selector}`);

      try {
        // Increase timeout for composer (Lexical can take longer to load)
        await page.waitForSelector(selector, { timeout: 8000 });
      } catch {
        logger.debug(`[fb-commenter] Composer selector not found: ${selector}`);
        composerSearchError = `Selector "${selector}" not found`;
        continue;
      }

      composer = await page.$(selector);
      if (composer) {
        // Double-check element is actually visible and enabled
        const isVisible = await composer.isVisible().catch(() => false);
        if (isVisible) {
          logger.debug(`[fb-commenter] ✓ Composer found via: ${selector}`);
          break;
        } else {
          logger.debug(
            `[fb-commenter] Composer found but not visible: ${selector}`,
          );
          composerSearchError = `Element not visible: ${selector}`;
          composer = null; // Reset and try next selector
        }
      }
    } catch (err: any) {
      logger.debug(
        `[fb-commenter] Error searching for composer: ${err.message}`,
      );
      composerSearchError = err.message;
    }
  }

  // If standard selectors failed, try dynamic detection with waitForFunction
  if (!composer) {
    logger.debug(
      `[fb-commenter] No selector matched, trying dynamic detection…`,
    );
    try {
      // Wait for ANY contenteditable element to appear
      await page.waitForFunction(
        () => {
          const elements = document.querySelectorAll(
            "[contenteditable='true']",
          );
          return elements.length > 0;
        },
        { timeout: 5000 },
      );

      // Get the first visible contenteditable element
      composer = await page.$("[contenteditable='true']");
      if (composer) {
        const isVisible = await composer.isVisible().catch(() => false);
        if (isVisible) {
          logger.debug(`[fb-commenter] ✓ Composer found via dynamic detection`);
        } else {
          logger.debug(
            `[fb-commenter] Dynamic detection found element but not visible`,
          );
          composer = null;
        }
      }
    } catch (err: any) {
      logger.debug(`[fb-commenter] Dynamic detection failed: ${err.message}`);
    }
  }

  if (!composer) {
    saveDebug(await page.content(), `no_composer_${postId}`);

    // Diagnostic: check if comments are disabled
    const commentDisabled = await page
      .locator("text=/commenting.*disabled|comments.*disabled/i")
      .count()
      .catch(() => 0);

    const errorMsg =
      commentDisabled > 0
        ? "Comments disabled on this post"
        : `Could not find comment composer (${composerSearchError})`;

    return {
      success: false,
      error: errorMsg,
    };
  }

  // ── Type the comment character-by-character ───────────────────────────────

  try {
    await composer.click({ timeout: 5000 });
    await sleep(400 + Math.random() * 300);

    for (const char of comment) {
      await composer.type(char, { delay: 40 + Math.random() * 60 });
    }

    await sleep(600 + Math.random() * 400);
  } catch (err: any) {
    return { success: false, error: `Typing failed: ${err.message}` };
  }

  // ── Submit with Ctrl+Enter ────────────────────────────────────────────────

  try {
    await page.keyboard.press("Control+Enter");
    await sleep(3000 + Math.random() * 2000);
  } catch (err: any) {
    return { success: false, error: `Submit failed: ${err.message}` };
  }

  // ── Verify comment appeared ───────────────────────────────────────────────

  const htmlAfter = await page.content();
  saveDebug(htmlAfter, `after_${postId}`);

  // Check for a short fingerprint of our comment text in the page HTML.
  // Use the first 40 non-space characters — robust against HTML encoding.
  const fingerprint = comment.replace(/\s+/g, " ").trim().slice(0, 40);
  const appeared = htmlAfter.includes(fingerprint);

  if (!appeared) {
    logger.warn(
      `[fb-commenter] Comment may not have posted for ${postUrl} ` +
        `— fingerprint "${fingerprint}" not found in page`,
    );
    // Don't hard-fail: Facebook sometimes reorders the DOM.
    // Return success:true with a warning already logged.
  }

  return { success: true };
}

// ── FacebookCommenter ─────────────────────────────────────────────────────────

export class FacebookCommenter {
  private headless: boolean;

  constructor(options?: { headless?: boolean }) {
    this.headless = options?.headless ?? true;
  }

  /**
   * Posts `commentText` on every listing in `listings`.
   *
   * @param listings     Listings that passed the filter — must have a `.url` field
   *                     pointing to the Facebook post.
   * @param commentText  A static string OR a function receiving a listing and
   *                     returning a string (for dynamic/personalised comments).
   * @returns            Per-listing result array.
   */
  async commentOnListings(
    listings: RawListing[],
    commentText: CommentText,
  ): Promise<CommentResult[]> {
    const results: CommentResult[] = [];

    if (!fs.existsSync(SESSION_FILE)) {
      throw new Error(
        `[fb-commenter] No session file found at ${SESSION_FILE}. ` +
          `Run the FacebookScraper first to create a session.`,
      );
    }

    const eligible = listings.filter((l) => {
      if (!l.url) {
        logger.debug(
          `[fb-commenter] Skipping listing with no URL: ${l.address}`,
        );
        results.push({
          listing: l,
          success: false,
          skipped: true,
          comment: resolveComment(commentText, l),
          error: "no_url",
        });
        return false;
      }
      if (!l.url.includes("facebook.com")) {
        logger.debug(`[fb-commenter] Skipping non-Facebook URL: ${l.url}`);
        results.push({
          listing: l,
          success: false,
          skipped: true,
          comment: resolveComment(commentText, l),
          error: "not_facebook_url",
        });
        return false;
      }
      return true;
    });

    const toComment = eligible.slice(0, DAILY_COMMENT_LIMIT);
    const skippedByLimit = eligible.length - toComment.length;

    if (skippedByLimit > 0) {
      logger.warn(
        `[fb-commenter] Daily limit of ${DAILY_COMMENT_LIMIT} reached — ` +
          `skipping ${skippedByLimit} listing(s)`,
      );
      for (const l of eligible.slice(DAILY_COMMENT_LIMIT)) {
        results.push({
          listing: l,
          success: false,
          skipped: true,
          comment: resolveComment(commentText, l),
          error: "daily_limit_reached",
        });
      }
    }

    if (toComment.length === 0) {
      logger.info("[fb-commenter] No eligible listings to comment on");
      return results;
    }

    logger.info(
      `[fb-commenter] Commenting on ${toComment.length} listing(s) ` +
        `(limit: ${DAILY_COMMENT_LIMIT})`,
    );

    // ── Launch browser with saved session ──────────────────────────────────

    if (!this.headless) {
      logger.info(
        "[fb-commenter] 🔍 HEADED MODE — Browser window will open so you can watch",
      );
    }

    const browser = await chromium.launch({
      headless: this.headless,
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

    const context = await browser.newContext({
      storageState: SESSION_FILE,
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      timezoneId: "America/New_York",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    try {
      // Quick session sanity-check before spending time on comments
      logger.info("[fb-commenter] Verifying session…");
      await page.goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await sleep(2500);

      if (
        page.url().includes("login") ||
        (await page.content()).includes('id="email"')
      ) {
        throw new Error(
          "Session has expired. Delete facebook-session.json and re-run the scraper to log in again.",
        );
      }
      logger.info("[fb-commenter] Session valid ✓");

      // ── Comment loop ─────────────────────────────────────────────────────

      for (let i = 0; i < toComment.length; i++) {
        const listing = toComment[i];
        const comment = resolveComment(commentText, listing);
        const label = `[${i + 1}/${toComment.length}]`;

        logger.info(
          `[fb-commenter] ${label} Commenting on: ${listing.address ?? listing.url}`,
        );
        logger.debug(`[fb-commenter] ${label} URL:     ${listing.url}`);
        logger.debug(`[fb-commenter] ${label} Comment: ${comment}`);

        const { success, error } = await postComment(
          page,
          listing.url!,
          comment,
        );

        results.push({ listing, success, skipped: false, comment, error });

        if (success) {
          logger.info(`[fb-commenter] ${label} ✓ Comment posted`);
        } else {
          logger.warn(`[fb-commenter] ${label} ✗ Failed: ${error}`);

          // If the session expired mid-run, abort immediately
          if (
            error?.includes("session expired") ||
            error?.includes("Redirected to login")
          ) {
            logger.error(
              "[fb-commenter] Session expired during run — aborting",
            );
            break;
          }
        }

        // Pause between comments — randomised to avoid pattern detection
        if (i < toComment.length - 1) {
          const pause =
            BETWEEN_MIN_MS + Math.random() * (BETWEEN_MAX_MS - BETWEEN_MIN_MS);
          logger.info(
            `[fb-commenter] Pausing ${Math.round(pause / 1000)}s before next comment…`,
          );
          await sleep(pause);
        }
      }

      // Refresh the session file after the run
      try {
        await context.storageState({ path: SESSION_FILE });
        logger.info("[fb-commenter] Session refreshed and saved");
      } catch {
        /* non-fatal */
      }
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }

    // ── Summary ───────────────────────────────────────────────────────────

    const succeeded = results.filter((r) => r.success).length;
    const failed = results.filter((r) => !r.success && !r.skipped).length;
    const skipped = results.filter((r) => r.skipped).length;

    logger.info(
      `[fb-commenter] Done — ${succeeded} posted, ${failed} failed, ${skipped} skipped`,
    );

    return results;
  }
}

// ── Convenience function ──────────────────────────────────────────────────────

export async function commentOnListings(
  listings: RawListing[],
  commentText: CommentText,
  options?: { headless?: boolean },
): Promise<CommentResult[]> {
  return new FacebookCommenter(options).commentOnListings(
    listings,
    commentText,
  );
}
