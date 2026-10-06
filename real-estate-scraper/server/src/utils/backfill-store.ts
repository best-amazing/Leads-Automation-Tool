// src/utils/backfill-store.ts
// ─────────────────────────────────────────────────────────────────────────────
// DB-backed backfill cursor store.
//
// Replaces the ephemeral logs/*_backfill_cursor.json + logs/backfill_audit.json
// files. Per source:
//   - BackfillSeenId rows: listing URLs/IDs already processed by the backfill
//                     walk, one row each (insert-only)
//   - BackfillCursor row: processedCount (count processed in the most recent
//                     batch — runContinuous() reads this to decide whether to
//                     fetch the next batch), lastRunAt and resumeCursor
//
// Seen IDs used to live in BackfillCursor.seenIds as one JSON array that was
// loaded and rewritten whole on every batch (188k+ IDs / 5 MB for Coldwell
// Banker) — a major memory spike on the 512 MB Render instance. That column is
// now legacy: any IDs still in it are moved into rows on first load.
//
// Storing this in Postgres means progress survives redeploys (Render's disk is
// ephemeral) and is shared across multiple worker instances.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/client";
import { Prisma } from "@prisma/client";
import { logger } from "./logger";

const INSERT_CHUNK = 5_000;
const LOOKUP_CHUNK = 1_000;

// Seen set handed out by loadSeenListings, per source, so saveSeenListings
// only inserts the IDs added since (instead of re-sending the whole set).
const loadedSnapshots = new Map<string, Set<string>>();
const migratedSources = new Set<string>();

/**
 * Moves any IDs still in the legacy BackfillCursor.seenIds JSON array into
 * BackfillSeenId rows, then empties the array. Runs entirely inside Postgres
 * (no IDs pass through Node), once per source per process.
 */
async function migrateLegacySeenIds(source: string): Promise<void> {
  if (migratedSources.has(source)) return;
  await prisma.$transaction([
    prisma.$executeRaw`
      INSERT INTO "BackfillSeenId" ("source", "listingId")
      SELECT DISTINCT c."source", ids.value
      FROM "BackfillCursor" c
      CROSS JOIN LATERAL jsonb_array_elements_text(c."seenIds") AS ids(value)
      WHERE c."source" = ${source}
        AND jsonb_typeof(c."seenIds") = 'array'
        AND jsonb_array_length(c."seenIds") > 0
      ON CONFLICT DO NOTHING`,
    prisma.$executeRaw`
      UPDATE "BackfillCursor" SET "seenIds" = '[]'::jsonb
      WHERE "source" = ${source} AND "seenIds" <> '[]'::jsonb`,
  ]);
  migratedSources.add(source);
}

export async function loadSeenListings(source: string): Promise<Set<string>> {
  try {
    await migrateLegacySeenIds(source);
    const rows = await prisma.backfillSeenId.findMany({
      where: { source },
      select: { listingId: true },
    });
    const ids = new Set(rows.map((r) => r.listingId));
    loadedSnapshots.set(source, ids);
    logger.info(`[${source}] Loaded ${ids.size} previously seen listing IDs from DB`);
    return ids;
  } catch (err) {
    logger.warn(`[${source}] Could not load seen listings from DB: ${err}`);
    return new Set();
  }
}

/**
 * Persists the seen set and batch status. Only IDs not present in the set
 * returned by the last loadSeenListings(source) are inserted.
 */
export async function saveSeenListings(
  source: string,
  ids: Set<string>,
  processedCount: number
): Promise<void> {
  try {
    const base = loadedSnapshots.get(source);
    const fresh = base ? [...ids].filter((id) => !base.has(id)) : [...ids];
    await markSeenIds(source, fresh);
    await saveBackfillStatus(source, processedCount);
    loadedSnapshots.delete(source);
    logger.info(
      `[${source}] Saved ${fresh.length} new seen listing ID(s) to DB (batch processed: ${processedCount})`
    );
  } catch (err) {
    logger.warn(`[${source}] Could not save seen listings to DB: ${err}`);
  }
}

/**
 * Returns the IDs from `ids` that have NOT been seen for `source`, checking
 * only those IDs (the full seen set is never loaded). Throws on DB errors so
 * callers don't mistake an outage for "everything is unseen".
 */
export async function filterUnseenIds(
  source: string,
  ids: string[]
): Promise<string[]> {
  await migrateLegacySeenIds(source);
  const unique = [...new Set(ids)];
  const seen = new Set<string>();
  for (let i = 0; i < unique.length; i += LOOKUP_CHUNK) {
    const rows = await prisma.backfillSeenId.findMany({
      where: { source, listingId: { in: unique.slice(i, i + LOOKUP_CHUNK) } },
      select: { listingId: true },
    });
    for (const r of rows) seen.add(r.listingId);
  }
  return unique.filter((id) => !seen.has(id));
}

/** Records IDs as seen for `source` (idempotent). */
export async function markSeenIds(source: string, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += INSERT_CHUNK) {
    await prisma.backfillSeenId.createMany({
      data: ids.slice(i, i + INSERT_CHUNK).map((listingId) => ({ source, listingId })),
      skipDuplicates: true,
    });
  }
}

/** Records the most recent batch size (read back by getLastBackfillStatus). */
export async function saveBackfillStatus(
  source: string,
  processedCount: number
): Promise<void> {
  await prisma.backfillCursor.upsert({
    where: { source },
    create: { source, seenIds: [], processedCount, lastRunAt: new Date() },
    update: { processedCount, lastRunAt: new Date() },
  });
}

export async function countSeenIds(source: string): Promise<number> {
  return prisma.backfillSeenId.count({ where: { source } });
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
    const row = await prisma.backfillCursor.findUnique({
      where: { source },
      select: { resumeCursor: true },
    });
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
        resumeCursor: cursor as unknown as Prisma.InputJsonValue,
        lastRunAt: new Date(),
      },
      update: {
        resumeCursor: cursor as unknown as Prisma.InputJsonValue,
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
    const row = await prisma.backfillCursor.findUnique({
      where: { source },
      select: { processedCount: true, lastRunAt: true },
    });
    return {
      processedCount: row?.processedCount ?? 0,
      lastRunAt: row?.lastRunAt ?? null,
    };
  } catch (err) {
    logger.warn(`[${source}] Could not read backfill status from DB: ${err}`);
    return { processedCount: 0, lastRunAt: null };
  }
}