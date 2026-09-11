// src/lib/deed-data/retry.ts
// ─────────────────────────────────────────────────────────────────────────────
// Small retry helper for transient network / DNS failures (e.g. EAI_AGAIN,
// AggregateError, ECONNRESET, timeouts, 5xx, rate-limits). 4xx client errors
// (invalid requests, auth, etc.) are NOT retried.
// ─────────────────────────────────────────────────────────────────────────────

import { logger } from "../../utils/logger";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function isRetryable(err: any): boolean {
  if (!err) return false;
  // Network-level failures: no HTTP response (DNS, connect, reset, timeout…)
  if (!err.response) return true;
  const status = err.response?.status;
  return status === 429 || (status ?? 0) >= 500;
}

export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  shouldRetry?: (err: any) => boolean;
  logLabel?: string;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {}
): Promise<T> {
  const { retries = 3, baseDelayMs = 250, logLabel = "retry" } = opts;
  const shouldRetry = opts.shouldRetry ?? isRetryable;

  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastErr = err;
      if (attempt >= retries || !shouldRetry(err)) throw err;
      const delay = baseDelayMs * Math.pow(2, attempt);
      logger.warn(`[${logLabel}] transient error (attempt ${attempt + 1}/${retries}), retrying in ${delay}ms: ${err.name || err.message || err}`);
      await sleep(delay);
    }
  }
  throw lastErr;
}