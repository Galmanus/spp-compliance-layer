import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { openStore } from "../lib/store.mjs";
import { dispatch } from "../lib/bootnode.mjs";

// The decisive drop-in proof. Nethermind's SPP client parses getEvents into a
// struct (sdk/stellar/src/rpc.rs:112) whose required fields are, verbatim:
//
//   GetEventsResponse { events, latestLedger, latestLedgerCloseTime,
//                       oldestLedger, oldestLedgerCloseTime, cursor:String }
//   Event { type, ledger, ledgerClosedAt, contractId, id,
//           topic: Vec<String>, value: String }   // topic/value = base64 XDR
//
// This test builds a real getEvents response from the bootnode and proves it
// would deserialize in their client: every required field is present with the
// serde-correct JSON type, and each event's topic/value is valid canonical XDR
// that decodes (via @stellar/stellar-base, the same codec) to the native values
// the wallet expects.
const require = createRequire(import.meta.url);
let base = null;
try {
  base = require("@stellar/stellar-base");
} catch {
  /* not installed — the XDR-decode check skips */
}

const POOL = "CDP7Z7U2W45KFLQRYUOORZEBJOA7D3XC32IUDNDCWHFAJOJRSCCPBRZR";
const TIP = 4_000_000;
const GENESIS = 3_000_000;

function seeded() {
  const s = openStore(":memory:");
  s.registerPool(POOL, GENESIS, "ASP membership");
  s.ingestBatch(POOL, { fromLedger: GENESIS, toLedger: TIP });
  s.ingestAspRoot(POOL, { leaf: "11", leafIndex: 0, root: "9667", ledger: GENESIS + 10, eventId: "a" });
  s.ingestAspRoot(POOL, { leaf: "22", leafIndex: 1, root: "1185", ledger: GENESIS + 20, eventId: "b" });
  s.ingestAspRoot(POOL, { leaf: "33", leafIndex: 2, root: "2719", ledger: GENESIS + 30, eventId: "c" });
  return s;
}

const ctx = {
  tip: TIP,
  protocolVersion: 22,
  retention: { oldestLedger: 2_900_000, latestLedgerCloseTime: 1785000000, oldestLedgerCloseTime: 1784400000 },
};

// A stand-in for the serde requirement: these fields must exist with these JS
// types, or the client's deserialize fails. Kept as data so the assertion reads
// like the struct it mirrors.
const RESPONSE_FIELDS = {
  events: "object", // array
  latestLedger: "number",
  latestLedgerCloseTime: "string",
  oldestLedger: "number",
  oldestLedgerCloseTime: "string",
  cursor: "string",
};
const EVENT_FIELDS = {
  type: "string",
  ledger: "number",
  ledgerClosedAt: "string",
  contractId: "string",
  id: "string",
  topic: "object", // array of strings
  value: "string",
};

test("getEvents response has every field the client's struct requires, correctly typed", () => {
  const r = dispatch(seeded(), ctx, {
    jsonrpc: "2.0", id: 1, method: "getEvents",
    params: { filters: [{ contractIds: [POOL] }], startLedger: GENESIS, pagination: {} },
  });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  const res = r.result;
  for (const [field, type] of Object.entries(RESPONSE_FIELDS)) {
    assert.equal(typeof res[field], type, `response.${field} must be ${type}`);
  }
  assert.ok(Array.isArray(res.events) && res.events.length === 3);
  for (const ev of res.events) {
    for (const [field, type] of Object.entries(EVENT_FIELDS)) {
      assert.equal(typeof ev[field], type, `event.${field} must be ${type}`);
    }
    assert.ok(Array.isArray(ev.topic) && ev.topic.every((t) => typeof t === "string"));
  }
});

test("each event's topic/value is canonical XDR that decodes to the wallet's native values", { skip: !base }, () => {
  const { xdr, scValToNative } = base;
  const r = dispatch(seeded(), ctx, {
    jsonrpc: "2.0", id: 2, method: "getEvents",
    params: { filters: [{ contractIds: [POOL] }], startLedger: GENESIS, pagination: {} },
  });
  const roots = ["9667", "1185", "2719"];
  r.result.events.forEach((ev, i) => {
    // topic decodes to the symbol "LeafAdded"
    const topic0 = scValToNative(xdr.ScVal.fromXDR(ev.topic[0], "base64"));
    assert.equal(topic0, "LeafAdded");
    // value decodes to the {index, leaf, root} map the wallet reads
    const val = scValToNative(xdr.ScVal.fromXDR(ev.value, "base64"));
    assert.equal(val.index.toString(), String(i));
    assert.equal(val.root.toString(), roots[i]);
  });
});
