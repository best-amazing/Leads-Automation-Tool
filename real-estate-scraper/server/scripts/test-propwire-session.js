// filepath: test-propwire-session.js
// Test script to verify PropWire session cookie is valid

require("dotenv").config();
const { chromium } = require("playwright");
const fs = require("fs");

async function testSession() {
  const browser = await chromium.launch({
    headless: false,
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  });

  // Inject session cookie ONLY
  await context.addCookies([
    {
      name: "propwire_session",
      value: process.env.PROPWIRE_SESSION_COOKIE,
      domain: "propwire.com",
      path: "/",
    },
  ]);

  const page = await context.newPage();

  // ✅ IMPORTANT: start from root (SPA entry point)
  await page.goto("https://propwire.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  // Let JS app settle
  await page.waitForTimeout(5000);

  const url = page.url();
  console.log("Final URL:", url);

  // ----------------------------
  // DETECTION STRATEGY (ROBUST)
  // ----------------------------

  // 1. Check if we got blocked
  const bodyText = await page.textContent("body");

  if (bodyText.includes("enable JS") || bodyText.includes("captcha")) {
    console.log("❌ Blocked by anti-bot system");
  }

  // 2. Check if we got redirected to login
  else if (url.includes("login")) {
    console.log("❌ Not authenticated (redirected to login)");
  }

  // 3. Check if Next.js app bootstrapped
  else {
    const hasNextData = await page.locator("#__NEXT_DATA__").count();

    if (hasNextData > 0) {
      console.log("✓ Session is valid (Next.js app loaded)");
    } else {
      console.log("? Unknown state - likely partial block or lazy load issue");
    }
  }

  // Save debug screenshot
  if (!fs.existsSync("logs")) fs.mkdirSync("logs");

  await page.screenshot({
    path: "logs/propwire-session-test.png",
    fullPage: true,
  });

  console.log("📸 Screenshot saved: logs/propwire-session-test.png");

  await browser.close();
}

testSession().catch(console.error);