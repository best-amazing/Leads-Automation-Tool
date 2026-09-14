import * as https from "https";
import * as http from "http";
import * as zlib from "zlib";

import { logger } from "../../utils/logger";
import { sleep } from "../../utils/browser";

const OXYLABS_ENDPOINT = "realtime.oxylabs.io";
const OXYLABS_PATH = "/v1/queries";
const OXYLABS_USERNAME = process.env.OXYLABS_USERNAME ?? "";
const OXYLABS_PASSWORD = process.env.OXYLABS_PASSWORD ?? "";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_RETRIES = 3;

interface OxylabsPayload {
  source: string;
  url: string;
  render: string;
  geo_location: string;
  user_agent_type: string;
  session_id?: string;
}

interface OxylabsResponse {
  results: Array<{
    content: string;
    status_code: number;
    url: string;
    job_id: string;
  }>;
}

interface OxylabsResult {
  html: string | null;
  rateLimited: boolean;
}

interface OxylabsFetchOptions {
  loggerScope?: string;
  sessionId?: string;
  maxRetries?: number;
  requestTimeoutMs?: number;
}

const oxylabsScopeCooldownUntil = new Map<string, number>();

export function markOxylabsRateLimited(
  loggerScope: string,
  attempt: number,
  _targetUrl?: string,
): number {
  const baseDelayMs = Math.min(30_000 * Math.pow(2, attempt - 1), 300_000);
  const delayMs = Math.max(baseDelayMs, 60_000);
  const until = Date.now() + delayMs;
  oxylabsScopeCooldownUntil.set(loggerScope, until);
  return delayMs;
}

export function getOxylabsCooldownRemainingMs(loggerScope: string): number {
  const until = oxylabsScopeCooldownUntil.get(loggerScope) ?? 0;
  return Math.max(0, until - Date.now());
}

function retryDelayMs(attempt: number): number {
  return Math.min(
    8_000 * Math.pow(2, attempt - 1) + Math.random() * 4_000,
    45_000,
  );
}

function oxylabsFetchOnce(
  targetUrl: string,
  loggerScope: string,
  requestTimeoutMs: number,
  sessionId?: string,
): Promise<OxylabsResult> {
  return new Promise((resolve) => {
    const scope = `[${loggerScope}]`;

    if (!OXYLABS_USERNAME || !OXYLABS_PASSWORD) {
      logger.error(
        `${scope} Oxylabs credentials missing — add to .env:\n` +
          `${scope}   OXYLABS_USERNAME=your_api_user\n` +
          `${scope}   OXYLABS_PASSWORD=your_api_password`,
      );
      resolve({ html: null, rateLimited: false });
      return;
    }

    let settled = false;
    function settle(html: string | null, rateLimited = false) {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve({ html, rateLimited });
    }

    const payload: OxylabsPayload = {
      source: "universal",
      url: targetUrl,
      render: "html",
      geo_location: "United States",
      user_agent_type: "desktop",
      ...(sessionId ? { session_id: sessionId } : {}),
    };

    const bodyStr = JSON.stringify(payload);
    const authStr = Buffer.from(
      `${OXYLABS_USERNAME}:${OXYLABS_PASSWORD}`,
    ).toString("base64");

    const DEADLINE_MS = requestTimeoutMs + 30_000;
    const deadline = setTimeout(() => {
      logger.warn(
        `${scope} Oxylabs deadline exceeded (${DEADLINE_MS / 1_000}s) — aborting`,
      );
      try {
        req.destroy();
      } catch {}
      settle(null);
    }, DEADLINE_MS);

    const req = https.request(
      {
        hostname: OXYLABS_ENDPOINT,
        path: OXYLABS_PATH,
        method: "POST",
        family: 4,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Basic ${authStr}`,
          "Content-Length": Buffer.byteLength(bodyStr).toString(),
        },
      },
      (res: http.IncomingMessage) => {
        const enc = (res.headers["content-encoding"] ?? "").toLowerCase();
        logger.debug(
          `${scope} [sock] response headers — status=${res.statusCode ?? 0} ` +
            `enc=${enc || "identity"} content-length=${res.headers["content-length"] ?? "?"}`,
        );
        const chunks: Buffer[] = [];
        const stream =
          enc === "gzip"
            ? res.pipe(zlib.createGunzip())
            : enc === "deflate"
              ? res.pipe(zlib.createInflate())
              : enc === "br"
                ? res.pipe(zlib.createBrotliDecompress())
                : (res as any);

        let chunkCount = 0;
        let totalBytes = 0;
        (stream as NodeJS.ReadableStream).on("data", (c: Buffer) => {
          chunks.push(c);
          chunkCount++;
          totalBytes += c.length;
          if (chunkCount === 1 || chunkCount % 100 === 0) {
            logger.debug(
              `${scope} [sock] chunk #${chunkCount} (+${c.length} B, total ${totalBytes} B)`,
            );
          }
        });
        (stream as NodeJS.ReadableStream).on("end", () => {
          logger.debug(`${scope} [sock] end — total ${totalBytes} B`);
          const raw = Buffer.concat(chunks).toString("utf-8");
          const status = res.statusCode ?? 0;

          if (status === 401) {
            logger.error(`${scope} Oxylabs 401 — bad credentials`);
            settle(null);
            return;
          }
          if (status === 429) {
            logger.warn(`${scope} Oxylabs 429 — rate limited`);
            settle(null, true);
            return;
          }
          if (status !== 200) {
            logger.warn(`${scope} Oxylabs HTTP ${status}`);
            logger.debug(`${scope} Body snippet: ${raw.slice(0, 300)}`);
            settle(null);
            return;
          }

          let parsed: OxylabsResponse;
          try {
            parsed = JSON.parse(raw);
          } catch {
            logger.warn(`${scope} Could not parse Oxylabs envelope`);
            settle(null);
            return;
          }

          const result = parsed?.results?.[0];
          const content = result?.content ?? "";
          const innerStatus = result?.status_code ?? 0;

          if (innerStatus === 403 || innerStatus === 429) {
            logger.warn(
              `${scope} ${loggerScope} HTTP ${innerStatus} via Oxylabs`,
            );
            settle(null, true);
            return;
          }
          if (!content || content.length < 5_000) {
            logger.warn(
              `${scope} Short content (${content.length} chars) — possible block`,
            );
            settle(null);
            return;
          }

          logger.debug(
            `${scope} Oxylabs OK — ${content.length} chars, inner ${innerStatus}`,
          );
          settle(content);
        });

        (stream as NodeJS.ReadableStream).on("error", (err: any) => {
          logger.warn(`${scope} Stream error: ${err.message}`);
          settle(null);
        });
      },
    );

    req.setTimeout(requestTimeoutMs, () => {
      logger.warn(
        `${scope} Oxylabs timed out after ${requestTimeoutMs / 1_000}s`,
      );
      try {
        req.destroy();
      } catch {}
      settle(null);
    });

    req.on("error", (err: any) => {
      logger.error(
        `${scope} Request error: [${err.code ?? "?"}] ${err.message}`,
      );
      settle(null);
    });

    req.on("close", () => {
      logger.debug(`${scope} [sock] close`);
      settle(null);
    });

    req.write(bodyStr);
    req.end();
    logger.debug(`${scope} [sock] request sent — ${targetUrl}`);
  });
}

export async function oxylabsFetch(
  targetUrl: string,
  options: OxylabsFetchOptions = {},
): Promise<string | null> {
  const {
    loggerScope = "zillow",
    sessionId,
    maxRetries = DEFAULT_MAX_RETRIES,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  } = options;

  const activeCooldownMs = getOxylabsCooldownRemainingMs(loggerScope);
  if (activeCooldownMs > 0) {
    logger.warn(
      `[${loggerScope}] Oxylabs cooldown active for ${Math.ceil(activeCooldownMs / 1000)}s — skipping ${targetUrl.slice(0, 80)}`,
    );
    return null;
  }

  let currentSessionId = sessionId;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const { html, rateLimited } = await oxylabsFetchOnce(
      targetUrl,
      loggerScope,
      requestTimeoutMs,
      currentSessionId,
    );

    if (html !== null) return html;
    if (!rateLimited) return null;

    const cooldownMs = markOxylabsRateLimited(loggerScope, attempt, targetUrl);

    if (attempt < maxRetries) {
      const delay = Math.max(retryDelayMs(attempt), cooldownMs);
      if (currentSessionId) {
        currentSessionId = `${loggerScope}_${Date.now()}_${Math.floor(
          Math.random() * 9_999,
        )}`;
        logger.info(
          `[${loggerScope}] 429 retry ${attempt}/${maxRetries} — rotating session ID to ${currentSessionId} and waiting ${Math.round(delay / 1_000)}s`,
        );
      } else {
        logger.warn(
          `[${loggerScope}] 429 retry ${attempt}/${maxRetries} — waiting ${Math.round(delay / 1_000)}s`,
        );
      }
      await sleep(delay);
    } else {
      logger.warn(
        `[${loggerScope}] 429 — all ${maxRetries} retries exhausted for ${targetUrl.slice(0, 80)}`,
      );
      logger.warn(
        `[${loggerScope}] applying 2-minute cooldown before retrying any more Oxylabs requests`,
      );
    }
  }
  return null;
}
