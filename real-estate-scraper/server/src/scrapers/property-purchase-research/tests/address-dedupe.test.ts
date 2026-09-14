import assert from "node:assert/strict";
import { dedupKey } from "../filters/address-dedupe";
import {
  isIndianaZipAllowed,
  validateIndianaLeadZip,
} from "../filters/adu-research.scraper";

const a = { address: "53316 Nadine Street, South Bend, IN, 46637" };
const b = {
  address: "53316 Nadine St, South Bend, IN 46637, South Bend, IN, 46637",
};
const c = { address: "53317 Nadine Street, South Bend, IN, 46637" };

assert.equal(
  dedupKey(a),
  dedupKey(b),
  "same address with different formatting should dedupe",
);
assert.notEqual(dedupKey(a), dedupKey(c), "different street should not dedupe");

assert.equal(
  isIndianaZipAllowed("46637"),
  true,
  "46xxx Indiana ZIP should pass",
);
assert.equal(
  isIndianaZipAllowed("46311"),
  true,
  "another 46xxx ZIP should pass",
);
assert.equal(
  isIndianaZipAllowed("47201"),
  false,
  "non-46xxx Indiana ZIP should be rejected",
);
assert.equal(
  validateIndianaLeadZip({
    state: "IN",
    zip: "47201",
    address: "123 Main St, Bloomington, IN",
  }),
  false,
  "Indiana listings outside 46xxx ZIP should be rejected",
);
assert.equal(
  validateIndianaLeadZip({
    state: "IN",
    zip: "46637",
    address: "123 Main St, South Bend, IN",
  }),
  true,
  "Indiana listings in 46xxx ZIP should pass",
);

console.log("address dedupe checks passed");
