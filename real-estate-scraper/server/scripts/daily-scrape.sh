#!/usr/bin/env bash
set -euo pipefail

# Daily scrape runner
# - Run at midnight via cron
# - Priority: zillow, propwire, redfin, realtor
# - Then run all other scrapers

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Load environment from .env if present (simple loader)
if [ -f "$ROOT_DIR/.env" ]; then
  # export each non-comment, non-empty line
  while IFS= read -r line; do
    [[ "$line" =~ ^# ]] && continue
    [[ -z "$line" ]] && continue
    key=$(echo "$line" | cut -d'=' -f1)
    val=$(echo "$line" | cut -d'=' -f2-)
    export "$key"="$val"
  done < "$ROOT_DIR/.env"
fi

LOG_DIR="$ROOT_DIR/logs"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/daily-scrape.log"

echo "=== Daily scrape started at $(date -u) ===" >> "$LOG_FILE"

run_and_log() {
  echo "[${1}] START $(date -u)" >> "$LOG_FILE"
  if npm run "$1" >> "$LOG_FILE" 2>&1; then
    echo "[${1}] OK $(date -u)" >> "$LOG_FILE"
  else
    echo "[${1}] FAIL $(date -u)" >> "$LOG_FILE"
  fi
}

# Priority scrapers (run sequentially)
run_and_log scrape:zillow
run_and_log scrape:propwire
run_and_log scrape:redfin
run_and_log scrape:realtor

# Remaining scrapers (also sequential)
run_and_log scrape:investorlift
run_and_log scrape:offmarket
run_and_log scrape:crexi
run_and_log scrape:creativelisting
run_and_log scrape:loopnet
run_and_log scrape:facebook
run_and_log scrape:marketplace
run_and_log scrape:craigslist

echo "=== Daily scrape finished at $(date -u) ===" >> "$LOG_FILE"

exit 0
