// src/scrapers/facebook/facebook.commenter.ts

import { chromium, Page } from "playwright";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { sleep } from "../../utils/browser";
import * as fs from "fs";
import * as path from "path";

// ── Constants ─────────────────────────────────────────────────────────────────

const SESSION_FILE = "facebook-session.json";

const DAILY_COMMENT_LIMIT = parseInt(
  process.env.FACEBOOK_COMMENT_LIMIT ?? "8",
  10,
);
const BETWEEN_MIN_MS = parseInt(
  process.env.FACEBOOK_COMMENT_MIN_MS ?? "90000",
  10,
);
const BETWEEN_MAX_MS = parseInt(
  process.env.FACEBOOK_COMMENT_MAX_MS ?? "180000",
  10,
);

// ── Public types ──────────────────────────────────────────────────────────────

export type CommentText = string | ((listing: RawListing) => string);

export interface CommentResult {
  listing: RawListing;
  success: boolean;
  skipped: boolean;
  comment: string;
  error?: string;
}

// ── Comment template pool ─────────────────────────────────────────────────────
//
// Templates are selected randomly per listing. Each one sounds like a genuine
// buyer/investor inquiry — no repeated phrasing patterns across a session.
// Avoid: "wholesale", "investor", price mentions — FB flags these as spam.

const COMMENT_TEMPLATES: Array<(l: RawListing) => string> = [
  (l) => `Hi! Is this still available?`,
  (l) => `Is this property still on the market?`,
  (l) => `Hey, still available? Would love more details!`,
  (l) => `Hi there! Do you have more photos of the inside?`,
  (l) => `Is this still for sale? Interested!`,
  (l) => `Could you DM me more details on this one?`,
  (l) => `Still available? Can we schedule a showing?`,
  (l) => `Interested! What's the best way to reach you?`,
  (l) => `Hi! Any interior photos available?`,
  (l) => `Love this listing — is it still available?`,
  (l) => `Do you have more info on this property?`,
  (l) => `Still on the market? Please DM me!`,
  (l) => `Hi, is this available? I'd love to take a look`,
  (l) => `Any updates on this listing?`,
  (l) => `Interested in this one! Is it still listed?`,
  (l) => `Hi! Can you share more details? Still available?`,
  (l) => `Would love to schedule a viewing if still available!`,
  (l) => `Is the price negotiable? Still interested if so`,
  (l) => `Hi, is this still for sale? Please DM me details`,
  (l) => `Looks great! Is it still available for viewing?`,
];

/**
 * Pick a random comment template and apply it to the listing.
 * If the caller supplied their own CommentText, use that instead.
 */
function resolveComment(
  text: CommentText | "auto",
  listing: RawListing,
): string {
  if (text === "auto") {
    const template =
      COMMENT_TEMPLATES[Math.floor(Math.random() * COMMENT_TEMPLATES.length)];
    return template(listing);
  }
  return typeof text === "function" ? text(listing) : text;
}

// ── Human-behaviour helpers ───────────────────────────────────────────────────

/** Random integer between min and max (inclusive) */
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

/** Random float between min and max */
function randFloat(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

/**
 * Type text character-by-character with human-like speed variation:
 * - Occasional "typo + backspace" corrections
 * - Bursts of fast typing followed by short pauses
 * - Slower speed on punctuation and spaces
 */
async function humanType(
  page: Page,
  composer: any,
  text: string,
): Promise<void> {
  await composer.click({ timeout: 5000 });
  await sleep(randInt(300, 700));

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    // Occasionally make a typo and correct it (5% chance per char, not on last 3)
    if (i < text.length - 3 && Math.random() < 0.05) {
      const typoChars = "abcdefghijklmnopqrstuvwxyz";
      const typo = typoChars[Math.floor(Math.random() * typoChars.length)];
      await composer.type(typo, { delay: randInt(60, 120) });
      await sleep(randInt(150, 400)); // pause — "noticed the mistake"
      await page.keyboard.press("Backspace");
      await sleep(randInt(100, 250));
    }

    // Vary delay by character type
    let delay: number;
    if (char === " ") {
      delay = randInt(80, 180);
    } else if (/[.,!?]/.test(char)) {
      delay = randInt(100, 220);
    } else if (Math.random() < 0.1) {
      delay = randInt(200, 400); // occasional slow keypress
    } else {
      delay = randInt(50, 130);
    }

    await composer.type(char, { delay });

    // Occasional mid-sentence pause (thinking)
    if (char === " " && Math.random() < 0.08) {
      await sleep(randInt(400, 1200));
    }
  }

  // Pause after finishing typing before submitting
  await sleep(randInt(600, 1500));
}

/**
 * Simulate random mouse movement across the page — makes automation
 * harder to detect via mouse-movement fingerprinting.
 */
async function randomMouseWiggle(page: Page): Promise<void> {
  const steps = randInt(2, 5);
  for (let i = 0; i < steps; i++) {
    await page.mouse.move(randFloat(200, 1100), randFloat(200, 700), {
      steps: randInt(5, 15),
    });
    await sleep(randInt(100, 400));
  }
}

/**
 * Random scroll up/down to simulate reading the post before commenting.
 */
async function simulateReading(page: Page): Promise<void> {
  const scrolls = randInt(2, 5);
  for (let i = 0; i < scrolls; i++) {
    const direction = Math.random() < 0.7 ? 1 : -1; // mostly scroll down
    const amount = randInt(200, 600) * direction;
    await page.mouse.wheel(0, amount);
    await sleep(randInt(800, 2500));
  }
}

/**
 * Warm-up: browse Facebook briefly before starting comments so the session
 * doesn't jump straight into posting activity.
 */
async function warmUpSession(page: Page): Promise<void> {
  logger.info("[fb-commenter] Warming up session (browsing feed)…");

  // Visit the news feed and "read" for a bit
  await page.goto("https://www.facebook.com/", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  await sleep(randInt(3000, 6000));
  await simulateReading(page);
  await randomMouseWiggle(page);
  await sleep(randInt(2000, 4000));
}

// ── URL helpers ───────────────────────────────────────────────────────────────

function normalizeUrl(url: string): string {
  return url
    .replace("web.facebook.com", "www.facebook.com")
    .replace(/[?&]__cft__.*$/, "")
    .replace(/[?&]__tn__.*$/, "");
}

function postIdFromUrl(url: string): string {
  const m = url.match(/\/(?:posts|permalink)\/(\d+)/);
  if (m) return m[1].slice(-12);
  const m2 = url.match(/\/groups\/[^/]+\/(?:posts|permalink)\/(\d+)/);
  if (m2) return m2[1].slice(-12);
  return url.replace(/[^a-z0-9]+/gi, "").slice(-12) || "unknown";
}

function saveDebug(html: string, label: string): void {
  try {
    const dir = path.resolve("logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `fb_comment_${label}.html`), html);
  } catch {
    /* non-fatal */
  }
}

// ── Selectors ─────────────────────────────────────────────────────────────────

const COMPOSER_SELECTORS = [
  '[aria-label="Write a comment…"]',
  '[aria-label="Write a comment"]',
  '[aria-label="Leave a comment"]',
  '[aria-label="Add a comment…"]',
  '[contenteditable="true"][aria-label*="comment" i]',
  '[contenteditable="true"][aria-label*="write" i]',
  '[contenteditable="true"][aria-label*="add a" i]',
  '[contenteditable="true"][aria-placeholder*="comment" i]',
  '[contenteditable="true"][aria-placeholder*="write" i]',
  'div[role="textbox"][aria-label*="comment" i]',
  'div[role="textbox"][aria-label*="write" i]',
  'div[role="textbox"]',
  'div[data-lexical-editor="true"]',
  "[data-lexical-editor]",
  '[contenteditable="true"]',
];

const COMMENT_BUTTON_SELECTORS = [
  '[aria-label="Leave a comment"]',
  '[aria-label="Comment"]',
  'div[role="button"]:has(span:text-is("Comment"))',
  'a:has(span:text-is("Comment"))',
  'div[role="button"]:has-text("Comment")',
  '[role="button"]:has-text("Comment")',
  'span:text-is("Comment")',
];

const SUBMIT_ARIA_SELECTORS = [
  '[aria-label="Post comment"]',
  '[aria-label="Submit comment"]',
  'div[aria-label="Comment"][role="button"]',
  'div[aria-label="Post"][role="button"]',
  '[aria-label="Post"]',
  'button[type="submit"]',
];

// ── Core: post a single comment ───────────────────────────────────────────────

async function postComment(
  page: Page,
  rawUrl: string,
  comment: string,
): Promise<{ success: boolean; error?: string }> {
  const postUrl = normalizeUrl(rawUrl);
  const postId = postIdFromUrl(postUrl);

  // ── Navigate ──────────────────────────────────────────────────────────────

  try {
    await page.goto(postUrl, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await sleep(randInt(3000, 6000));
  } catch (err: any) {
    return { success: false, error: `Navigation failed: ${err.message}` };
  }

  if (page.url().includes("login")) {
    return { success: false, error: "Redirected to login — session expired" };
  }

  // Simulate reading the post before interacting
  await simulateReading(page);
  await randomMouseWiggle(page);
  await sleep(randInt(1000, 3000));

  saveDebug(await page.content(), `before_${postId}`);

  // ── Check if composer is already visible ──────────────────────────────────

  let composer: any = null;

  for (const sel of COMPOSER_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (!el) continue;
      const visible = await el.isVisible().catch(() => false);
      if (visible) {
        logger.debug(`[fb-commenter] Composer already visible via: ${sel}`);
        composer = el;
        break;
      }
    } catch {}
  }

  // ── Click Comment button if composer not pre-shown ────────────────────────

  if (!composer) {
    let buttonClicked = false;

    for (const selector of COMMENT_BUTTON_SELECTORS) {
      try {
        logger.debug(`[fb-commenter] Trying comment button: ${selector}`);
        const btn = await page.$(selector);
        if (!btn) continue;
        const visible = await btn.isVisible().catch(() => false);
        if (!visible) continue;

        await btn.scrollIntoViewIfNeeded();
        await sleep(randInt(400, 900)); // pause before clicking — human hesitation
        await randomMouseWiggle(page);
        await btn.click({ timeout: 5000 });
        buttonClicked = true;
        logger.debug(
          `[fb-commenter] ✓ Comment button clicked via: ${selector}`,
        );
        await sleep(randInt(1500, 3000));
        break;
      } catch (err: any) {
        logger.debug(
          `[fb-commenter] Button selector failed (${selector}): ${err.message}`,
        );
      }
    }

    if (!buttonClicked) {
      logger.debug(
        "[fb-commenter] No comment button clicked — checking for composer anyway",
      );
    }

    saveDebug(await page.content(), `after_click_${postId}`);

    // Find composer after clicking
    for (const sel of COMPOSER_SELECTORS) {
      try {
        await page.waitForSelector(sel, { timeout: 6000, state: "visible" });
        const el = await page.$(sel);
        if (!el) continue;
        const visible = await el.isVisible().catch(() => false);
        if (visible) {
          logger.debug(`[fb-commenter] ✓ Composer found via: ${sel}`);
          composer = el;
          break;
        }
      } catch {}
    }

    // Last resort: dynamic detection
    if (!composer) {
      try {
        await page.waitForFunction(
          () =>
            Array.from(
              document.querySelectorAll("[contenteditable='true']"),
            ).some((el) => (el as HTMLElement).offsetParent !== null),
          { timeout: 6000 },
        );
        const els = await page.$$("[contenteditable='true']");
        for (const el of els) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) {
            composer = el;
            break;
          }
        }
      } catch (err: any) {
        logger.debug(`[fb-commenter] Dynamic detection failed: ${err.message}`);
      }
    }
  }

  if (!composer) {
    saveDebug(await page.content(), `no_composer_${postId}`);
    const commentDisabled = await page
      .locator("text=/commenting.*disabled|comments.*disabled/i")
      .count()
      .catch(() => 0);
    return {
      success: false,
      error:
        commentDisabled > 0
          ? "Comments disabled on this post"
          : "Could not find comment composer",
    };
  }

  // ── Type the comment with human-like behaviour ────────────────────────────

  try {
    await composer.scrollIntoViewIfNeeded();
    await sleep(randInt(300, 800));
    await humanType(page, composer, comment);
  } catch (err: any) {
    return { success: false, error: `Typing failed: ${err.message}` };
  }

  // ── Submit ────────────────────────────────────────────────────────────────

  let submitted = false;

  // Strategy 1: aria-label submit button
  for (const sel of SUBMIT_ARIA_SELECTORS) {
    try {
      const btn = await page.$(sel);
      if (!btn) continue;
      const visible = await btn.isVisible().catch(() => false);
      if (!visible) continue;
      await sleep(randInt(200, 600)); // brief pause before clicking submit
      await btn.scrollIntoViewIfNeeded();
      await btn.click({ timeout: 5000 });
      submitted = true;
      logger.debug(`[fb-commenter] ✓ Submitted via: ${sel}`);
      break;
    } catch (err: any) {
      logger.debug(
        `[fb-commenter] Submit selector (${sel}) failed: ${err.message}`,
      );
    }
  }

  // Strategy 2: proximity search up from composer
  if (!submitted) {
    try {
      const submitBtn = await page.evaluateHandle((composerEl) => {
        let container: Element | null = composerEl as Element;
        for (let i = 0; i < 8; i++) {
          container = container?.parentElement ?? null;
          if (!container) break;
          const buttons = Array.from(
            container.querySelectorAll('[role="button"], button'),
          );
          for (const btn of buttons) {
            if (btn === composerEl) continue;
            const text = btn.textContent?.trim().toLowerCase() ?? "";
            if (!["post", "comment", "submit"].some((t) => text === t))
              continue;
            const parent = btn.parentElement;
            const hasFeedSiblings = parent
              ? Array.from(parent.children).some(
                  (s) =>
                    s !== btn &&
                    ["like", "share"].some((t) =>
                      s.textContent?.trim().toLowerCase().includes(t),
                    ),
                )
              : false;
            if (hasFeedSiblings) continue;
            if ((btn as HTMLElement).getAttribute("aria-disabled") === "true")
              continue;
            return btn;
          }
        }
        return null;
      }, composer);

      const el = submitBtn.asElement();
      if (el) {
        const visible = await (el as any).isVisible().catch(() => false);
        if (visible) {
          await sleep(randInt(200, 500));
          await (el as any).click({ timeout: 5000 });
          submitted = true;
          logger.debug("[fb-commenter] ✓ Submitted via proximity search");
        }
      }
      submitBtn.dispose();
    } catch (err: any) {
      logger.debug(`[fb-commenter] Proximity submit failed: ${err.message}`);
    }
  }

  // Strategy 3: Ctrl+Enter
  if (!submitted) {
    try {
      await composer.click({ timeout: 3000 });
      await sleep(randInt(200, 500));
      await page.keyboard.press("Control+Enter");
      submitted = true;
      logger.debug("[fb-commenter] ✓ Submitted via Ctrl+Enter");
    } catch (err: any) {
      logger.debug(`[fb-commenter] Ctrl+Enter failed: ${err.message}`);
    }
  }

  // Strategy 4: plain Enter
  if (!submitted) {
    try {
      await composer.click({ timeout: 3000 });
      await sleep(randInt(200, 400));
      await page.keyboard.press("Enter");
      submitted = true;
      logger.debug("[fb-commenter] ✓ Submitted via Enter");
    } catch (err: any) {
      logger.debug(`[fb-commenter] Enter failed: ${err.message}`);
    }
  }

  if (!submitted) {
    return {
      success: false,
      error: "Could not submit comment — all strategies failed",
    };
  }

  // Linger on the page after posting — don't immediately navigate away
  await sleep(randInt(4000, 8000));
  await simulateReading(page); // scroll around a bit after commenting

  // ── Verify ────────────────────────────────────────────────────────────────

  const htmlAfter = await page.content();
  saveDebug(htmlAfter, `after_${postId}`);

  const fingerprint = comment.replace(/\s+/g, " ").trim().slice(0, 40);
  if (!htmlAfter.includes(fingerprint)) {
    logger.warn(
      `[fb-commenter] Fingerprint not found after submit — may still have posted. Fingerprint: "${fingerprint}"`,
    );
  }

  return { success: true };
}

// ── FacebookCommenter ─────────────────────────────────────────────────────────

export class FacebookCommenter {
  private headless: boolean;

  constructor(options?: { headless?: boolean }) {
    this.headless = options?.headless ?? true;
  }

  async commentOnListings(
    listings: RawListing[],
    commentText: CommentText | "auto" = "auto",
  ): Promise<CommentResult[]> {
    const results: CommentResult[] = [];

    if (!fs.existsSync(SESSION_FILE)) {
      throw new Error(
        `[fb-commenter] No session file found at ${SESSION_FILE}. ` +
          `Run the login script first to create a session.`,
      );
    }

    const eligible = listings.filter((l) => {
      if (!l.url) {
        results.push({
          listing: l,
          success: false,
          skipped: true,
          comment: "",
          error: "no_url",
        });
        return false;
      }
      if (!l.url.includes("facebook.com")) {
        results.push({
          listing: l,
          success: false,
          skipped: true,
          comment: "",
          error: "not_facebook_url",
        });
        return false;
      }
      return true;
    });

    // Shuffle eligible listings so we don't always comment in the same order
    for (let i = eligible.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [eligible[i], eligible[j]] = [eligible[j], eligible[i]];
    }

    const toComment = eligible.slice(0, DAILY_COMMENT_LIMIT);
    const skippedByLimit = eligible.length - toComment.length;

    if (skippedByLimit > 0) {
      logger.warn(
        `[fb-commenter] Daily limit of ${DAILY_COMMENT_LIMIT} reached — skipping ${skippedByLimit} listing(s)`,
      );
      for (const l of eligible.slice(DAILY_COMMENT_LIMIT)) {
        results.push({
          listing: l,
          success: false,
          skipped: true,
          comment: "",
          error: "daily_limit_reached",
        });
      }
    }

    if (toComment.length === 0) {
      logger.info("[fb-commenter] No eligible listings to comment on");
      return results;
    }

    logger.info(
      `[fb-commenter] Commenting on ${toComment.length} listing(s) (limit: ${DAILY_COMMENT_LIMIT})`,
    );

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

    // Randomize viewport slightly each session
    const viewportW = randInt(1280, 1440);
    const viewportH = randInt(800, 900);

    const context = await browser.newContext({
      storageState: SESSION_FILE,
      viewport: { width: viewportW, height: viewportH },
      locale: "en-US",
      timezoneId: "America/New_York",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    });

    const page = await context.newPage();

    try {
      // ── Session check ────────────────────────────────────────────────────
      logger.info("[fb-commenter] Verifying session…");
      await page.goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await sleep(randInt(2000, 4000));

      if (
        page.url().includes("login") ||
        (await page.content()).includes('id="email"')
      ) {
        throw new Error(
          "Session has expired. Delete facebook-session.json and re-run the login script.",
        );
      }
      logger.info("[fb-commenter] Session valid ✓");

      // ── Warm-up browse before posting ────────────────────────────────────
      await warmUpSession(page);

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

        if (i < toComment.length - 1) {
          // Randomized pause — sometimes take a longer "break"
          let pause = randInt(BETWEEN_MIN_MS, BETWEEN_MAX_MS);
          if (Math.random() < 0.2) {
            // 20% chance of a longer break (simulates getting distracted)
            pause += randInt(30_000, 120_000);
            logger.info(`[fb-commenter] Taking a longer break this time…`);
          }
          logger.info(
            `[fb-commenter] Pausing ${Math.round(pause / 1000)}s before next comment…`,
          );
          await sleep(pause);
        }
      }

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
  commentText: CommentText | "auto" = "auto",
  options?: { headless?: boolean },
): Promise<CommentResult[]> {
  return new FacebookCommenter(options).commentOnListings(
    listings,
    commentText,
  );
}
