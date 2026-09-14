import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const MARKETPLACE_URL = "https://investorlift.com/marketplace/";
const PROPERTIES_API_URL = "https://investorlift.com/marketplace/api/customer/api/properties";

const SESSION_FILE_DEFAULT = path.join(__dirname, "../../..", "investorlift-session.json");
const SESSION_FILE_FALLBACK = path.join(__dirname, "../../..", "investor-session.json");
const SESSION_FILE = fs.existsSync(SESSION_FILE_FALLBACK) && !fs.existsSync(SESSION_FILE_DEFAULT)
  ? SESSION_FILE_FALLBACK
  : SESSION_FILE_DEFAULT;

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const CHROMIUM_ARGS = [
  "--headless=new",
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-dev-shm-usage",
  "--disable-gpu",
];

async function main() {
  console.log("Checking InvestorLift API counts...");
  console.log(`Using session file: ${SESSION_FILE}`);

  if (!fs.existsSync(SESSION_FILE)) {
    console.error("Session file not found!");
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    args: CHROMIUM_ARGS,
  });

  try {
    const context = await browser.newContext({
      storageState: SESSION_FILE,
      userAgent: USER_AGENT,
    });

    const page = await context.newPage();
    console.log("Navigating to marketplace to pass Cloudflare and get cookies...");
    
    await page.goto(MARKETPLACE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    console.log("Testing API calls...");

    // Test without status
    const resultAll = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { credentials: "include" });
        const body = await r.json().catch(() => null);
        return { status: r.status, count: body?.data?.length, total: body?.meta?.total };
      } catch (err) {
        return { error: String(err) };
      }
    }, `${PROPERTIES_API_URL}?per_page=1`);
    
    console.log(`\nResults for ALL (no status filter):`);
    console.log(`URL: ${PROPERTIES_API_URL}?per_page=1`);
    console.log(resultAll);

    // Test with status=available
    const resultAvailable = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { credentials: "include" });
        const body = await r.json().catch(() => null);
        return { status: r.status, count: body?.data?.length, total: body?.meta?.total };
      } catch (err) {
        return { error: String(err) };
      }
    }, `${PROPERTIES_API_URL}?status=available&per_page=1`);

    console.log(`\nResults for AVAILABLE (status=available filter):`);
    console.log(`URL: ${PROPERTIES_API_URL}?status=available&per_page=1`);
    console.log(resultAvailable);

  } catch (err) {
    console.error("Error running checks:", err);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);
