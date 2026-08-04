import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeEvent } from "../lib/decode.mjs";

// The RPC's JSON-XDR renders a u256 as a decimal string in some versions and as
// four 64-bit limbs in others. If the same root arrived once each way, a naive
// decoder would key one value as two — the canonicalization bug that cost a
// sibling project a double-spend. These tests pin that both encodings fold to a
// single decimal string, so anything keying on the root (the asp_roots table,
// the attestation input) sees one value, not two.

const mkLeafAdded = (rootVal) => ({
  id: "e",
  ledger: 1,
  contractId: "C",
  topicJson: [{ symbol: "LeafAdded" }],
  valueJson: {
    map: [
      { key: { symbol: "index" }, val: { u64: "0" } },
      { key: { symbol: "leaf" }, val: { u256: "5" } },
      { key: { symbol: "root" }, val: rootVal },
    ],
  },
});

test("u256 decimal and limb encodings canonicalize to the same string", () => {
  // 2^64 + 3, expressed as a decimal string and as {hi_hi..lo_lo} limbs.
  const asDecimal = decodeEvent(mkLeafAdded({ u256: "18446744073709551619" })).root;
  const asLimbs = decodeEvent(
    mkLeafAdded({ hi_hi: "0", hi_lo: "0", lo_hi: "1", lo_lo: "3" })
  ).root;
  assert.equal(asDecimal, "18446744073709551619");
  assert.equal(asLimbs, asDecimal, "same value in two encodings must key identically");
});

test("a real full-width root round-trips through canonicalization unchanged", () => {
  const real =
    "9667236958756909525649769644727778012477910539601936707706602150991285581632";
  const d = decodeEvent(mkLeafAdded({ u256: real }));
  assert.equal(d.kind, "asp_root");
  assert.equal(d.root, real);
  assert.equal(d.leafIndex, 0);
});

test("a hex-tagged u256 folds to the same decimal as its plain form", () => {
  const asHex = decodeEvent(mkLeafAdded({ u256: "0xff" })).root;
  const asDec = decodeEvent(mkLeafAdded({ u256: "255" })).root;
  assert.equal(asHex, "255");
  assert.equal(asHex, asDec);
});
