// src/scrapers/facebook/marketplace.scraper.ts

import { chromium, Page } from "playwright";
import { BaseScraper, ScraperOptions } from "../base.scraper";
import { BrowserHandle, sleep } from "../../utils/browser";
import { RawListing } from "../../types/listing";
import { logger } from "../../utils/logger";
import {
  parseMarketplaceSearchPage,
  parseMarketplaceDetailPage,
} from "./marketplace.parser";
import * as fs from "fs";
import * as path from "path";

const FB_BASE      = "https://www.facebook.com";
const SESSION_FILE = "facebook-session.json";

const MAX_PRICE = parseInt(process.env.FB_MARKETPLACE_MAX_PRICE ?? "300000", 10);

const TARGET_CITIES: Array<{ slug: string; label: string }> = [
  { slug: "columbus",   label: "Columbus, OH"   },
  { slug: "cleveland",  label: "Cleveland, OH"  },
  { slug: "toledo",     label: "Toledo, OH"     },
  { slug: "cincinnati", label: "Cincinnati, OH" },
  { slug: "akron",      label: "Akron, OH"      },
  { slug: "dayton",     label: "Dayton, OH"     },
  { slug: "milwaukee",  label: "Milwaukee, WI"  },
];

const PROPERTY_TYPES  = ["house", "apartment"];
const DETAIL_DELAY_MS = 3_500;
const SCROLL_PASSES   = 6;
const CARD_WAIT_MS    = 40_000;

const ITEM_LINK_SELECTORS = [
  "a[href*='/marketplace/item/']",
  "a[href*='marketplace/item']",
];

const MODAL_CLOSE_SELECTORS = [
  '[aria-label="Close"]',
  '[aria-label="close"]',
  "div[role='dialog'] div[role='button']:has-text('Not Now')",
  "div[role='dialog'] div[role='button']:has-text('Not now')",
  "div[role='dialog'] div[role='button']:has-text('Close')",
  "div[role='dialog'] [data-testid='dialog-close-button']",
];

// ─────────────────────────────────────────────────────────────
// Session signals
//
// THE ROOT CAUSE of the original bug was that verifySession()
// navigated to facebook.com/ and only checked for a login
// redirect. The homepage renders a partial page for anonymous
// users WITHOUT redirecting — so the check always passed.
//
// Proof: the saved HTML contained `"t":"fb_loggedout"` in the
// inline qexData JSON on EVERY search result page, meaning all
// 14 targets scraped as an unauthenticated user and received
// the generic category shell with no listing cards.
//
// Fix: inspect the HTML for explicit logged-in / logged-out
// signals on BOTH the session verify page AND each search page.
// ─────────────────────────────────────────────────────────────

/** Any of these in the HTML confirms an active authed session. */
const LOGGED_IN_SIGNALS = [
  '"viewerID"',            // Relay store viewer node — present only when authed
  '"USER_ID"',             // Another authed user indicator in inline Relay JSON
  'id="mount_0_0"',        // Comet app root hydrated for logged-in users
];

/**
 * Any of these in the HTML means we are definitively logged out.
 * The most reliable is `"t":"fb_loggedout"` from the qexData blob —
 * this is exactly what appeared in every saved search-result HTML.
 */
const LOGGED_OUT_SIGNALS = [
  '"t":"fb_loggedout"',    // qexData type field — definitive logged-out marker
  '"fb_loggedout"',        // alternate serialisation
  'id="email"',            // Login-form email input
  '"isLoggedIn":false',
];

export class MarketplaceScraper extends BaseScraper {
  readonly sourceName = "facebook_marketplace";

  private loggedIn = false;

  private readonly targets: Array<{
    city: (typeof TARGET_CITIES)[0];
    propertyType: string;
  }>;

  constructor(options: ScraperOptions = {}) {
    super(options);

    this.targets = TARGET_CITIES.flatMap((city) =>
      PROPERTY_TYPES.map((propertyType) => ({ city, propertyType }))
    );

    logger.info(
      `[marketplace] ${this.targets.length} search targets ` +
        `(${TARGET_CITIES.length} cities × ${PROPERTY_TYPES.length} property types)`
    );

    if (!process.env.FACEBOOK_USERNAME || !process.env.FACEBOOK_PASSWORD) {
      logger.error(
        "[marketplace] FACEBOOK_USERNAME and FACEBOOK_PASSWORD must be set in .env"
      );
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Session helpers
  // ─────────────────────────────────────────────────────────────

  private sessionExists(): boolean {
    return fs.existsSync(SESSION_FILE);
  }

  /** Returns true if html has a logged-in signal and no logged-out signals. */
  private htmlIndicatesLoggedIn(html: string): boolean {
    for (const signal of LOGGED_OUT_SIGNALS) {
      if (html.includes(signal)) return false;
    }
    return LOGGED_IN_SIGNALS.some(s => html.includes(s));
  }

  /**
   * Returns "ok" | "logged_out" | "ambiguous".
   * "ambiguous" means neither signal set matched — likely a FB layout change;
   * we proceed but log a warning rather than aborting unnecessarily.
   */
  private checkSessionInHtml(
    html: string,
    label: string
  ): "ok" | "logged_out" | "ambiguous" {
    for (const signal of LOGGED_OUT_SIGNALS) {
      if (html.includes(signal)) {
        logger.error(
          `[marketplace] "${label}" served as logged-out — signal: "${signal}"`
        );
        return "logged_out";
      }
    }
    if (LOGGED_IN_SIGNALS.some(s => html.includes(s))) return "ok";
    logger.warn(`[marketplace] "${label}": no session signals in HTML — proceeding cautiously`);
    return "ambiguous";
  }

  // ─────────────────────────────────────────────────────────────
  // Login
  // ─────────────────────────────────────────────────────────────

  private async login(page: Page): Promise<boolean> {
    const username = process.env.FACEBOOK_USERNAME;
    const password = process.env.FACEBOOK_PASSWORD;
    if (!username || !password) return false;

    logger.info("[marketplace] Logging in to Facebook…");

    try {
      await page.goto("https://www.facebook.com/", {
        waitUntil: "domcontentloaded",
        timeout:   60_000,
      });
      await sleep(2500 + Math.random() * 1500);

      await this.saveDebug(await page.content(), "mp_homepage_loaded", page);

      await page.waitForSelector(
        '#email, input[name="email"], input[type="email"], input[autocomplete="username"], ' +
        'button[title="Accept All"], [aria-label="Allow all cookies"], [data-cookiebanner="accept_button"]',
        { timeout: 30_000 }
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
            logger.info(`[marketplace] Dismissed consent dialog via: ${selector}`);
            await sleep(2000);
            break;
          }
        } catch {}
      }

      await page.waitForSelector(
        '#email, input[name="email"], input[type="email"], input[autocomplete="username"]',
        { timeout: 20_000 }
      );
      await sleep(500 + Math.random() * 400);

      const emailField =
        (await page.$("#email")) ??
        (await page.$('input[name="email"]')) ??
        (await page.$('input[type="email"]')) ??
        (await page.$('input[autocomplete="username"]'));

      if (!emailField) {
        logger.error("[marketplace] Could not find email input");
        return false;
      }
      await emailField.fill(username);
      await sleep(600 + Math.random() * 500);

      const passField =
        (await page.$("#pass")) ??
        (await page.$('input[name="pass"]')) ??
        (await page.$('input[type="password"]'));

      if (!passField) {
        logger.error("[marketplace] Could not find password input");
        return false;
      }
      await passField.fill("");
      for (const char of password) {
        await passField.type(char, { delay: 75 + Math.random() * 75 });
      }
      await sleep(800 + Math.random() * 500);

      await passField.press("Enter");
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 });
      await sleep(3500 + Math.random() * 2000);

      const url  = page.url();
      const html = await page.content();
      await this.saveDebug(html, "mp_after_login", page);
      logger.info(`[marketplace] Post-login URL: ${url}`);

      if (
        url.includes("checkpoint") ||
        url.includes("two_step_verification") ||
        html.toLowerCase().includes("confirm your identity") ||
        html.toLowerCase().includes("two-factor") ||
        html.toLowerCase().includes("approval code")
      ) {
        logger.warn("[marketplace] ⚠️  Checkpoint / 2FA — pausing for manual completion");
        await this.saveDebug(html, "mp_checkpoint", page);
        await this.handleTwoFactorOrCheckpoint(page);

        const urlAfter = page.url();
        if (urlAfter.includes("login") || urlAfter.includes("checkpoint")) {
          logger.error("[marketplace] Still not logged in after manual intervention");
          return false;
        }
        logger.info("[marketplace] ✓ Manual intervention successful");
        await page.context().storageState({ path: SESSION_FILE });
        this.loggedIn = true;
        return true;
      }

      if (url.includes("login") || html.toLowerCase().includes("wrong password")) {
        logger.error("[marketplace] Login failed — check credentials");
        await this.saveDebug(html, "mp_login_failed", page);
        return false;
      }

      if (!this.htmlIndicatesLoggedIn(html)) {
        logger.error("[marketplace] Login appeared to succeed but no session signals found in post-login HTML");
        await this.saveDebug(html, "mp_login_no_session_signal", page);
        return false;
      }

      logger.info("[marketplace] ✓ Logged in successfully");
      await page.context().storageState({ path: SESSION_FILE });
      this.loggedIn = true;
      return true;
    } catch (err) {
      logger.error(`[marketplace] Login error: ${err}`);
      await this.saveDebug(await page.content().catch(() => ""), "mp_login_error", page);
      return false;
    }
  }

  private async handleTwoFactorOrCheckpoint(page: Page): Promise<void> {
    logger.info("=== MANUAL INTERVENTION REQUIRED ===");
    logger.info("Complete the verification in the browser, then press Resume.");
    await page.pause();
    try { await page.context().storageState({ path: SESSION_FILE }); } catch {}
  }

  // ─────────────────────────────────────────────────────────────
  // Session verification — STRICT
  //
  // Navigate to /marketplace/ (not just /) — it more reliably
  // reflects auth state since the homepage renders partially for
  // anonymous users without triggering a login redirect.
  //
  // Then use checkSessionInHtml() instead of URL-only checks.
  // ─────────────────────────────────────────────────────────────

  private async verifySession(page: Page): Promise<boolean> {
    try {
      await page.goto("https://www.facebook.com/marketplace/", {
        waitUntil: "domcontentloaded",
        timeout:   30_000,
      });
      await sleep(3000);

      const url  = page.url();
      const html = await page.content();
      await this.saveDebug(html, "mp_session_verify", page);

      if (url.includes("login") || url.includes("checkpoint")) {
        logger.warn(`[marketplace] Session expired — redirected to: ${url}`);
        return false;
      }

      const state = this.checkSessionInHtml(html, "session_verify");
      if (state === "logged_out") return false;

      logger.info(
        state === "ok"
          ? "[marketplace] Session verified ✓ (logged-in signals confirmed)"
          : "[marketplace] Session verify ambiguous — proceeding (will recheck per target)"
      );
      return true;
    } catch {
      return false;
    }
  }

  private async dismissModals(page: Page): Promise<void> {
    let hasDialog: boolean;
    try {
      hasDialog = !!(await page.$("div[role='dialog'], div[aria-modal='true']"));
    } catch { return; }
    if (!hasDialog) return;

    try { await page.keyboard.press("Escape"); await sleep(500); } catch {}

    try {
      const stillOpen = await page.$("div[role='dialog'], div[aria-modal='true']");
      if (!stillOpen) return;
    } catch { return; }

    for (const selector of MODAL_CLOSE_SELECTORS) {
      try {
        const el = await page.$(selector);
        if (!el) continue;
        const tagName = await el.evaluate((n) => n.tagName.toLowerCase());
        if (tagName === "a") continue;
        await el.click({ timeout: 3000 });
        logger.info(`[marketplace] Modal closed via: ${selector}`);
        await sleep(500);
        break;
      } catch {}
    }
  }

  private buildSearchUrl(citySlug: string, propertyType: string): string {
    const params = new URLSearchParams({
      minPrice:        "0",
      maxPrice:        String(MAX_PRICE),
      propertyType,
      daysSinceListed: "7",
    });
    return `${FB_BASE}/marketplace/${citySlug}/propertyforsale/?${params}`;
  }

  private isBlocked(html: string, label: string): boolean {
    const lower = html.toLowerCase();
    const authBlockPhrases: Array<[string, string]> = [
      ["you must log in to",          "login wall"],
      ["log in to continue",           "login wall"],
      ["you're not logged in",         "login wall"],
      ["please log in",                "login wall"],
      ["confirm your identity",        "checkpoint"],
      ["we detected an unusual login", "checkpoint"],
      ["too many requests",            "rate limit"],
    ];
    for (const [phrase, reason] of authBlockPhrases) {
      if (lower.includes(phrase)) {
        logger.warn(`[marketplace] Auth block (${reason}) on "${label}" — phrase: "${phrase}"`);
        return true;
      }
    }
    return false;
  }

  // ─────────────────────────────────────────────────────────────
  // Switch to list view
  //
  // Real estate on FB Marketplace defaults to map view for some
  // accounts. Listing cards only appear in list/grid view.
  //
  // Strategy:
  //   1. Click known list-view toggle buttons.
  //   2. Fall back to appending ?view=list to the URL.
  // ─────────────────────────────────────────────────────────────

  private async switchToListView(page: Page, label: string): Promise<void> {
    const listViewSelectors = [
      '[aria-label="List view"]',
      '[aria-label="Show list"]',
      '[aria-label="Grid view"]',
      '[aria-label="Show grid"]',
      'div[role="tab"]:has-text("List")',
      'div[role="button"][aria-label*="list" i]',
      'div[role="button"][aria-label*="grid" i]',
    ];

    for (const selector of listViewSelectors) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          await btn.click();
          logger.info(`[marketplace] Switched to list view via: ${selector}`);
          await sleep(2500);
          return;
        }
      } catch {}
    }

    // Fallback: rewrite URL with view=list param
    const currentUrl = page.url();
    if (!currentUrl.includes("view=list") && currentUrl.includes("/marketplace/")) {
      const separator = currentUrl.includes("?") ? "&" : "?";
      const listUrl   = `${currentUrl}${separator}view=list`;
      logger.info(`[marketplace] No list-view toggle for ${label} — retrying with ?view=list`);
      try {
        await page.goto(listUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
        await sleep(2000);
      } catch {
        logger.debug(`[marketplace] view=list URL fallback failed for ${label}`);
      }
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Wait for listing cards
  // ─────────────────────────────────────────────────────────────

  private async waitForCards(page: Page, label: string): Promise<number> {
    try {
      await page.waitForLoadState("networkidle", { timeout: 15_000 });
      logger.debug(`[marketplace] networkidle reached for ${label}`);
    } catch {
      logger.debug(`[marketplace] networkidle timeout for ${label} — proceeding`);
    }

    await this.dismissModals(page);
    await this.switchToListView(page, label);

    const selectorExpr = ITEM_LINK_SELECTORS
      .map(s => `document.querySelector(${JSON.stringify(s)}) !== null`)
      .join(" || ");

    try {
      await page.waitForFunction(selectorExpr, { timeout: CARD_WAIT_MS, polling: 1500 });
      const count = await this.countCards(page);
      logger.info(`[marketplace] Cards appeared for ${label}: ${count}`);
      return count;
    } catch {
      logger.debug(`[marketplace] No cards yet for ${label} — nudging scroll`);
      await page.evaluate("window.scrollBy(0, 600)");
      await sleep(3000);
      await page.evaluate("window.scrollTo(0, 0)");
      await sleep(1000);

      const count = await this.countCards(page);
      if (count > 0) {
        logger.info(`[marketplace] Cards after scroll nudge for ${label}: ${count}`);
      } else {
        logger.info(`[marketplace] No cards found for ${label} after ${CARD_WAIT_MS / 1000}s`);
      }
      return count;
    }
  }

  private async countCards(page: Page): Promise<number> {
    return page.evaluate((selectors: string[]) => {
      return selectors.reduce(
        (total, sel) => total + document.querySelectorAll(sel).length,
        0
      );
    }, ITEM_LINK_SELECTORS);
  }

  // ─────────────────────────────────────────────────────────────
  // Scroll feed
  // ─────────────────────────────────────────────────────────────

  private async scrollFeed(page: Page): Promise<void> {
    let lastHeight  = 0;
    let stableCount = 0;

    for (let pass = 0; pass < SCROLL_PASSES; pass++) {
      await this.dismissModals(page);
      for (let i = 0; i < 3; i++) {
        await page.evaluate(`window.scrollBy(0, ${700 + Math.random() * 300})`);
        await sleep(350 + Math.random() * 250);
      }
      await sleep(1800 + Math.random() * 1200);

      const h         = (await page.evaluate("document.body.scrollHeight")) as number;
      const cardCount = await this.countCards(page);
      logger.debug(`[marketplace] Scroll ${pass + 1}: ${cardCount} cards, height ${h}`);

      if (h === lastHeight) {
        stableCount++;
        if (stableCount >= 2) break;
      } else {
        stableCount = 0;
      }
      lastHeight = h;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Scrape a single city + property type
  // ─────────────────────────────────────────────────────────────

  private async scrapeTarget(
    page: Page,
    city: (typeof TARGET_CITIES)[0],
    propertyType: string
  ): Promise<Omit<RawListing, "source">[]> {
    const searchUrl = this.buildSearchUrl(city.slug, propertyType);
    const label     = `${city.label}/${propertyType}`;
    logger.info(`[marketplace] ${label} → ${searchUrl}`);

    try {
      await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
      await sleep(2000 + Math.random() * 1000);

      if (page.url().includes("login") || page.url().includes("checkpoint")) {
        logger.warn(`[marketplace] Redirected to login on ${label}`);
        throw new Error("SESSION_EXPIRED");
      }

      await this.dismissModals(page);

      const initHtml = await page.content();
      await this.saveDebug(initHtml, `search_${city.slug}_${propertyType}`, page);

      // ── Fast-fail if page is served as logged-out ──────────────────
      const sessionState = this.checkSessionInHtml(initHtml, label);
      if (sessionState === "logged_out") {
        logger.error(
          "[marketplace] Aborting — session expired mid-run. " +
          "Delete facebook-session.json and re-run."
        );
        throw new Error("SESSION_EXPIRED");
      }

      if (this.isBlocked(initHtml, label)) return [];

      const pageTitle = await page.title();
      logger.info(`[marketplace] ${label} — title: "${pageTitle}"`);

      const cardCount = await this.waitForCards(page, label);
      if (cardCount === 0) {
        await this.saveDebug(await page.content(), `no_cards_${city.slug}_${propertyType}`, page);
        return [];
      }

      await this.scrollFeed(page);
      await this.dismissModals(page);

      const html  = await page.content();
      const items = parseMarketplaceSearchPage(html);
      logger.info(`[marketplace] ${label}: ${items.length} cards`);
      return items;
    } catch (err: any) {
      if (err.message === "SESSION_EXPIRED") throw err;
      logger.error(`[marketplace] Error on ${label}: ${err.message}`);
      await this.saveDebug(
        await page.content().catch(() => ""),
        `error_${city.slug}_${propertyType}`,
        page
      );
      return [];
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Enrich with detail pages
  // ─────────────────────────────────────────────────────────────

  private async enrichListings(
    page: Page,
    rawItems: Omit<RawListing, "source">[]
  ): Promise<RawListing[]> {
    const enriched: RawListing[] = [];
    for (const item of rawItems) {
      try {
        await sleep(DETAIL_DELAY_MS + Math.random() * 2000);
        await page.goto(item.url, { waitUntil: "domcontentloaded", timeout: 45_000 });
        await sleep(1500 + Math.random() * 1000);
        const detailHtml = await page.content();
        if (!this.isBlocked(detailHtml, item.url)) {
          const detail = parseMarketplaceDetailPage(detailHtml);
          enriched.push({ source: this.sourceName, ...item, ...detail });
          logger.debug(`[marketplace] Enriched: ${item.url}`);
        } else {
          enriched.push({ source: this.sourceName, ...item });
        }
      } catch (err) {
        logger.debug(`[marketplace] Detail failed for ${item.url}: ${err}`);
        enriched.push({ source: this.sourceName, ...item });
      }
    }
    return enriched;
  }

  // ─────────────────────────────────────────────────────────────
  // Main scrape
  // ─────────────────────────────────────────────────────────────

  protected async scrapePage(
    _handle: BrowserHandle,
    pageNumber: number
  ): Promise<RawListing[]> {
    if (pageNumber !== 1) return [];

    logger.info("[marketplace] Launching dedicated no-proxy browser");

    const browser = await chromium.launch({
      headless:       false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
      ],
    });

    const contextOptions: Record<string, any> = {
      viewport:   { width: 1366, height: 900 },
      locale:     "en-US",
      timezoneId: "America/New_York",
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    };

    if (this.sessionExists()) {
      contextOptions.storageState = SESSION_FILE;
      logger.info("[marketplace] Loading saved Facebook session");
    }

    const context = await browser.newContext(contextOptions);
    const page    = await context.newPage();

    try {
      if (this.sessionExists()) {
        const sessionOk = await this.verifySession(page);
        if (!sessionOk) {
          logger.warn("[marketplace] Session invalid — re-logging in");
          try { fs.unlinkSync(SESSION_FILE); } catch {}
          const ok = await this.login(page);
          if (!ok) return [];
        } else {
          this.loggedIn = true;
        }
      } else {
        const ok = await this.login(page);
        if (!ok) return [];
      }

      const allRaw: Omit<RawListing, "source">[] = [];

      for (let i = 0; i < this.targets.length; i++) {
        const { city, propertyType } = this.targets[i];
        logger.info(
          `[marketplace] ── Target ${i + 1}/${this.targets.length}: ${city.label} / ${propertyType}`
        );

        try {
          const items = await this.scrapeTarget(page, city, propertyType);
          allRaw.push(...items);
        } catch (err: any) {
          if (err.message === "SESSION_EXPIRED") {
            logger.error("[marketplace] Session expired mid-run — wiping session file and stopping");
            try { fs.unlinkSync(SESSION_FILE); } catch {}
            break;
          }
          logger.error(`[marketplace] Error on ${city.label}: ${err.message}`);
        }

        if (i < this.targets.length - 1) {
          const pause = 4000 + Math.random() * 3000;
          logger.info(`[marketplace] Pausing ${Math.round(pause / 1000)}s…`);
          await sleep(pause);
        }
      }

      logger.info(`[marketplace] ${allRaw.length} cards — enriching…`);
      const enriched = await this.enrichListings(page, allRaw);

      try {
        await context.storageState({ path: SESSION_FILE });
        logger.info("[marketplace] Session refreshed");
      } catch {}

      logger.info(`[marketplace] Total: ${enriched.length} enriched listings`);
      return enriched;
    } catch (err: any) {
      logger.error(`[marketplace] scrapePage error: ${err.message}`);
      return [];
    } finally {
      await context.close().catch(() => {});
      await browser.close().catch(() => {});
    }
  }

  protected shouldContinue(pageNumber: number): boolean {
    return pageNumber <= 1;
  }

  private async saveDebug(html: string, label: string, page?: Page): Promise<void> {
    try {
      const dir = path.resolve("logs");
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `marketplace_${label}.html`), html, "utf-8");
      if (page) {
        await page.screenshot({
          path:     path.join(dir, `marketplace_${label}.png`),
          fullPage: false,
        }).catch(() => {});
      }
    } catch {}
  }
}