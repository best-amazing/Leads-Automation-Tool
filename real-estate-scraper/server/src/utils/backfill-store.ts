// src/utils/backfill-store.ts
// ─────────────────────────────────────────────────────────────────────────────
// DB-backed backfill cursor store.
//
// Replaces the ephemeral logs/*_backfill_cursor.json + logs/backfill_audit.json
// files. One row per source in the BackfillCursor table:
//   - seenIds:        listing URLs/IDs already processed by the backfill walk
//   - processedCount: count processed in the most recent batch — runContinuous()
//                     reads this to decide whether to fetch the next batch
//
// Storing this in Postgres means progress survives redeploys (Render's disk is
// ephemeral) and is shared across multiple worker instances.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/client";
import { logger } from "./logger";

export async function loadSeenListings(source: string): Promise<Set<string>> {
  try {
    const row = await prisma.backfillCursor.findUnique({ where: { source } });
    if (!row) return new Set();
    const ids = Array.isArray(row.seenIds) ? (row.seenIds as string[]) : [];
    logger.info(
      `[${source}] Loaded ${ids.length} previously seen listing IDs from DB (last run: ${row.lastRunAt.toISOString()})`
    );
    return new Set(ids);
  } catch (err) {
    logger.warn(`[${source}] Could not load seen listings from DB: ${err}`);
    return new Set();
  }
}

export async function saveSeenListings(
  source: string,
  ids: Set<string>,
  processedCount: number
): Promise<void> {
  try {
    const seenIds = Array.from(ids);
    await prisma.backfillCursor.upsert({
      where: { source },
      create: {
        source,
        seenIds,
        processedCount,
        lastRunAt: new Date(),
      },
      update: {
        seenIds,
        processedCount,
        lastRunAt: new Date(),
      },
    });
    logger.info(
      `[${source}] Saved ${seenIds.length} seen listing IDs to DB (batch processed: ${processedCount})`
    );
  } catch (err) {
    logger.warn(`[${source}] Could not save seen listings to DB: ${err}`);
  }
}

export async function getLastBackfillStatus(
  source: string
): Promise<{ processedCount: number; lastRunAt: Date | null }> {
  try {
    const row = await prisma.backfillCursor.findUnique({ where: { source } });
    return {
      processedCount: row?.processedCount ?? 0,
      lastRunAt: row?.lastRunAt ?? null,
    };
  } catch (err) {
    logger.warn(`[${source}] Could not read backfill status from DB: ${err}`);
    return { processedCount: 0, lastRunAt: null };
  }
}