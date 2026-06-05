#!/usr/bin/env ts-node
// debug-realtor-proxy.ts (v4)
//
// Tests the Realtor.com autocomplete endpoint in four modes:
//
//   A. HTTP forward proxy  (absolute URI — only works for plain HTTP targets)
//   B. axios + HttpsProxyAgent  (uses CONNECT internally)
//   C. Raw CONNECT tunnel  (same transport the enricher uses — most reliable)
//   D. Direct (no proxy)   (baseline — confirms endpoint is reachable at all)
//
// Run:
//   npx ts-node debug-realtor-proxy.ts
//
// Expected pass conditions:
//   Mode A will ALWAYS fail for HTTPS targets — it's only here for reference.
//   Mode C and D are the authoritative tests.

import * as http from "http";
import * as https from "https";
import * as tls from "tls";
import * as zlib from "zlib";
import dotenv from "dotenv";
dotenv.config();

// ── Credentials & cookies ─────────────────────────────────────────────────────

const SESSION_COOKIE = process.env.REALTOR_SESSION_COOKIE ?? "";
const KP_UIDZ = process.env.REALTOR_KP_UIDZ ?? "";
const KP_UIDZ_SSN = process.env.REALTOR_KP_UIDZ_SSN ?? "";

const COOKIE =
  SESSION_COOKIE ||
  [KP_UIDZ && `KP_UIDz=${KP_UIDZ}`, KP_UIDZ_SSN && `KP_UIDz-ssn=${KP_UIDZ_SSN}`]
    .filter(Boolean)
    .join("; ");

// ── Proxy config (reads from env, not hardcoded) ──────────────────────────────

const RAW_PROXY = (process.env.PROXY_URLS ?? process.env.PROXY_URL ?? "")
  .split(",")[0]
  .trim();
const parsedProxy = RAW_PROXY
  ? (() => {
      try {
        return new URL(RAW_PROXY);
      } catch {
        return null;
      }
    })()
  : null;

const PROXY_HOST = parsedProxy?.hostname ?? "";
const PROXY_PORT = parseInt(parsedProxy?.port || "80", 10);
const PROXY_USER = parsedProxy ? decodeURIComponent(parsedProxy.username) : "";
const PROXY_PASS = parsedProxy ? decodeURIComponent(parsedProxy.password) : "";
const PROXY_AUTH =
  PROXY_USER && PROXY_PASS
    ? Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString("base64")
    : "";

// ── Target ────────────────────────────────────────────────────────────────────

const TARGET_HOST = "www.realtor.com";
const TARGET_PATH =
  "/api/v1/hulk_lookup/autocomplete?input=1925+Buhrer+Ave+Cleveland+OH&client_id=rdc-x&schema=homes";
const TARGET_URL = `https://${TARGET_HOST}${TARGET_PATH}`;

const REQUEST_HEADERS: Record<string, string> = {
  Accept: "application/json, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  Referer: "https://www.realtor.com/",
  "rdc-client-name": "RDC_WEB_DETAILS_PAGE",
  "rdc-client-version": "2.858.0",
  "x-is-bot": "false",
  ...(COOKIE ? { Cookie: COOKIE } : {}),
};

const TIMEOUT_MS = 15_000;

type TestResult = { status: number | null; body: string; error?: string };

// ── Mode A: HTTP forward proxy ────────────────────────────────────────────────
//
// Sends the absolute HTTPS URL as the request path.
// Proxies cannot decrypt HTTPS in this mode — expect 404 or 400 from the proxy.
// Only included to show WHY this doesn't work for HTTPS.

async function testModeA(): Promise<TestResult> {
  if (!PROXY_HOST)
    return { status: null, body: "", error: "no proxy configured" };

  return new Promise((resolve) => {
    const headers: Record<string, string> = {
      Host: TARGET_HOST,
      ...REQUEST_HEADERS,
    };
    if (PROXY_AUTH) headers["Proxy-Authorization"] = `Basic ${PROXY_AUTH}`;

    const req = http.request(
      {
        host: PROXY_HOST,
        port: PROXY_PORT,
        method: "GET",
        path: TARGET_URL,
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (d) => (body += d));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? null, body: body.slice(0, 300) }),
        );
      },
    );
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      resolve({ status: null, body: "", error: "timeout" });
    });
    req.on("error", (e) =>
      resolve({ status: null, body: "", error: e.message }),
    );
    req.end();
  });
}

// ── Mode B: axios + HttpsProxyAgent ──────────────────────────────────────────

async function testModeB(): Promise<TestResult> {
  if (!PROXY_HOST)
    return { status: null, body: "", error: "no proxy configured" };

  let axios: any, HttpsProxyAgent: any;
  try {
    axios = (await import("axios")).default;
    HttpsProxyAgent = (await import("https-proxy-agent")).HttpsProxyAgent;
  } catch {
    return {
      status: null,
      body: "",
      error: "run: npm install axios https-proxy-agent",
    };
  }

  try {
    const proxyUrl = `http://${PROXY_USER}:${PROXY_PASS}@${PROXY_HOST}:${PROXY_PORT}`;
    const resp = await axios.get(TARGET_URL, {
      httpsAgent: new HttpsProxyAgent(proxyUrl),
      proxy: false,
      timeout: TIMEOUT_MS,
      validateStatus: () => true,
      decompress: true,
      headers: REQUEST_HEADERS,
    });
    const body =
      typeof resp.data === "object"
        ? JSON.stringify(resp.data).slice(0, 300)
        : String(resp.data).slice(0, 300);
    return { status: resp.status, body };
  } catch (e: any) {
    return { status: null, body: "", error: e.message };
  }
}

// ── Mode C: Raw CONNECT tunnel (same transport the enricher uses) ─────────────
//
// This is the definitive test.  The enricher's httpsViaProxy() does exactly
// this.  If this passes, the proxy works correctly.

async function decompressBuffer(buf: Buffer, enc: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const e = enc.toLowerCase().trim();
    if (e === "gzip" || e === "x-gzip") {
      zlib.gunzip(buf, (err, r) =>
        err ? reject(err) : resolve(r.toString("utf-8")),
      );
    } else if (e === "br") {
      zlib.brotliDecompress(buf, (err, r) =>
        err ? reject(err) : resolve(r.toString("utf-8")),
      );
    } else if (e === "deflate") {
      zlib.inflate(buf, (err, r) =>
        err ? reject(err) : resolve(r.toString("utf-8")),
      );
    } else {
      resolve(buf.toString("utf-8"));
    }
  });
}

async function testModeC(): Promise<TestResult> {
  if (!PROXY_HOST)
    return { status: null, body: "", error: "no proxy configured" };

  return new Promise((resolve) => {
    const connectHeaders: Record<string, string> = {
      Host: `${TARGET_HOST}:443`,
      "User-Agent": "Mozilla/5.0",
    };
    if (PROXY_AUTH)
      connectHeaders["Proxy-Authorization"] = `Basic ${PROXY_AUTH}`;

    const connectReq = http.request({
      host: PROXY_HOST,
      port: PROXY_PORT,
      method: "CONNECT",
      path: `${TARGET_HOST}:443`,
      headers: connectHeaders,
    });

    const connectTimer = setTimeout(() => {
      connectReq.destroy();
      resolve({
        status: null,
        body: "",
        error: `CONNECT timeout after ${TIMEOUT_MS}ms`,
      });
    }, TIMEOUT_MS);

    connectReq.on("error", (err: any) => {
      clearTimeout(connectTimer);
      resolve({
        status: null,
        body: "",
        error: `CONNECT error: ${err.message}`,
      });
    });

    connectReq.on("connect", (res: any, socket: any) => {
      clearTimeout(connectTimer);

      if (res.statusCode !== 200) {
        socket.destroy();
        resolve({
          status: res.statusCode,
          body: "",
          error: `Proxy CONNECT rejected HTTP ${res.statusCode} — check credentials`,
        });
        return;
      }

      const tlsSocket = tls.connect({
        host: TARGET_HOST,
        socket,
        servername: TARGET_HOST,
        rejectUnauthorized: true,
      });

      const dataTimer = setTimeout(() => {
        tlsSocket.destroy();
        resolve({
          status: null,
          body: "",
          error: `TLS request timeout after ${TIMEOUT_MS}ms`,
        });
      }, TIMEOUT_MS);

      tlsSocket.on("error", (err: any) => {
        clearTimeout(dataTimer);
        resolve({ status: null, body: "", error: `TLS error: ${err.message}` });
      });

      tlsSocket.on("secureConnect", () => {
        const reqLine =
          `GET ${TARGET_PATH} HTTP/1.1\r\n` +
          `Host: ${TARGET_HOST}\r\n` +
          `Connection: close\r\n` +
          Object.entries(REQUEST_HEADERS)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n";

        tlsSocket.write(reqLine);

        const chunks: Buffer[] = [];
        tlsSocket.on("data", (c: Buffer) => chunks.push(c));
        tlsSocket.on("end", async () => {
          clearTimeout(dataTimer);
          try {
            const raw = Buffer.concat(chunks).toString("binary");
            const headerEnd = raw.indexOf("\r\n\r\n");
            if (headerEnd === -1) {
              resolve({
                status: null,
                body: "",
                error: "no HTTP header boundary",
              });
              return;
            }

            const headerSection = raw.slice(0, headerEnd);
            const statusMatch = headerSection.match(/^HTTP\/\d\.?\d? (\d+)/);
            const status = statusMatch ? parseInt(statusMatch[1], 10) : 0;

            let rawBody = raw.slice(headerEnd + 4);
            if (/transfer-encoding:\s*chunked/i.test(headerSection)) {
              let result = "",
                rem = rawBody;
              while (rem.length > 0) {
                const crlf = rem.indexOf("\r\n");
                if (crlf === -1) break;
                const sz = parseInt(rem.slice(0, crlf), 16);
                if (isNaN(sz) || sz === 0) break;
                result += rem.slice(crlf + 2, crlf + 2 + sz);
                rem = rem.slice(crlf + 2 + sz + 2);
              }
              rawBody = result;
            }

            const encMatch = headerSection.match(/content-encoding:\s*(\S+)/i);
            const enc = encMatch?.[1]?.trim() ?? "";
            let body: string;
            if (enc) {
              body = await decompressBuffer(
                Buffer.from(rawBody, "binary"),
                enc,
              );
            } else {
              body = Buffer.from(rawBody, "binary").toString("utf-8");
            }

            resolve({ status, body: body.slice(0, 300) });
          } catch (e: any) {
            resolve({
              status: null,
              body: "",
              error: `Parse error: ${e.message}`,
            });
          }
        });
      });
    });

    connectReq.end();
  });
}

// ── Mode D: Direct (no proxy) ─────────────────────────────────────────────────
//
// Confirms the endpoint is reachable at all and what it returns without a proxy.
// If this passes but Mode C fails, the issue is the proxy.
// If both fail, the endpoint or cookies are the problem.

async function testModeDirect(): Promise<TestResult> {
  return new Promise((resolve) => {
    const req = https.request(
      {
        hostname: TARGET_HOST,
        path: TARGET_PATH,
        method: "GET",
        family: 4,
        headers: REQUEST_HEADERS,
      },
      (res: http.IncomingMessage) => {
        const chunks: Buffer[] = [];
        const enc = (res.headers["content-encoding"] ?? "").trim();
        const stream: NodeJS.ReadableStream =
          enc === "gzip"
            ? res.pipe(zlib.createGunzip())
            : enc === "deflate"
              ? res.pipe(zlib.createInflate())
              : enc === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : (res as any);
        stream.on("data", (c: Buffer) => chunks.push(c));
        stream.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf-8").slice(0, 300),
          }),
        );
        stream.on("error", (e: any) =>
          resolve({ status: null, body: "", error: e.message }),
        );
      },
    );
    req.setTimeout(TIMEOUT_MS, () => {
      req.destroy();
      resolve({ status: null, body: "", error: "timeout" });
    });
    req.on("error", (e: any) =>
      resolve({ status: null, body: "", error: e.message }),
    );
    req.end();
  });
}

// ── Formatter ─────────────────────────────────────────────────────────────────

function printResult(label: string, r: TestResult): void {
  process.stdout.write(`  [${label.padEnd(14)}] `);
  if (r.error) {
    console.log(`✗ ${r.error}`);
    return;
  }
  const icon = r.status === 200 ? "✅" : "✗";
  const bodyPreview = r.body.replace(/\n/g, " ").slice(0, 120);
  console.log(`${icon} HTTP ${r.status} — ${bodyPreview}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n════════════════════════════════════════════════════════════");
  console.log("  Realtor.com — Proxy Debug v4");
  console.log("════════════════════════════════════════════════════════════\n");

  if (parsedProxy) {
    console.log(`Proxy : ${PROXY_HOST}:${PROXY_PORT}`);
    console.log(`User  : ${PROXY_USER ? PROXY_USER : "✗ missing"}`);
    console.log(`Pass  : ${PROXY_PASS ? "✓ (set)" : "✗ missing"}`);
  } else {
    console.log(`Proxy : ✗ not configured (PROXY_URLS / PROXY_URL not set)`);
  }
  console.log(`Cookie: ${COOKIE ? `✓ (${COOKIE.length} chars)` : "✗ not set"}`);
  console.log(`Target: ${TARGET_URL}\n`);

  console.log("── Mode A: HTTP forward proxy (expected FAIL for HTTPS)");
  printResult("HTTP forward", await testModeA());
  console.log(
    "   ↑ Expected: proxy returns 4xx because it can't decrypt HTTPS in forward mode\n",
  );

  console.log("── Mode B: axios + HttpsProxyAgent");
  printResult("axios+agent", await testModeB());
  console.log("");

  console.log(
    "── Mode C: Raw CONNECT tunnel (enricher transport — definitive test)",
  );
  printResult("CONNECT tunnel", await testModeC());
  console.log("");

  console.log("── Mode D: Direct connection (no proxy — baseline)");
  printResult("direct", await testModeDirect());
  console.log("");

  console.log("════════════════════════════════════════════════════════════");
  console.log("Diagnosis guide:");
  console.log("  C=✅ D=✅  → Proxy works. Enricher will work.");
  console.log("  C=✗  D=✅  → Proxy broken. Check proxy plan / credentials.");
  console.log("  C=✗  D=✗   → Endpoint issue (cookies, Kasada, IP block).");
  console.log("  C=✅ D=403  → Proxy bypasses IP block. Good — use it.");
  console.log(
    "  All 404    → Endpoint path changed or IP is datacenter-blocked.",
  );
  console.log("════════════════════════════════════════════════════════════\n");
}

main().catch(console.error);
