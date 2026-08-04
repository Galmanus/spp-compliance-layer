import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../lib/store.mjs";
import {
  dispatch,
  RETENTION_HANDOFF_CODE,
  CACHE_MISS_CODE,
  CUTOFF_LEDGERS,
} from "../lib/bootnode.mjs";

// Drive the bootnode surface exactly as Nethermind's client does
// (sdk/client/src/sync.rs): a getEvents by startLedger, a handoff when the range
// is inside the retention window, a cache-miss on an uncovered range. This test
// is the protocol-compatibility evidence: the request/response shapes and the
// -32002 / -32004 codes match tools/bootnode/src/rpc.rs.

const POOL = "CDP7Z7U2W45KFLQRYUOORZEBJOA7D3XC32IUDNDCWHFAJOJRSCCPBRZR";
const TIP = 4_000_000; // pretend chain tip
const GENESIS = 3_000_000; // well below tip - CUTOFF, so history is pre-retention

function seeded() {
  const s = openStore(":memory:");
  s.registerPool(POOL, GENESIS, "ASP membership");
  // three real-shaped LeafAdded events, fully covered from genesis
  s.ingestBatch(POOL, { fromLedger: GENESIS, toLedger: GENESIS + 30 });
  s.ingestAspRoot(POOL, { leaf: "11", leafIndex: 0, root: "9667", ledger: GENESIS + 10, eventId: "a" });
  s.ingestAspRoot(POOL, { leaf: "22", leafIndex: 1, root: "1185", ledger: GENESIS + 20, eventId: "b" });
  s.ingestAspRoot(POOL, { leaf: "33", leafIndex: 2, root: "2719", ledger: GENESIS + 30, eventId: "c" });
  return s;
}

const getEvents = (params) => dispatch(seeded(), TIP, { jsonrpc: "2.0", id: 1, method: "getEvents", params });

test("getEvents returns pre-retention history in the RPC's own shape", () => {
  const r = getEvents({ filters: [{ contractIds: [POOL] }], startLedger: GENESIS, pagination: {} });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.result.events.length, 3);
  const first = r.result.events[0];
  assert.equal(first.contractId, POOL);
  assert.deepEqual(first.topic, [{ symbol: "LeafAdded" }]);
  // value map has the {index, leaf, root} the wallet decodes
  const keys = first.value.map.map((m) => m.key.symbol);
  assert.deepEqual(keys, ["index", "leaf", "root"]);
  assert.equal(first.value.map[2].val.u256, "9667");
});

test("a range inside the retention window hands off with -32002 and a fromLedger", () => {
  const recent = TIP - CUTOFF_LEDGERS + 100; // inside the window
  const r = getEvents({ filters: [{ contractIds: [POOL] }], startLedger: recent, pagination: {} });
  assert.equal(r.result, undefined);
  assert.equal(r.error.code, RETENTION_HANDOFF_CODE);
  assert.equal(r.error.data.reason, "retention_threshold");
  assert.equal(typeof r.error.data.fromLedger, "number");
});

test("an uncovered range is a cache-miss (-32004), not a silent empty page", () => {
  const s = openStore(":memory:");
  s.registerPool(POOL, GENESIS, "ASP membership");
  // coverage stops short of a later ledger we then ask about
  s.ingestBatch(POOL, { fromLedger: GENESIS, toLedger: GENESIS + 10 });
  const r = dispatch(s, TIP, {
    jsonrpc: "2.0", id: 1, method: "getEvents",
    params: { filters: [{ contractIds: [POOL] }], startLedger: GENESIS, endLedger: GENESIS + 500, pagination: {} },
  });
  assert.equal(r.error.code, CACHE_MISS_CODE);
  assert.ok(r.error.data.missing.length >= 1);
});

test("getCoverage exposes the completeness proof the reference bootnode lacks", () => {
  const r = dispatch(seeded(), TIP, {
    jsonrpc: "2.0", id: 2, method: "getCoverage",
    params: { contractId: POOL },
  });
  assert.equal(r.result.genesis, GENESIS);
  assert.equal(r.result.complete, true);
  assert.deepEqual(r.result.gaps, []);
});

test("getLatestLedger reports the archive tip, never beyond what is covered", () => {
  const r = dispatch(seeded(), TIP, { jsonrpc: "2.0", id: 3, method: "getLatestLedger" });
  assert.ok(r.result.sequence <= TIP);
  assert.ok(r.result.sequence >= GENESIS);
});

test("an unknown method is a proper JSON-RPC method-not-found", () => {
  const r = dispatch(seeded(), TIP, { jsonrpc: "2.0", id: 4, method: "sendTransaction" });
  assert.equal(r.error.code, -32601);
});
