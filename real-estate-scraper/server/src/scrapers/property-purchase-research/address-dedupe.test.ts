import assert from "node:assert/strict";
import { dedupKey } from "./address-dedupe";

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

console.log("address dedupe checks passed");
