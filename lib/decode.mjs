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

/** Pull a U256 out of whatever shape the RPC handed us, as a hex string. */
function readU256(v) {
  if (v == null) return null;
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    // JSON XDR renders u256 as an object of 64-bit limbs, or as a decimal
    // string depending on version. Accept both rather than guess one.
    if (v.u256 != null) return readU256(v.u256);
    if (v.hi_hi != null) {
      const parts = [v.hi_hi, v.hi_lo, v.lo_hi, v.lo_lo].map((x) =>
        BigInt(x).toString(16).padStart(16, "0")
      );
      return "0x" + parts.join("");
    }
    if (v.string != null) return v.string;
  }
  return JSON.stringify(v);
}

function readU32(v) {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v === "string") return Number(v);
  if (typeof v === "object" && v.u32 != null) return Number(v.u32);
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

  return { ...base, kind: "other", name };
}
