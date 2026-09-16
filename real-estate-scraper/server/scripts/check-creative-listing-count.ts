// server/scripts/check-creative-listing-count.ts
// ─────────────────────────────────────────────────────────────────────────────
// Reports how many active listings are available on CreativeListing.com,
// both overall and per-state.
//
// Usage:
//   npx ts-node -r ./polyfill-file.js scripts/check-creative-listing-count.ts
// ─────────────────────────────────────────────────────────────────────────────

import dotenv from "dotenv";
dotenv.config();

import * as https from "https";
import * as http from "http";
import { HttpsProxyAgent } from "https-proxy-agent";

// ── Auth / proxy config (mirrors creative-listing.scraper.ts) ───────────────

const clTokens = {
  authToken: process.env.CL_AUTH_TOKEN ?? "",
  accessToken: process.env.CL_ACCESS_TOKEN ?? "",
};

const CL_REFRESH_TOKEN = process.env.CL_REFRESH_TOKEN ?? "";
const CL_COGNITO_CLIENT_ID = process.env.CL_COGNITO_CLIENT_ID ?? "";
const CL_USER_POOL_REGION = process.env.CL_USER_POOL_REGION ?? "us-east-2";

const CL_PROXY_URL = process.env.CL_PROXY_URL ?? "";
const clProxyAgent: http.Agent | undefined = CL_PROXY_URL
  ? (new HttpsProxyAgent(CL_PROXY_URL) as unknown as http.Agent)
  : undefined;

const BASE_URL = "https://www.creativelisting.com";
const API_PATH = "/api/deals";
const PAGE_LIMIT = 9;

// ── Cognito token refresh ────────────────────────────────────────────────────

function refreshCognitoTokens(): Promise<boolean> {
  const body = JSON.stringify({
    AuthFlow: "REFRESH_TOKEN_AUTH",
    ClientId: CL_COGNITO_CLIENT_ID,
    AuthParameters: { REFRESH_TOKEN: CL_REFRESH_TOKEN },
  });

  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: `cognito-idp.${CL_USER_POOL_REGION}.amazonaws.com`,
        path: "/",
        method: "POST",
        family: 4,
        agent: clProxyAgent,
        headers: {
          "Content-Type": "application/x-amz-json-1.1",
          "X-Amz-Target": "AWSCognitoIdentityProviderService.InitiateAuth",
          "Content-Length": Buffer.byteLength(body).toString(),
        },
      },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            const result = json?.AuthenticationResult;
            if (!result?.IdToken) {
              console.error("Refresh failed:", JSON.stringify(json).slice(0, 300));
              resolve(false);
              return;
            }
            clTokens.authToken = result.IdToken;
            clTokens.accessToken = result.AccessToken ?? clTokens.accessToken;
            console.log(`Tokens refreshed (expires in ${result.ExpiresIn ?? "?"}s)`);
            resolve(true);
          } catch (err) {
            console.error("Refresh parse error:", err);
            resolve(false);
          }
        });
        res.on("error", (err: Error) => resolve(false));
      },
    );
    req.setTimeout(15_000, () => {
      req.destroy(new Error("Cognito refresh timeout"));
      resolve(false);
    });
    req.on("error", (err: Error) => resolve(false));
    req.write(body);
    req.end();
  });
}

// ── API fetch ────────────────────────────────────────────────────────────────

interface PaginationInfo {
  total: number;
  totalPages: number;
  currentPage: number;
  limit: number;
  hasMore: boolean;
}

function apiFetch(params: URLSearchParams): Promise<{ ok: boolean; total: number }> {
  const url = `${BASE_URL}${API_PATH}?${params.toString()}`;

  return new Promise((resolve) => {
    const parsed = new URL(url);

    const req = https.request(
      {
        hostname: parsed.hostname,
        path: parsed.pathname + parsed.search,
        method: "GET",
        family: 4,
        agent: clProxyAgent,
        headers: {
          Accept: "application/json, */*",
          "Accept-Encoding": "gzip, deflate, br",
          Authorization: `Bearer ${clTokens.authToken}`,
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Site": "same-origin",
          Referer: "https://www.creativelisting.com/deals",
          Origin: "https://www.creativelisting.com",
        },
      },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf-8");
          if (res.statusCode !== 200) {
            console.error(`  HTTP ${res.statusCode}: ${text.slice(0, 200)}`);
            resolve({ ok: false, total: 0 });
            return;
          }
          try {
            const json = JSON.parse(text);
            const pagination: PaginationInfo | undefined = json?.pagination;
            resolve({ ok: true, total: pagination?.total ?? 0 });
          } catch (err) {
            console.error("  Parse error:", err);
            resolve({ ok: false, total: 0 });
          }
        });
        res.on("error", (err: Error) => resolve({ ok: false, total: 0 }));
      },
    );

    req.setTimeout(30_000, () => {
      req.destroy(new Error("API timeout"));
      resolve({ ok: false, total: 0 });
    });
    req.on("error", (err: Error) => resolve({ ok: false, total: 0 }));
    req.end();
  });
}

// ── Count helper ─────────────────────────────────────────────────────────────

const US_STATES = [
  "AL", "AK", "AZ", "AR", "CA", "CO", "CT", "DE", "FL", "GA",
  "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME", "MD",
  "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ",
  "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC",
  "SD", "TN", "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY",
];

async function countListings(state?: string): Promise<number> {
  const params = new URLSearchParams({
    page: "1",
    limit: String(PAGE_LIMIT),
    status: "active",
    sort: "age-desc",
  });
  if (state) params.set("state", state);
  const result = await apiFetch(params);
  return result.total;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("=== CreativeListing.com listing count check ===\n");

  if (!clTokens.authToken && !CL_REFRESH_TOKEN) {
    console.error("No CL_AUTH_TOKEN / CL_REFRESH_TOKEN set.");
    process.exit(1);
  }

  if (CL_REFRESH_TOKEN) {
    console.log("Refreshing Cognito tokens…");
    const ok = await refreshCognitoTokens();
    if (!ok && !clTokens.authToken) {
      console.error("Token refresh failed and no fallback token available.");
      process.exit(1);
    }
  }

  console.log("Fetching overall total (all states)…");
  const totalAll = await countListings();
  console.log(`\n  OVERALL ACTIVE LISTINGS: ${totalAll}\n`);

  console.log("Fetching per-state counts…");
  const rows: Array<{ state: string; total: number }> = [];
  for (const state of US_STATES) {
    const total = await countListings(state);
    rows.push({ state, total });
    console.log(`  ${state}: ${total}`);
    await new Promise((r) => setTimeout(r, 150));
  }

  rows.sort((a, b) => b.total - a.total);
  const withRows = rows.filter((r) => r.total > 0);
  console.log("\n=== States with listings (sorted) ===");
  for (const r of withRows) {
    console.log(`  ${r.state}: ${r.total}`);
  }
  console.log(`\nTotal across all states: ${rows.reduce((s, r) => s + r.total, 0)}`);
  console.log(`States with listings: ${withRows.length}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);