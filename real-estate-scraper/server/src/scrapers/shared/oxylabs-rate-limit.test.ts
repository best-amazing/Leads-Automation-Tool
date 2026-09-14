import assert from "node:assert/strict";
import {
  getOxylabsCooldownRemainingMs,
  markOxylabsRateLimited,
} from "./oxylabs";

const scope = "zillow";
const delayMs = markOxylabsRateLimited(scope, 1, "https://www.zillow.com/in/");
assert.ok(delayMs >= 45_000, `expected backoff >= 45s, got ${delayMs}`);
assert.ok(
  getOxylabsCooldownRemainingMs(scope) > 0,
  "rate-limit cooldown should be active after a 429",
);
console.log("oxylabs rate-limit test passed");
