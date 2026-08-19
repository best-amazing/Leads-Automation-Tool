// src/scrapers/property-purchase-research/run-adu-research-cron.ts
// ─────────────────────────────────────────────────────────────────────────────
// Long-lived watchdog for the ADU research scraper.
//
// Deploy as a background worker (e.g. Render worker service) — no HTTP port
// needed. It runs the scraper immediately on boot, then checks every
// ADU_CRON_SCHEDULE (default: every 10 minutes) whether a run is already in
// progress. If idle, it starts a new run — so new listings are caught within
// minutes and the worker stays perpetually active. All logs go to stdout so
// the host's log terminal shows them live.
//
// Env:
//   ADU_CRON_SCHEDULE  cron expression (default: every 10 minutes)
//   ADU_CRON_TIMEZONE  IANA timezone       (default: Africa/Lagos)
//   ADU_ALERT_NTFY_TOPIC   ntfy.sh topic for phone push on failure (e.g. my-adu-scraper)
//   ADU_ALERT_WEBHOOK_URL  alternative generic webhook (Slack/Discord-style)
//   ADU_ALERT_ON_SUCCESS   "true" to also notify on successful runs (default: off)
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { CronJob } from "cron";
import axios from "axios";
import { logger } from "../../utils/logger";
import { runAduResearch } from "./run-adu-research";

const SCHEDULE = process.env.ADU_CRON_SCHEDULE || "*/10 * * * *";
const TIMEZONE = process.env.ADU_CRON_TIMEZONE || "Africa/Lagos";

// Fire-and-forget alert so a slow/blocked notification never stalls the run.
function sendAlert(message: string): void {
  const ntfyTopic = process.env.ADU_ALERT_NTFY_TOPIC;
  const webhook = process.env.ADU_ALERT_WEBHOOK_URL;

  const req = ntfyTopic
    ? axios.post(`https://ntfy.sh/${ntfyTopic}`, message, {
        headers: { Title: "ADU Scraper" },
        timeout: 10_000,
      })
    : webhook
      ? axios.post(webhook, { text: message }, { timeout: 10_000 })
      : null;

  if (req) {
    req.catch((err: any) => {
      logger.warn(`[adu-cron] Failed to send alert: ${err instanceof Error ? err.message : err}`);
    });
  }
}

// Guard against overlapping runs — a single batch can take hours.
let running = false;
let watchdogStarted = false;

export function startAduWatchdog(): void {
  if (watchdogStarted) return;
  watchdogStarted = true;

  const job = new CronJob(
    SCHEDULE,
    async () => {
      if (running) {
        logger.info("[adu-cron] Previous run still in progress — skipping this tick.");
        return;
      }

      running = true;
      const start = Date.now();
      logger.info("[adu-cron] Starting ADU research run...");

      try {
        await runAduResearch();
        const mins = Math.round((Date.now() - start) / 60000);
        logger.info(`[adu-cron] ADU research run completed in ${mins} min`);
        if (process.env.ADU_ALERT_ON_SUCCESS === "true") {
          sendAlert(`ADU research run completed in ${mins} min`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`[adu-cron] ADU research run failed: ${msg}`);
        sendAlert(`ADU research run FAILED: ${msg}`);
      } finally {
        running = false;
        if (global.gc) global.gc();
      }
    },
    null,        // onComplete
    true,        // start immediately
    TIMEZONE,    // timeZone
    undefined,   // context
    true         // runOnInit — first run now, then on schedule
  );

  logger.info(`[adu-cron] Watchdog started — schedule "${SCHEDULE}" (${TIMEZONE}), first run now.`);
}

// ── Direct execution ────────────────────────────────────────────────────────
// When run as the cron worker entry point, start immediately. When imported by
// the web server (src/server.ts) the watchdog runs inside that process instead
// — this is how the free-tier Web Service hosts the cron without a paid worker.
if (require.main === module) {
  startAduWatchdog();
}