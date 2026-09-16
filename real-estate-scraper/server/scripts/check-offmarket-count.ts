// server/scripts/check-offmarket-count.ts
// ─────────────────────────────────────────────────────────────────────────────
// Reports how many listings exist on offmarket.com for the target states
// (OH, IN) by walking the state-filtered search pages + AJAX Load More.
//
// Usage:
//   npx ts-node -r ./polyfill-file.js scripts/check-offmarket-count.ts
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from "dotenv";
dotenv.config();

import { chromium } from "playwright";
import {
  parseOffmarketSearchPage,
  extractPaginationInfo,
  extractStateFromUrl,
} from "../src/scrapers/offmarket/offmarket.parser";

const HOME_URL = "https://www.offmarket.com";
const AJAX_URL = "https://www.offmarket.com/wp-admin/admin-ajax.php";

const TARGET_STATES = ["OH", "IN"];

const STATE_FULL_NAME: Record<string, string> = {
  OH: "ohio",
  IN: "indiana",
};

const EXECUTABLE_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  "/home/ehxdie/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";

const CHROMIUM_ARGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

const MAX_AJAX_CALLS = 150;

function parseProxy(proxyUrl: string | undefined) {
  if (!proxyUrl) return undefined;
  try {
    const parsed = new URL(proxyUrl);
    const server = `${parsed.protocol}//${parsed.host}`;
    const username = parsed.username
      ? decodeURIComponent(parsed.username)
      : undefined;
    const password = parsed.password
      ? decodeURIComponent(parsed.password)
      : undefined;
    return { server, username, password };
  } catch {
    return { server: proxyUrl };
  }
}

function buildSearchUrl(state: string): string {
  const fullName = STATE_FULL_NAME[state] ?? state.toLowerCase();
  return (
    `https://www.offmarket.com/listing-category/residential/` +
    `?state=${state}&lp_s_loc=${encodeURIComponent(fullName)}`
  );
}

interface StateCount {
  serverTotal: number;
  uniqueUrls: Set<string>;
  byState: Map<string, number>;
  pagesFetched: number;
}

async function countState(page: any, state: string): Promise<StateCount> {
  const url = buildSearchUrl(state);
  const stateCount: StateCount = {
    serverTotal: 0,
    uniqueUrls: new Set<string>(),
    byState: new Map<string, number>(),
    pagesFetched: 0,
  };

  const record = (items: any[]) => {
    for (const item of items) {
      stateCount.uniqueUrls.add(item.url);
      const st = assetState(item, state);
      stateCount.byState.set(st, (stateCount.byState.get(st) ?? 0) + 1);
    }
  };

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  console.log(`\n=== Fetching ${state}: ${url} ===`);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  try {
    await page.waitForSelector("[data-posturl]", { timeout: 20_000 });
  } catch {}

  for (const y of [400, 900, 1400, 900, 400]) {
    await page.evaluate(`window.scrollTo(0, ${y})`);
    await sleep(200 + Math.random() * 150);
  }
  await sleep(1200);

  const html = await page.content();
  const lower = html.toLowerCase();
  if (
    lower.includes("wordfence") ||
    lower.includes("your access to this site has been limited")
  ) {
    console.error(`  ❌ Wordfence block for ${state}`);
    return stateCount;
  }

  stateCount.pagesFetched++;
  const items = parseOffmarketSearchPage(html);
  const pagInfo = extractPaginationInfo(html);
  stateCount.serverTotal = pagInfo.totalRecords || 0;

  console.log(
    `  page 1: ${items.length} cards | server total: ${pagInfo.totalRecords} |` +
      ` loadMorePage: ${pagInfo.loadMorePage} | hasMore: ${pagInfo.hasMore}`,
  );
  record(items);

  // ── Walk AJAX Load More pages ─────────────────────────────────────────
  let loadMorePage = pagInfo.loadMorePage || 2;
  for (let call = 0; call < MAX_AJAX_CALLS; call++) {
    if (
      stateCount.serverTotal > 0 &&
      stateCount.uniqueUrls.size >= stateCount.serverTotal
    ) {
      console.log(`  reached server total (${stateCount.serverTotal})`);
      break;
    }

    const body = await page.evaluate(
      async ({ ajaxUrl, ajaxPageNum }: { ajaxUrl: string; ajaxPageNum: number }) => {
        const btn = document.querySelector(".loadMoreListing") as HTMLElement | null;
        const nonce = btn?.getAttribute("data-rand-number") ?? "";
        const listedInput =
          (document.getElementById("listed_listing_id") as HTMLInputElement | null) ??
          (document.querySelector("input[name='listed_listing_id']") as HTMLInputElement | null);
        const listedIds = listedInput?.value ?? "";
        const termId = "53";
        const params = new URLSearchParams({
          action: "ajax_listing_load_more",
          nonce,
          listed_listing_id: listedIds,
          page: String(ajaxPageNum),
          term_id: termId,
        });
        try {
          const res = await fetch(ajaxUrl, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: params.toString(),
          });
          return res.ok ? await res.text() : null;
        } catch {
          return null;
        }
      },
      { ajaxUrl: AJAX_URL, ajaxPageNum: loadMorePage + call },
    );

    if (!body || body.trim() === "" || body.trim() === "0") {
      console.log(`  AJAX call ${call + 1} returned empty — done`);
      break;
    }

    stateCount.pagesFetched++;
    const wrapped = `<html><body><div id="content-grids">${body}</div></body></html>`;
    const ajaxItems = parseOffmarketSearchPage(wrapped);
    record(ajaxItems);
    console.log(
      `  AJAX server-page ${loadMorePage + call}: ${ajaxItems.length} cards |` +
        ` running unique: ${stateCount.uniqueUrls.size}/${stateCount.serverTotal || "?"}`,
    );

    if (ajaxItems.length === 0) break;
    await sleep(800 + Math.random() * 700);
  }

  return stateCount;
}

function assetState(item: any, expected: string): string {
  const st = (item.state?.toUpperCase?.() ??
    extractStateFromUrl(item.url) ??
    expected) as string;
  return st.toUpperCase();
}

async function main() {
  console.log("=== offmarket.com listing count check ===\n");

  const proxies = (process.env.PROXY_URLS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const proxyUrl =
    process.env.OFFMARKET_COUNT_PROXY ||
    process.env.CL_PROXY_URL ||
    process.env.PROXY_URL ||
    proxies[0];
  const proxy = proxyUrl ? parseProxy(proxyUrl) : undefined;

  console.log(
    proxy ? `Using proxy: ${proxy.server}` : "No proxy — connecting direct",
  );

  const browser = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE_PATH,
    args: CHROMIUM_ARGS,
    ...(proxy ? { proxy } : {}),
  });

  const results: Array<{ state: string; total: number }> = [];

  try {
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      viewport: { width: 1440, height: 900 },
      locale: "en-US",
      timezoneId: "America/New_York",
    });
    const page = await context.newPage();

    // Warm up session before hitting state pages
    console.log("Warming session…");
    await page.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await new Promise((r) => setTimeout(r, 3000));
    await page.goto(`${HOME_URL}/listing-category/real-estate/`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    }).catch(() => {});
    await new Promise((r) => setTimeout(r, 2500));

    for (const state of TARGET_STATES) {
      const cnt = await countState(page, state);
      const breakdown = [...cnt.byState.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([s, n]) => `${s}=${n}`)
        .join(", ");
      console.log(
        `\n  === ${state}: server total=${cnt.serverTotal} fetched unique=${cnt.uniqueUrls.size} (${cnt.pagesFetched} requests) ===`,
      );
      console.log(`  state breakdown: ${breakdown}`);
      results.push({ state, total: cnt.serverTotal });
    }
  } catch (err) {
    console.error("Error running counts:", err);
  } finally {
    await browser.close();
  }

  console.log("\n=== SUMMARY ===");
  for (const r of results) {
    console.log(`  ${r.state}: ${r.total}`);
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);