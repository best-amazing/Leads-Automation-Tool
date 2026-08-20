// Shared, in-memory ADU research run state. Mutated by the cron watchdog and
// the scraper, and surfaced by the /api/healthcheck heartbeat so liveness and
// progress can be observed even when the Render log viewer is wedged.

export const aduRunState = {
  running: false,
  startedAt: 0,
  lastProgressAt: 0,
  listingsProcessed: 0,
  skippedSeen: 0,
  matched: 0,
  rssMB: 0,
  heapMB: 0,
};