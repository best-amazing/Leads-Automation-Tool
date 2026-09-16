import { chromium } from "playwright";
import * as fs from "fs";
import * as path from "path";

const MARKETPLACE_URL = "https://investorlift.com/marketplace/";
const PROPERTIES_API_URL =
  "https://investorlift.com/marketplace/api/customer/api/properties";

const SERVER_ROOT = path.resolve(__dirname, "..");
const SESSION_FILE_DEFAULT = path.join(SERVER_ROOT, "investorlift-session.json");
const SESSION_FILE_FALLBACK = path.join(SERVER_ROOT, "investor-session.json");
const SESSION_FILE =
  fs.existsSync(SESSION_FILE_FALLBACK) && !fs.existsSync(SESSION_FILE_DEFAULT)
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

const EXECUTABLE_PATH =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE ||
  "/home/ehxdie/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";

async function fetchJson(page: any, url: string): Promise<any> {
  return page.evaluate(async (u: string) => {
    try {
      const r = await fetch(u, { credentials: "include" });
      const body = await r.json().catch(() => null);
      return { status: r.status, body };
    } catch (err) {
      return { status: 0, body: null, error: String(err) };
    }
  }, url);
}

async function main() {
  console.log("Checking InvestorLift Wisconsin listings...");
  console.log(`Using session file: ${SESSION_FILE}`);

  if (!fs.existsSync(SESSION_FILE)) {
    console.error("Session file not found!");
    process.exit(1);
  }

  const browser = await chromium.launch({
    headless: true,
    executablePath: EXECUTABLE_PATH,
    args: CHROMIUM_ARGS,
  });

  try {
    const context = await browser.newContext({
      storageState: SESSION_FILE,
      userAgent: USER_AGENT,
    });
    const page = await context.newPage();
    console.log("Navigating to marketplace to pass Cloudflare...");
    await page.goto(MARKETPLACE_URL, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    // Direct state=WI query
    console.log("\nQuerying state=WI...");
    const resWi = await fetchJson(
      page,
      `${PROPERTIES_API_URL}?status=available&state=WI&per_page=5000`,
    );
    console.log("  status:", resWi.status);
    const bodyWi = resWi.body ?? {};

    if (Array.isArray(bodyWi.columns) && Array.isArray(bodyWi.data)) {
      const cols: string[] = bodyWi.columns;
      const rows: any[][] = bodyWi.data;
      const idxState = cols.indexOf("state_code");
      const idxCity = cols.indexOf("city");
      const states = new Map<string, number>();
      for (const row of rows) {
        const s = String(row[idxState] ?? "").toUpperCase();
        states.set(s, (states.get(s) ?? 0) + 1);
      }
      console.log("  rows returned:", rows.length);
      console.log(
        "  state breakdown:",
        JSON.stringify([...states.entries()].sort((a, b) => b[1] - a[1])),
      );
      const wiCount = states.get("WI") ?? 0;
      if (idxCity !== -1) {
        const cityMap = new Map<string, number>();
        for (const row of rows) {
          if (String(row[idxState] ?? "").toUpperCase() === "WI") {
            const c = String(row[idxCity] ?? "unknown");
            cityMap.set(c, (cityMap.get(c) ?? 0) + 1);
          }
        }
        console.log("  WI by city:",
          [...cityMap.entries()]
            .sort((a, b) => b[1] - a[1])
            .map(([c, n]) => `${c} (${n})`)
            .join(", "));
      }
      console.log(`\n  === WISCONSIN LISTINGS: ${wiCount} ===`);
    } else {
      console.log("  unexpected shape:", JSON.stringify(bodyWi).slice(0, 300));
    }
  } catch (err) {
    console.error("Error running checks:", err);
  } finally {
    await browser.close();
  }
}

main().catch(console.error);