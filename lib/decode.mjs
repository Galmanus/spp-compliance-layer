// Turning an RPC event into a row.
//
// The pool emits exactly two events, and their shapes decide everything a
// wallet can do (`contracts/pool/src/pool.rs:187-210` in
// NethermindEth/stellar-private-payments):
//
//   NewCommitmentEvent  topic: commitment (U256)
//                       data:  { index: u32, encrypted_output: Bytes }
//
//   NewNullifierEvent   topic: nullifier (U256)
//
// The commitment's `encrypted_output` is the whole reason note discovery is
// expensive: a wallet cannot ask "which of these is mine", it must attempt
// decryption on every one. That is why the history has to be complete, and why
// an index that silently drops events is worse than no index — a wallet that
// scans an incomplete set does not error, it concludes it owns nothing.
//
// Events arrive base64-XDR encoded unless `xdrFormat: "json"` is requested.
// This decoder handles the JSON shape and keeps the raw payload alongside, so
// nothing is lost to a decoding assumption that turns out wrong: the raw is
// what a future reader can re-parse, the parsed fields are a convenience.

/** Event topics carry the event name as their first element. */
function topicName(topics) {
  const first = topics?.[0];
  if (typeof first === "string") return first;
  return first?.symbol ?? first?.sym ?? null;
}

/** Read a value out of a JSON-XDR event map by its symbol key. */
function mapField(value, key) {
  const entries = value?.map;
  if (!Array.isArray(entries)) return undefined;
  const hit = entries.find((e) => (e.key?.symbol ?? e.key?.sym) === key);
  return hit?.val;
}

/** Pull a U256 out of whatever shape the RPC handed us, as a hex string. */
function readU256(v) {
  // Canonicalize every U256 encoding to ONE representation — a decimal string.
  //
  // This is not cosmetic. The RPC's JSON-XDR renders a u256 as a decimal
  // string in some versions and as four 64-bit limbs in others. If the same
  // root arrived once as decimal and once as limbs, a naive decoder would
  // produce two different strings for one value, and the index would treat one
  // root as two — the canonicalization bug class that cost a sibling project a
  // double-spend. Folding both encodings through BigInt to a single decimal
  // makes the representation unique, which is what any code keying on it (the
  // asp_roots table, the attestation input) silently assumes.
  const big = toBigIntU256(v);
  return big == null ? null : big.toString(10);
}

function toBigIntU256(v) {
  if (v == null) return null;
  if (typeof v === "string") {
    try { return v.startsWith("0x") ? BigInt(v) : BigInt(v); } catch { return null; }
  }
  if (typeof v === "object") {
    if (v.u256 != null) return toBigIntU256(v.u256);
    if (v.string != null) return toBigIntU256(v.string);
    // Four 64-bit limbs, most-significant first.
    if (v.hi_hi != null) {
      const hh = BigInt(v.hi_hi), hl = BigInt(v.hi_lo),
            lh = BigInt(v.lo_hi), ll = BigInt(v.lo_lo);
      return (hh << 192n) | (hl << 128n) | (lh << 64n) | ll;
    }
  }
  return null;
}

function readU32(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  // Soroban indices arrive as u64 or u32 depending on the field; accept both.
  if (typeof v === "object") {
    if (v.u32 != null) return Number(v.u32);
    if (v.u64 != null) return Number(v.u64);
    if (v.i128 != null) return Number(v.i128);
  }
  return null;
}

function readBytes(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object" && v.bytes != null) return v.bytes;
  return null;
}

/**
 * Classify and decode one RPC event.
 *
 * Returns `{ kind, ...fields }` for the two events this index cares about, and
 * `{ kind: "other" }` for anything else — including events this decoder does
 * not recognise. Unknown events are counted rather than dropped silently,
 * because "the pool emitted something we did not understand" is information a
 * compliance index has no business swallowing.
 */
export function decodeEvent(ev) {
  const base = {
    eventId: ev.id,
    ledger: ev.ledger,
    txHash: ev.txHash ?? ev.transactionHash ?? null,
    contractId: ev.contractId,
    raw: JSON.stringify({ topic: ev.topic ?? ev.topicJson, value: ev.value ?? ev.valueJson }),
  };

  const topics = ev.topicJson ?? ev.topic ?? [];
  const name = topicName(topics);
  const value = ev.valueJson ?? ev.value;
  const field = (k) => mapField(value, k);

  if (name === "NewCommitmentEvent" || name === "new_commitment") {
    return {
      ...base,
      kind: "commitment",
      commitment: readU256(topics[1]),
      leafIndex: readU32(value?.index ?? value?.[0]),
      encryptedOutput: readBytes(value?.encrypted_output ?? value?.[1]),
    };
  }

  if (name === "NewNullifierEvent" || name === "new_nullifier") {
    return { ...base, kind: "nullifier", nullifier: readU256(topics[1]) };
  }

  // ASP LeafAddedEvent(leaf, index, root): the append-only root history the
  // Layer-3 attestation proves a chain over. The event's topic is the symbol
  // "LeafAdded" and its value is a map {index:u64, leaf:u256, root:u256}
  // (asp-membership lib.rs:52). Verified against the real JSON-XDR event shape.
  if (name === "LeafAdded" || name === "LeafAddedEvent" || name === "leaf_added") {
    return {
      ...base,
      kind: "asp_root",
      leaf: readU256(field("leaf")),
      leafIndex: readU32(field("index")),
      root: readU256(field("root")),
    };
  }

  return { ...base, kind: "other", name };
}
