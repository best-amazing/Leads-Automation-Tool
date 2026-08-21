/**
 * test-coldwellbanker.ts
 *
 * Quick standalone test to check whether Oxylabs (Universal Scraper API,
 * source: "universal", render: "html" — matching the existing project config)
 * can successfully fetch pages from coldwellbanker.com.
 *
 * Usage:
 *   OXYLABS_USERNAME=xxx OXYLABS_PASSWORD=xxx npx ts-node test-coldwellbanker.ts
 *
 * Or compile first:
 *   npx tsc test-coldwellbanker.ts && OXYLABS_USERNAME=xxx OXYLABS_PASSWORD=xxx node test-coldwellbanker.js
 *
 * Requires Node 18+ (for global fetch). No extra npm deps needed.
 */

import * as fs from "fs";
import * as path from "path";

const OXYLABS_USERNAME = process.env.OXYLABS_USERNAME;
const OXYLABS_PASSWORD = process.env.OXYLABS_PASSWORD;

if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
  console.error(
    "Missing OXYLABS_USERNAME / OXYLABS_PASSWORD env vars. Set them and re-run."
  );
  process.exit(1);
}

const OXYLABS_ENDPOINT = "https://realtime.oxylabs.io/v1/queries";

const LOG_DIR = path.join(__dirname, "logs");
if (!fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

// Pages to test: a search/listing page and a plausible detail page.
// Adjust the detail URL to a real, current listing if this one 404s.
const TEST_URLS: { label: string; url: string }[] = [
  {
    label: "homepage",
    url: "https://www.coldwellbanker.com/",
  },
  {
    label: "search-results",
    url: "https://www.coldwellbanker.com/oh/columbus/homes-for-sale",
  },
];

// Signatures that indicate we hit a bot-challenge page instead of real content
const CHALLENGE_SIGNATURES = [
  "px-captcha",
  "_pxhd",
  "perimeterx",
  "human security",
  "please verify you are human",
  "access denied",
  "akamai",
  "_abck",
  "incapsula",
  "distil",
  "captcha-delivery",
  "just a moment", // Cloudflare challenge page title
  "checking your browser",
];

interface OxylabsResponse {
  results: {
    content: string;
    status_code: number;
    job_id?: string;
  }[];
}

async function fetchViaOxylabs(targetUrl: string): Promise<OxylabsResponse> {
  const auth = Buffer.from(`${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`).toString(
    "base64"
  );

  const response = await fetch(OXYLABS_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Basic ${auth}`,
    },
    body: JSON.stringify({
      source: "universal",
      url: targetUrl,
      render: "html",
      // parse: false — we want raw HTML for this test, not a structured parse
    }),
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(
      `Oxylabs request failed: HTTP ${response.status} — ${text.slice(0, 500)}`
    );
  }

  return JSON.parse(text) as OxylabsResponse;
}

function detectChallenge(html: string): string[] {
  const lower = html.toLowerCase();
  return CHALLENGE_SIGNATURES.filter((sig) => lower.includes(sig));
}

function saveDebugHtml(label: string, html: string) {
  const filePath = path.join(LOG_DIR, `${label}.html`);
  fs.writeFileSync(filePath, html, "utf-8");
  return filePath;
}

async function runTest(label: string, url: string) {
  console.log(`\n=== Testing: ${label} (${url}) ===`);

  try {
    const result = await fetchViaOxylabs(url);
    const page = result.results?.[0];

    if (!page) {
      console.log("❌ No result returned from Oxylabs.");
      return;
    }

    const html = page.content ?? "";
    const statusCode = page.status_code;
    const htmlLength = html.length;
    const challenges = detectChallenge(html);
    const savedPath = saveDebugHtml(label, html);

    console.log(`Status code: ${statusCode}`);
    console.log(`HTML length: ${htmlLength} chars`);
    console.log(`Saved to: ${savedPath}`);

    if (challenges.length > 0) {
      console.log(`⚠️  Possible bot-challenge signatures found: ${challenges.join(", ")}`);
      console.log("   -> Likely blocked or served a challenge page, not real content.");
    } else if (htmlLength < 2000) {
      console.log("⚠️  HTML is suspiciously short — may be an error page or empty shell.");
    } else {
      console.log("✅ No known challenge signatures detected and HTML looks substantial.");
    }

    // Quick sanity check: does the page contain expected real-estate markup?
    const looksLikeRealContent =
      html.toLowerCase().includes("coldwell banker") ||
      html.toLowerCase().includes("listing") ||
      html.toLowerCase().includes("for sale");
    console.log(
      looksLikeRealContent
        ? "✅ Page content references expected site/listing terms."
        : "⚠️  Page content doesn't reference expected terms — inspect the saved HTML."
    );
  } catch (err) {
    console.log(`❌ Request failed: ${(err as Error).message}`);
  }
}

async function main() {
  console.log("Oxylabs coldwellbanker.com feasibility test");
  console.log("Config: source=universal, render=html (matches existing project config)");

  for (const { label, url } of TEST_URLS) {
    await runTest(label, url);
  }

  console.log("\nDone. Check the logs/ directory for saved HTML to inspect manually.");
}

main().catch((err) => {
  console.error("Unexpected error:", err);
  process.exit(1);
});
