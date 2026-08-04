import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  scvSymbol,
  scvU64,
  scvU256,
  scvMap,
  toBase64,
  leafAddedValueXdr,
  symbolTopicXdr,
} from "../lib/scval-xdr.mjs";

// Cross-check the dependency-free encoder against the canonical
// @stellar/stellar-base, byte for byte. The SDK is not a dependency of this
// project; it is loaded here from a local install purely to validate the
// hand-rolled encoder. If a byte drifts from canonical XDR, this fails.
//
// If the SDK is not present (a fresh clone on a machine without it), these
// checks skip rather than fail — the encoder is still exercised by the bootnode
// tests. Where a developer HAS the SDK, this is the proof of byte-exactness.
const require = createRequire(import.meta.url);
let xdr = null;
for (const p of [
  "/home/galmanus/ramp-kit/node_modules/@stellar/stellar-base",
  "@stellar/stellar-base",
]) {
  try {
    ({ xdr } = require(p));
    break;
  } catch {
    /* try next */
  }
}

const canonicalU256 = (dec) => {
  let n = BigInt(dec);
  const p = [];
  for (let i = 0; i < 4; i++) {
    p.unshift(n & ((1n << 64n) - 1n));
    n >>= 64n;
  }
  return xdr.ScVal.scvU256(
    new xdr.UInt256Parts({
      hiHi: xdr.Uint64.fromString(p[0].toString()),
      hiLo: xdr.Uint64.fromString(p[1].toString()),
      loHi: xdr.Uint64.fromString(p[2].toString()),
      loLo: xdr.Uint64.fromString(p[3].toString()),
    })
  );
};

test("scval-xdr matches @stellar/stellar-base byte for byte", { skip: !xdr }, () => {
  // Symbol
  assert.equal(symbolTopicXdr("LeafAdded"), xdr.ScVal.scvSymbol("LeafAdded").toXDR("base64"));
  assert.equal(toBase64(scvSymbol("index")), xdr.ScVal.scvSymbol("index").toXDR("base64"));

  // U64
  assert.equal(toBase64(scvU64("12")), xdr.ScVal.scvU64(xdr.Uint64.fromString("12")).toXDR("base64"));
  assert.equal(toBase64(scvU64("0")), xdr.ScVal.scvU64(xdr.Uint64.fromString("0")).toXDR("base64"));

  // U256 across magnitudes, including a full-width real root
  for (const v of ["0", "9667", "18446744073709551619",
    "9667236958756909525649769644727778012477910539601936707706602150991285581632"]) {
    assert.equal(toBase64(scvU256(v)), canonicalU256(v).toXDR("base64"), `u256 ${v}`);
  }

  // The full LeafAdded value map
  const entry = (k, v) => new xdr.ScMapEntry({ key: xdr.ScVal.scvSymbol(k), val: v });
  const canonMap = xdr.ScVal.scvMap([
    entry("index", xdr.ScVal.scvU64(xdr.Uint64.fromString("0"))),
    entry("leaf", canonicalU256("11")),
    entry("root", canonicalU256("9667")),
  ]).toXDR("base64");
  assert.equal(leafAddedValueXdr({ index: 0, leaf: "11", root: "9667" }), canonMap);
});

test("encoded ScVals round-trip back through the SDK to the same native values", { skip: !xdr }, () => {
  const { scValToNative } = require("/home/galmanus/ramp-kit/node_modules/@stellar/stellar-base");
  const v = leafAddedValueXdr({ index: 7, leaf: "42", root: "9667" });
  const native = scValToNative(xdr.ScVal.fromXDR(v, "base64"));
  assert.equal(native.index.toString(), "7");
  assert.equal(native.leaf.toString(), "42");
  assert.equal(native.root.toString(), "9667");
});
