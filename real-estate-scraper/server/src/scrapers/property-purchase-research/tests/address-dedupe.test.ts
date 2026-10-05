import assert from "node:assert/strict";
import { dedupKey } from "../filters/address-dedupe";
import {
  isIndianaZipAllowed,
  validateIndianaLeadZip,
  validateLeadZip,
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

// ── Per-state ZIP gates for the expansion markets ───────────────────────────
const zipCases: Array<[string, string, boolean]> = [
  ["WI", "53208", true],
  ["WI", "54701", false], // Eau Claire
  ["KY", "40202", true],
  ["KY", "41011", false], // Covington
  ["PA", "15213", true],
  ["PA", "19103", false], // Philadelphia
  ["MI", "48201", true], // Detroit
  ["MI", "49007", true], // Kalamazoo
  ["IA", "50701", true], // Waterloo
  ["IA", "52401", false], // Cedar Rapids
  ["OH", "43215", true], // Columbus
  ["OH", "44114", true], // Cleveland
  ["OH", "45202", true], // Cincinnati
  ["OH", "12345", false], // not an Ohio-format ZIP
];
for (const [state, zip, expected] of zipCases) {
  assert.equal(
    validateLeadZip({ state, zip, address: `1 Main St, Town, ${state}` }),
    expected,
    `${state} ${zip} should ${expected ? "pass" : "be rejected"}`,
  );
}
assert.equal(
  validateLeadZip({ state: "PA", address: "1 Main St, Pittsburgh, PA" }),
  false,
  "restricted-state lead with no ZIP should be rejected",
);
assert.equal(
  validateLeadZip({ address: "1 Main St, Pittsburgh, PA 15213" }),
  true,
  "ZIP and state can be read from the address when fields are empty",
);
assert.equal(
  validateLeadZip({ address: "1 Main St, Erie, PA 16501" }),
  false,
  "address-only PA lead outside 15xxx should be rejected",
);

console.log("address dedupe checks passed");
