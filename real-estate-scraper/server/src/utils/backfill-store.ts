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
import { Prisma } from "@prisma/client";
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

export interface ResumeCursor {
  // Which market (index into the source's market list) to resume at.
  marketIndex: number;
  // Which phase within the market to resume at:
  //   0 = active (GIS JSON), 1 = contingent (CSV), 2 = sold (CSV)
  phaseIndex: number;
  // Next 0-based pagination offset for the current market+phase.
  start: number;
  // True when the full sweep finished — the next run should restart from the
  // top (page 0) to catch newly listed homes, not continue the exhausted walk.
  complete: boolean;
}

export async function loadResumeCursor(source: string): Promise<ResumeCursor | null> {
  try {
    const row = await prisma.backfillCursor.findUnique({ where: { source } });
    const c = row?.resumeCursor;
    if (!c || typeof c !== "object") return null;
    const cur = c as Partial<ResumeCursor>;
    if (typeof cur.marketIndex !== "number" || typeof cur.phaseIndex !== "number" ||
        typeof cur.start !== "number") {
      return null;
    }
    return {
      marketIndex: cur.marketIndex,
      phaseIndex: cur.phaseIndex,
      start: cur.start,
      complete: cur.complete === true,
    };
  } catch (err) {
    logger.warn(`[${source}] Could not load resume cursor from DB: ${err}`);
    return null;
  }
}

export async function saveResumeCursor(
  source: string,
  cursor: ResumeCursor
): Promise<void> {
  try {
    await prisma.backfillCursor.upsert({
      where: { source },
      create: {
        source,
        seenIds: [],
        processedCount: 0,
        resumeCursor: cursor as unknown as Prisma.JsonValue,
        lastRunAt: new Date(),
      },
      update: {
        resumeCursor: cursor as unknown as Prisma.JsonValue,
        lastRunAt: new Date(),
      },
    });
    logger.info(
      `[${source}] Saved resume cursor → market=${cursor.marketIndex} ` +
      `phase=${cursor.phaseIndex} start=${cursor.start}` +
      (cursor.complete ? " (sweep complete — next run restarts at top)" : "")
    );
  } catch (err) {
    logger.warn(`[${source}] Could not save resume cursor to DB: ${err}`);
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