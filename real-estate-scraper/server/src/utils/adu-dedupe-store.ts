// src/utils/adu-dedupe-store.ts
// ─────────────────────────────────────────────────────────────────────────────
// Persistent cross-run, cross-platform duplicate suppression for the ADU
// research pipeline.
//
// Every listing that is emitted to outputs (CSV/JSON/Google Sheets) is recorded
// by its normalized dedup key (e.g. "17191 sagamore rd|44146") in the
// AduDedupeKey table. Runners load all keys at startup and mark new keys as
// they emit, so the same physical property is never written twice — even when
// produced by different platforms (coldwell vs zillow) or in separate runs.
// ─────────────────────────────────────────────────────────────────────────────

import { prisma } from "../db/client";
import { logger } from "./logger";

export async function loadEmittedDedupeKeys(): Promise<Set<string>> {
  try {
    const rows = await prisma.aduDedupeKey.findMany({
      select: { dedupKey: true },
    });
    const keys = new Set(rows.map((r) => r.dedupKey));
    logger.info(`[dedupe-store] Loaded ${keys.size} emitted dedupe keys from DB`);
    return keys;
  } catch (err) {
    logger.warn(`[dedupe-store] Could not load emitted dedupe keys: ${err}`);
    return new Set();
  }
}

export async function markEmittedDedupeKey(key: string): Promise<void> {
  try {
    await prisma.aduDedupeKey.upsert({
      where: { dedupKey: key },
      create: { dedupKey: key },
      update: {},
    });
  } catch (err) {
    logger.warn(`[dedupe-store] Could not persist dedupe key "${key}": ${err}`);
  }
}