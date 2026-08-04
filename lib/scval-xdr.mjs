// A minimal, dependency-free XDR encoder for exactly the ScVal shapes an ASP /
// commitment event carries: Symbol, U64, U256, and a Map of those.
//
// Why hand-rolled rather than pull in @stellar/stellar-base: the read API is
// meant to be a thing other people run without dragging a framework in, and the
// three ScVal arms an SPP event uses are a tiny, fixed subset of XDR. The cost
// of that choice is correctness risk, so it is paid down by a cross-check test
// (test/scval-xdr.test.mjs) that asserts every byte here matches the canonical
// @stellar/stellar-base encoder. If a byte drifts, that test fails.
//
// The point of encoding to base64 XDR at all: Nethermind's SPP client parses
// getEvents into a struct whose `topic: Vec<String>` and `value: String` are
// base64-XDR ScVals (sdk/stellar/src/rpc.rs:112), because its RpcClient does not
// request xdrFormat:"json". A bootnode that serves JSON-shaped events would fail
// to deserialize in their client; serving canonical XDR is what makes it a real
// drop-in.

// ScValType discriminants (stellar-xdr): the four this module encodes.
const SCV_U64 = 5;
const SCV_U256 = 11;
const SCV_SYMBOL = 15;
const SCV_MAP = 17;

function u32(n) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0, 0);
  return b;
}

function u64(nStr) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(nStr));
  return b;
}

// XDR string/opaque: 4-byte length, the bytes, then zero-padding to a 4-byte
// boundary.
function xdrBytes(buf) {
  const pad = (4 - (buf.length % 4)) % 4;
  return Buffer.concat([u32(buf.length), buf, Buffer.alloc(pad)]);
}

// A U256 is four big-endian uint64 limbs, most-significant first: 32 bytes total.
function u256Bytes(decStr) {
  let n = BigInt(decStr);
  if (n < 0n) throw new Error("u256 cannot be negative");
  const b = Buffer.alloc(32);
  for (let i = 31; i >= 0; i--) {
    b[i] = Number(n & 0xffn);
    n >>= 8n;
  }
  if (n !== 0n) throw new Error("u256 out of range");
  return b;
}

export function scvSymbol(s) {
  return Buffer.concat([u32(SCV_SYMBOL), xdrBytes(Buffer.from(s, "utf8"))]);
}

export function scvU64(nStr) {
  return Buffer.concat([u32(SCV_U64), u64(nStr)]);
}

export function scvU256(decStr) {
  return Buffer.concat([u32(SCV_U256), u256Bytes(decStr)]);
}

// ScVal::Map is `SCMap* map;` in XDR — an optional pointer (present-flag) around
// a variable-length array of {key, val} ScVal pairs.
export function scvMap(entries) {
  const parts = [u32(SCV_MAP), u32(1) /* present */, u32(entries.length)];
  for (const { key, val } of entries) parts.push(key, val);
  return Buffer.concat(parts);
}

export const toBase64 = (buf) => buf.toString("base64");

// The two event value maps SPP emits, as canonical base64-XDR ScVals.
export function leafAddedValueXdr({ index, leaf, root }) {
  return toBase64(
    scvMap([
      { key: scvSymbol("index"), val: scvU64(String(index)) },
      { key: scvSymbol("leaf"), val: scvU256(String(leaf)) },
      { key: scvSymbol("root"), val: scvU256(String(root)) },
    ])
  );
}

export function newCommitmentValueXdr({ index, commitment }) {
  return toBase64(
    scvMap([
      { key: scvSymbol("index"), val: scvU64(String(index)) },
      { key: scvSymbol("commitment"), val: scvU256(String(commitment)) },
    ])
  );
}

export const symbolTopicXdr = (s) => toBase64(scvSymbol(s));
