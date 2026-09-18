// src/scrapers/property-purchase-research/core/adu-dedupe-tracker.ts
// ─────────────────────────────────────────────────────────────────────────────
// Shared duplicate-suppression tracker for every ADU runner script.
//
// Combines two layers:
//   1. Persistent — loads every dedup key ever emitted to outputs from the DB
//      (AduDedupeKey table) and persists new keys as listings are emitted, so
//      duplicates are caught across runs and across platforms/sources.
//   2. In-memory — keeps the loaded set in this process and de-dupes without a
//      DB round-trip once the key has been seen this run.
// ─────────────────────────────────────────────────────────────────────────────

import {
  loadEmittedDedupeKeys,
  markEmittedDedupeKey,
} from "../../../utils/adu-dedupe-store";
import { dedupKey } from "../filters/address-dedupe";
import { AduResearchListing } from "./adu-research.parser";

export class AduDedupeTracker {
  private seen = new Set<string>();
  private loaded = false;

  private async ensureLoaded(): Promise<Set<string>> {
    if (!this.loaded) {
      this.loaded = true;
      this.seen = await loadEmittedDedupeKeys();
    }
    return this.seen;
  }

  /**
   * Returns true when the listing is new (must be emitted) and records its
   * key both in this process and in the persistent store. Returns false when
   * the listing (by normalized address key) has already been emitted before.
   */
  async track(listing: AduResearchListing): Promise<boolean> {
    const key = dedupKey(listing);
    const seen = await this.ensureLoaded();
    if (seen.has(key)) return false;
    seen.add(key);
    await markEmittedDedupeKey(key);
    return true;
  }
}