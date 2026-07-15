import * as fs from "fs";
import * as path from "path";

const SESSION_FILE = path.join(__dirname, "investorlift-session.json");
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
const BASE_HEADERS = {
  "User-Agent": USER_AGENT,
  "Origin":     "https://investorlift.com",
  "Referer":    "https://investorlift.com/marketplace/",
};

function buildCookieHeader(): string | null {
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const state = JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
    const cookies = (state.cookies ?? []) as Array<{ name: string; value: string }>;
    if (cookies.length === 0) return null;
    return cookies.map((c) => `${c.name}=${c.value}`).join("; ");
  } catch (err) {
    return null;
  }
}

async function testFetch() {
  const listingId = 327403;
  const cookieHeader = buildCookieHeader();
  if (!cookieHeader) {
    console.error("No cookie header!");
    return;
  }

  const res = await fetch(`https://investorlift.com/marketplace/api/customer/api/properties/${listingId}`, {
    headers: {
      ...BASE_HEADERS,
      "Cookie": cookieHeader
    }
  });

  const text = await res.text();
  console.log(text.slice(0, 1000));
  fs.writeFileSync(path.join(__dirname, "prop_api.json"), text, "utf-8");
}

testFetch();
