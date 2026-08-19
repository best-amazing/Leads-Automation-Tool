// src/scrapers/property-purchase-research/run-adu-research-cron.ts
// ─────────────────────────────────────────────────────────────────────────────
// Long-lived scheduler for the ADU research scraper.
//
// Deploy as a background worker (e.g. Render worker service) — no HTTP port
// needed. It runs the scraper immediately on boot, then again on a cron
// schedule. All logs go to stdout so the host's log terminal shows them live.
//
// Env:
//   ADU_CRON_SCHEDULE  cron expression (default: every 6 hours)
//   ADU_CRON_TIMEZONE  IANA timezone       (default: Africa/Lagos)
// ─────────────────────────────────────────────────────────────────────────────

import "dotenv/config";
import { CronJob } from "cron";
import { logger } from "../../utils/logger";
import { runAduResearch } from "./run-adu-research";

const SCHEDULE = process.env.ADU_CRON_SCHEDULE || "*/10 * * * *";
const TIMEZONE = process.env.ADU_CRON_TIMEZONE || "Africa/Lagos";

// Guard against overlapping runs — a single batch can take hours.
let running = false;

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
      logger.info(
        `[adu-cron] ADU research run completed in ${Math.round((Date.now() - start) / 60000)} min`
      );
    } catch (err) {
      logger.error(`[adu-cron] ADU research run failed: ${err instanceof Error ? err.message : err}`);
    } finally {
      running = false;
      if (global.gc) global.gc();
    }
  },
  null,
  true, // run immediately on boot, then on schedule
  TIMEZONE
);

logger.info(`[adu-cron] Scheduler started — schedule "${SCHEDULE}" (${TIMEZONE}), first run now.`);