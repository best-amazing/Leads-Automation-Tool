// src/scrapers/facebook/facebook.scraper.ts

import { chromium, Page } from "playwright";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import { parseFacebookGroupPosts, stableKey } from "./facebook.parser";
import * as fs from "fs";
import * as path from "path";

const SESSION_FILE = "facebook-session.json";

// Normalises web.facebook.com → www.facebook.com so session cookies apply.
// Also handles newline-separated URLs in case .env is misconfigured.
function parseFacebookGroupUrls(raw: string): string[] {
  return raw
    .split(/[\s,]+/) // split on whitespace OR comma
    .map((u) => u.trim().replace(/[`"']/g, ""))
    .filter((u) => u.length > 0)
    .map((u) => {
      if (/^https?:\/\//i.test(u)) {
        // Normalise web.* → www.* (session cookies are bound to www.facebook.com)
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

const DEFAULT_GROUP_URLS: string[] = parseFacebookGroupUrls(
  process.env.FACEBOOK_GROUP_URLS ?? "",
);

// 20 passes × 900px = 18,000px — enough to load 25–40 posts on most groups
const SCROLL_PASSES = 50;
const SCROLL_STEP = 1200;

// Only close/dismiss selectors — NEVER "Log In" (that navigates away)
const MODAL_CLOSE_SELECTORS = [
  '[aria-label="Close"]',
  '[aria-label="close"]',
  "div[role='dialog'] div[role='button']:has-text('Not Now')",
  "div[role='dialog'] div[role='button']:has-text('Not now')",
  "div[role='dialog'] div[role='button']:has-text('Close')",
  "div[role='dialog'] [data-testid='dialog-close-button']",
];

export class FacebookScraper extends BaseScraper {
  readonly sourceName = "facebook";

  constructor(options: ScraperOptions = {}) {
    super(options);

    if (!process.env.FACEBOOK_USERNAME || !process.env.FACEBOOK_PASSWORD) {
      logger.error(
        "[facebook] FACEBOOK_USERNAME and FACEBOOK_PASSWORD must be set in .env",
      );
    }

    if (DEFAULT_GROUP_URLS.length === 0) {
      logger.warn(
        "[facebook] No group URLs found. Check FACEBOOK_GROUP_URLS in .env — " +
          "all URLs must be on ONE LINE, comma-separated.",
      );
    } else {
      logger.info(
        `[facebook] ${DEFAULT_GROUP_URLS.length} target group(s):\n` +
          DEFAULT_GROUP_URLS.map((u) => `  • ${u}`).join("\n"),
      );
    }
  }

  private sessionExists(): boolean {
    return fs.existsSync(SESSION_FILE);
  }

  // ── Login ──────────────────────────────────────────────────────────────────

  private async login(page: Page): Promise<boolean> {
    const username = process.env.FACEBOOK_USERNAME;
    const password = process.env.FACEBOOK_PASSWORD;
    if (!username || !password) return false;

    logger.info("[facebook] Logging in…");

    try {
      await page.goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout: 60_000,
      });
      await sleep(2500 + Math.random() * 1500);
      this.saveDebug(await page.content(), "homepage_loaded");

      await page.waitForSelector(
        '#email, input[name="email"], input[type="email"], input[autocomplete="username"], ' +
          'button[title="Accept All"], [aria-label="Allow all cookies"], [data-cookiebanner="accept_button"]',
        { timeout: 30_000 },
      );

      for (const selector of [
        '[data-cookiebanner="accept_button"]',
        'button[title="Accept All"]',
        'button[title="Allow all cookies"]',
        '[aria-label="Allow all cookies"]',
        "button:has-text('Accept All')",
        "button:has-text('Allow essential and optional cookies')",
        "button:has-text('Allow essential')",
      ]) {
        try {
          const btn = await page.$(selector);
          if (btn) {
            await btn.click();
            logger.info(`[facebook] Dismissed consent dialog via: ${selector}`);
            await sleep(2000);
            break;
          }
        } catch {}
      }

      await page.waitForSelector(
        '#email, input[name="email"], input[type="email"], input[autocomplete="username"]',
        { timeout: 20_000 },
      );
      await sleep(500 + Math.random() * 400);

      const emailField =
        (await page.$("#email")) ??
        (await page.$('input[name="email"]')) ??
        (await page.$('input[type="email"]')) ??
        (await page.$('input[autocomplete="username"]'));

      if (!emailField) {
        logger.error("[facebook] Could not find email input");
        return false;
      }
      await emailField.fill(username);
      await sleep(600 + Math.random() * 500);

      const passField =
        (await page.$("#pass")) ??
        (await page.$('input[name="pass"]')) ??
        (await page.$('input[type="password"]'));

      if (!passField) {
        logger.error("[facebook] Could not find password input");
        return false;
      }
      await passField.fill("");
      for (const char of password) {
        await passField.type(char, { delay: 75 + Math.random() * 75 });
      }
      await sleep(800 + Math.random() * 500);

      await passField.press("Enter");
      await page.waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await sleep(3500 + Math.random() * 2000);

      const url = page.url();
      const html = await page.content();
      this.saveDebug(html, "after_login_attempt");
      logger.info(`[facebook] Post-login URL: ${url}`);

      if (
        url.includes("checkpoint") ||
        url.includes("two_step_verification") ||
        html.toLowerCase().includes("confirm your identity") ||
        html.toLowerCase().includes("two-factor") ||
        html.toLowerCase().includes("approval code")
      ) {
        logger.warn(
          "[facebook] ⚠️  Checkpoint / 2FA — pausing for manual completion",
        );
        this.saveDebug(html, "checkpoint");
        await this.handleTwoFactorOrCheckpoint(page);

        const urlAfter = page.url();
        if (urlAfter.includes("login") || urlAfter.includes("checkpoint")) {
          logger.error(
            "[facebook] Still not logged in after manual intervention",
          );
          return false;
        }
        await page.context().storageState({ path: SESSION_FILE });
        return true;
      }

      if (
        url.includes("login") ||
        html.toLowerCase().includes("wrong password")
      ) {
        logger.error("[facebook] Login failed — check credentials");
        this.saveDebug(html, "login_failed");
        return false;
      }

      logger.info("[facebook] ✓ Logged in successfully");
      this.saveDebug(html, "logged_in");
      await page.context().storageState({ path: SESSION_FILE });
      return true;
    } catch (err) {
      logger.error(`[facebook] Login error: ${err}`);
      this.saveDebug(await page.content().catch(() => ""), "login_error");
      return false;
    }
  }

  // ── 2FA / Checkpoint ───────────────────────────────────────────────────────

  private async handleTwoFactorOrCheckpoint(page: Page): Promise<void> {
    logger.warn("[facebook] ⚠️  2FA / Checkpoint detected in headless mode");
    logger.warn(
      "[facebook] Automatic 2FA resolution is not available in headless mode.",
    );
    logger.warn(
      "[facebook] Please provide a pre-authenticated session file or run with headless=false for manual intervention.",
    );
    try {
      await page.context().storageState({ path: SESSION_FILE });
    } catch {}
  }

  // ── Dismiss modals — Escape first, never click Log In ─────────────────────

  private async dismissModals(page: Page): Promise<void> {
    let hasDialog: boolean;
    try {
      hasDialog = !!(await page.$(
        "div[role='dialog'], div[aria-modal='true']",
      ));
    } catch {
      return;
    }
    if (!hasDialog) return;

    logger.info("[facebook] Modal detected — dismissing via Escape");

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
        const tagName = await el.evaluate((n) => n.tagName.toLowerCase());
        if (tagName === "a") continue; // never click links
        await el.click({ timeout: 3000 });
        logger.info(`[facebook] Modal closed via: ${selector}`);
        await sleep(500);
        break;
      } catch {}
    }
  }

  // ── Verify session ─────────────────────────────────────────────────────────

  private async verifySession(page: Page): Promise<boolean> {
    try {
      await page.goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout: 30_000,
      });
      await sleep(3000);
      const url = page.url();
      const html = await page.content();
      if (url.includes("login") || html.includes('id="email"')) {
        logger.warn("[facebook] Session expired");
        return false;
      }
      logger.info("[facebook] Session verified ✓");
      return true;
    } catch (err: any) {
      logger.warn(`[facebook] Session verify error: ${err.message}`);
      return false;
    }
  }

  // ── Navigate to group ──────────────────────────────────────────────────────

  private async navigateToGroup(
    page: Page,
    groupUrl: string,
  ): Promise<boolean> {
    try {
      logger.info(`[facebook] Navigating to: ${groupUrl}`);
      await page.goto(groupUrl, {
        waitUntil: "domcontentloaded",
        timeout: 90_000,
      });
      await sleep(3000);

      await this.dismissModals(page);
      await sleep(1500);

      if (page.url().includes("login")) {
        logger.warn(
          "[facebook] Redirected to login — session not valid for this URL",
        );
        return false;
      }

      const feedSelectors = [
        "[role='feed']",
        "[data-pagelet='GroupFeed']",
        "[data-pagelet='GroupDiscussionFeed']",
        "[role='article']",
        "a[href*='/posts/']",
        "a[href*='/permalink/']",
      ];

      let feedFound = false;
      for (const selector of feedSelectors) {
        try {
          await page.waitForSelector(selector, { timeout: 15_000 });
          logger.info(`[facebook] Feed detected via: ${selector}`);
          feedFound = true;
          break;
        } catch {}
      }

      if (!feedFound) {
        this.saveDebug(await page.content(), "group_page_no_feed");
        logger.warn(`[facebook] Feed did not render: ${groupUrl}`);
        return false;
      }

      await sleep(2000);
      this.saveDebug(
        await page.content(),
        `group_page_${this.slugify(groupUrl)}`,
      );
      logger.info(`[facebook] ✓ Group feed loaded`);
      return true;
    } catch (err: any) {
      logger.error(`[facebook] Navigation error: ${err.message}`);
      return false;
    }
  }

  // ── Scroll feed — stops early if post count stabilises ────────────────────

  private async scrollFeed(page: Page) {
    logger.info(`[facebook] Scrolling feed (up to ${SCROLL_PASSES} passes)…`);

    let lastPostCount = 0;
    let stableCount = 0;

    for (let i = 0; i < SCROLL_PASSES; i++) {
      await this.dismissModals(page);

      try {
        await page.evaluate(`window.scrollBy(0, ${SCROLL_STEP})`);
      } catch {
        logger.warn(`[facebook] Scroll ${i + 1} failed — stopping`);
        break;
      }

      // Longer pause every 5th pass to let FB's lazy loader fire
      const delay = i % 5 === 4 ? 4000 : 1800 + Math.random() * 800;
      await sleep(delay);

      let currentPostCount = 0;
      try {
        currentPostCount = (await page.evaluate(
          () => document.querySelectorAll("[role='article']").length,
        )) as number;
      } catch {}

      logger.info(
        `[facebook] Scroll ${i + 1}/${SCROLL_PASSES} — posts visible: ${currentPostCount}`,
      );

      if (currentPostCount === lastPostCount) {
        stableCount++;
        if (stableCount >= 3) {
          logger.info(
            "[facebook] Post count stable for 3 passes — feed fully loaded",
          );
          break;
        }
      } else {
        stableCount = 0;
      }
      lastPostCount = currentPostCount;
    }

    // Back to top so parser captures posts from the beginning
    try {
      await page.evaluate("window.scrollTo(0, 0)");
      await sleep(1500);
    } catch {}
  }

  // ── Expand "See more" ──────────────────────────────────────────────────────

  private async expandPosts(page: Page) {
    try {
      const buttons = await page.$$(
        '[data-ad-rendering-role="story_message"] [role="button"]:has-text("See more"), ' +
          '[aria-label="See more"]',
      );
      logger.info(
        `[facebook] Expanding ${Math.min(buttons.length, 30)} "See more" buttons`,
      );
      for (const btn of buttons.slice(0, 30)) {
        try {
          await this.dismissModals(page);
          await btn.click({ timeout: 5000 });
          await sleep(250);
        } catch {}
      }
    } catch {}
  }

  // ── Scrape one group ───────────────────────────────────────────────────────

  private async scrapeGroup(
    page: Page,
    groupUrl: string,
  ): Promise<RawListing[]> {
    const navOk = await this.navigateToGroup(page, groupUrl);
    if (!navOk) return [];

    await this.scrollFeed(page);
    await this.expandPosts(page);
    await this.dismissModals(page);
    
    logger.info(`[facebook] Waiting for loading skeletons to resolve...`);
    try {
      let retries = 5;
      while (retries > 0) {
        const loading = await page.$$("[aria-label='Loading...'], [data-visualcompletion='loading-state']");
        if (loading.length === 0) break;
        await sleep(1500);
        retries--;
      }
    } catch {}
    
    await sleep(1000);

    let html: string;
    try {
      html = await page.content();
    } catch (err: any) {
      logger.error(
        `[facebook] Could not capture HTML after scroll: ${err.message}`,
      );
      return [];
    }

    this.saveDebug(html, `final_${this.slugify(groupUrl)}`);
    const listings = parseFacebookGroupPosts(html, groupUrl, "facebook");
    logger.info(`[facebook] ${groupUrl} → ${listings.length} listings`);
    return listings;
  }

  // ── Deduplicate listings across groups ────────────────────────────────────
  //
  // The same post is often cross-posted to several groups by the same seller.
  // Within a single group page the parser's `seen` set catches duplicates, but
  // across groups each call to parseFacebookGroupPosts has its own fresh set.
  // We apply a second pass here using the same stable key so cross-group
  // duplicates are collapsed before the listings reach the database.

  private deduplicateAcrossGroups(listings: RawListing[]): RawListing[] {
    const seen = new Set<string>();
    const deduped: RawListing[] = [];

    for (const listing of listings) {
      const key = stableKey(listing.description ?? listing.title ?? "");
      if (seen.has(key)) {
        logger.info(
          `[facebook] Dropping cross-group duplicate: "${listing.title?.slice(0, 70)}"`,
        );
        continue;
      }
      seen.add(key);
      deduped.push(listing);
    }

    const dropped = listings.length - deduped.length;
    if (dropped > 0) {
      logger.info(
        `[facebook] Cross-group dedup removed ${dropped} duplicate(s)`,
      );
    }
    return deduped;
  }

  // ── Main scrape — all groups in one browser session ────────────────────────

  protected async scrapePage(
    handle: BrowserHandle,
    pageNumber: number,
  ): Promise<RawListing[]> {
    if (pageNumber !== 1 || DEFAULT_GROUP_URLS.length === 0) return [];

    logger.info("[facebook] Launching dedicated no-proxy browser for Facebook");

    const browser = await chromium.launch({
      headless: process.env.FACEBOOK_HEADLESS !== "false",
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

    const contextOptions: Record<string, any> = {
      viewport: { width: 1366, height: 900 },
      locale: "en-US",
      timezoneId: "America/New_York",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    };

    if (this.sessionExists()) {
      contextOptions.storageState = SESSION_FILE;
      logger.info("[facebook] Loading saved session");
    }

    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    try {
      // Ensure we are logged in before iterating groups
      if (this.sessionExists()) {
        const sessionOk = await this.verifySession(page);
        if (!sessionOk) {
          logger.warn("[facebook] Saved session expired — re-logging in");
          try {
            fs.unlinkSync(SESSION_FILE);
          } catch {}
          const ok = await this.login(page);
          if (!ok) return [];
        }
      } else {
        const ok = await this.login(page);
        if (!ok) return [];
      }

      const allListings: RawListing[] = [];

      // Iterate every group in the same browser session
      for (let i = 0; i < DEFAULT_GROUP_URLS.length; i++) {
        const groupUrl = DEFAULT_GROUP_URLS[i];
        logger.info(
          `[facebook] ── Group ${i + 1}/${DEFAULT_GROUP_URLS.length}: ${groupUrl}`,
        );

        try {
          const listings = await this.scrapeGroup(page, groupUrl);
          allListings.push(...listings);
          logger.info(
            `[facebook] Running total after group ${i + 1}: ${allListings.length} listings`,
          );
        } catch (err: any) {
          logger.error(`[facebook] Error scraping ${groupUrl}: ${err.message}`);
          // Continue to next group even if this one fails
        }

        // Brief pause between groups to reduce rate-limit risk
        if (i < DEFAULT_GROUP_URLS.length - 1) {
          const pause = 5000 + Math.random() * 4000;
          logger.info(
            `[facebook] Pausing ${Math.round(pause / 1000)}s before next group…`,
          );
          await sleep(pause);
        }
      }

      try {
        await context.storageState({ path: SESSION_FILE });
        logger.info("[facebook] Session refreshed and saved");
      } catch {}

      // Collapse duplicates that were cross-posted to multiple groups
      const dedupedListings = this.deduplicateAcrossGroups(allListings);

      logger.info(
        `[facebook] Total: ${dedupedListings.length} unique listings across all groups ` +
          `(${allListings.length} before dedup)`,
      );
      return dedupedListings;
    } catch (err: any) {
      logger.error(`[facebook] scrapePage error: ${err.message}`);
      return [];
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= 1;
  }

  private slugify(url: string): string {
    return url
      .replace(/https?:\/\/[^/]+\/groups\//, "")
      .replace(/\//g, "")
      .slice(0, 40);
  }

  private saveDebug(html: string, label: string) {
    try {
      const dir = path.resolve("logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `facebook_${label}.html`), html);
    } catch {}
  }
}
