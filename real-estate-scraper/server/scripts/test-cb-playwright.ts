import { chromium } from "playwright";
import * as fs from "fs";
import * as dotenv from "dotenv";

dotenv.config();

(async () => {
  const proxyUrls = (process.env.PROXY_URLS ?? "")
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
  const proxyUrl = proxyUrls[0];
  let proxy: { server: string; username?: string; password?: string } | undefined;
  if (proxyUrl) {
    const u = new URL(proxyUrl);
    proxy = {
      server: `${u.protocol}//${u.hostname}:${u.port}`,
      username: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
    };
    console.log(`Using proxy: ${u.hostname}:${u.port}`);
  }

  const browser = await chromium.launch({ headless: true, proxy });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1440, height: 900 },
    locale: "en-US",
  });
  const page = await ctx.newPage();

  const apiCalls: { url: string; status: number; size: number; type: string }[] = [];

  page.on("response", async (res) => {
    const url = res.url();
    const ct = res.headers()["content-type"] ?? "";
    if (
      (ct.includes("json") || url.includes("api")) &&
      !url.includes("googletagmanager") &&
      !url.includes("trustarc")
    ) {
      let size = 0;
      try {
        size = (await res.body()).length;
      } catch {}
      apiCalls.push({ url: url.slice(0, 200), status: res.status(), size, type: ct.split(";")[0] });
    }
  });

  console.log("Navigating to CB search page...");
  const resp = await page.goto("https://www.coldwellbanker.com/oh/columbus/homes-for-sale", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  console.log("Initial response:", resp?.status());

  // wait for listings to load
  try {
    await page.waitForSelector("[data-testid], article, .listing-card", { timeout: 30_000 });
  } catch {}
  await page.waitForTimeout(8_000);

  const html = await page.content();
  fs.writeFileSync("scripts/logs/cb-playwright.html", html);
  console.log("Final HTML length:", html.length);
  console.log("next_data:", html.includes("__NEXT_DATA__"));

  // count listing-ish markers
  const priceMatches = html.match(/\$[0-9]{3},[0-9]{3}/g) ?? [];
  console.log("price-like strings found:", priceMatches.length, priceMatches.slice(0, 5));

  console.log("\n── JSON/API responses ──");
  for (const c of apiCalls.sort((a, b) => b.size - a.size).slice(0, 20)) {
    console.log(`  ${c.status} ${String(c.size).padStart(8)}B ${c.type} ${c.url}`);
  }

  await browser.close();
})();
