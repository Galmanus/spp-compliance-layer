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
  // A caught-up archive: coverage runs from genesis past the retention cutoff, so
  // the archive holds all of its pre-retention responsibility and can serve.
  s.ingestBatch(POOL, { fromLedger: GENESIS, toLedger: TIP });
  s.ingestAspRoot(POOL, { leaf: "11", leafIndex: 0, root: "9667", ledger: GENESIS + 10, eventId: "a" });
  s.ingestAspRoot(POOL, { leaf: "22", leafIndex: 1, root: "1185", ledger: GENESIS + 20, eventId: "b" });
  s.ingestAspRoot(POOL, { leaf: "33", leafIndex: 2, root: "2719", ledger: GENESIS + 30, eventId: "c" });
  return s;
}

const getEvents = (params) => dispatch(seeded(), TIP, { jsonrpc: "2.0", id: 1, method: "getEvents", params });

test("getEvents returns pre-retention history in Stellar RPC's base64-XDR shape", () => {
  const r = getEvents({ filters: [{ contractIds: [POOL] }], startLedger: GENESIS, pagination: {} });
  assert.equal(r.error, undefined, JSON.stringify(r.error));
  assert.equal(r.result.events.length, 3);
  const first = r.result.events[0];
  assert.equal(first.contractId, POOL);
  assert.equal(first.type, "contract");
  assert.equal(typeof first.id, "string");
  // topic is a Vec<String> of base64-XDR ScVals, value a base64-XDR ScVal —
  // the shape the client's struct (sdk/stellar/src/rpc.rs:112) deserializes.
  assert.ok(Array.isArray(first.topic));
  assert.equal(typeof first.topic[0], "string");
  assert.equal(typeof first.value, "string");
  // the LeafAdded topic symbol, canonically encoded
  assert.equal(first.topic[0], "AAAADwAAAAlMZWFmQWRkZWQAAAA=");
  // the response envelope carries every field the client requires, cursor a String
  assert.equal(typeof r.result.latestLedgerCloseTime, "string");
  assert.equal(typeof r.result.oldestLedgerCloseTime, "string");
  assert.equal(typeof r.result.oldestLedger, "number");
  assert.equal(typeof r.result.cursor, "string");
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

test("getLatestLedger reports the chain tip (RPC semantic), and never NaN", () => {
  const r = dispatch(seeded(), TIP, { jsonrpc: "2.0", id: 3, method: "getLatestLedger" });
  assert.equal(r.result.sequence, TIP);
  // with no tip in context, 0 — not NaN, not a stale over-claim
  const r2 = dispatch(seeded(), {}, { jsonrpc: "2.0", id: 3, method: "getLatestLedger" });
  assert.equal(r2.result.sequence, 0);
  assert.equal(r2.result.id, "0");
});

test("an unknown method is a proper JSON-RPC method-not-found", () => {
  const r = dispatch(seeded(), TIP, { jsonrpc: "2.0", id: 4, method: "sendTransaction" });
  assert.equal(r.error.code, -32601);
});

// The bug the audit caught: a behind-the-cutoff archive must NOT serve partial
// history as complete. On a genesis sync with no endLedger the responsibility is
// the whole pre-retention range, so an archive that has not indexed up to the
// cutoff must cache-miss (retry), never return a silently short page.
test("a behind-the-cutoff archive cache-misses on a genesis sync, not a short page", () => {
  const s = openStore(":memory:");
  s.registerPool(POOL, GENESIS, "ASP membership");
  s.ingestBatch(POOL, { fromLedger: GENESIS, toLedger: GENESIS + 30 }); // far behind the cutoff
  s.ingestAspRoot(POOL, { leaf: "11", leafIndex: 0, root: "9667", ledger: GENESIS + 10, eventId: "a" });
  const r = dispatch(s, TIP, {
    jsonrpc: "2.0", id: 1, method: "getEvents",
    params: { filters: [{ contractIds: [POOL] }], startLedger: GENESIS, pagination: {} },
  });
  assert.equal(r.result, undefined, "must not serve a partial page");
  assert.equal(r.error.code, CACHE_MISS_CODE);
});

// getCoverage on a behind archive reports complete=false: it measures against the
// archive's responsibility (to the retention cutoff), not just its own tip.
test("getCoverage reports incomplete when the archive is behind the cutoff", () => {
  const s = openStore(":memory:");
  s.registerPool(POOL, GENESIS, "ASP membership");
  s.ingestBatch(POOL, { fromLedger: GENESIS, toLedger: GENESIS + 30 });
  const r = dispatch(s, TIP, {
    jsonrpc: "2.0", id: 2, method: "getCoverage", params: { contractId: POOL },
  });
  assert.equal(r.result.complete, false, "a far-behind archive is not complete");
  assert.ok(r.result.gaps.length >= 1);
  assert.ok(r.result.measuredThrough > GENESIS + 30);
});

// A caught-up archive, once the wallet has paged through every event, hands off
// (-32002) so the wallet resumes on its own RPC — rather than an empty page that
// reads as "no more history".
test("a caught-up archive hands off once events are exhausted", () => {
  const r = dispatch(seeded(), TIP, {
    jsonrpc: "2.0", id: 5, method: "getEvents",
    // a cursor past the last event: nothing more to serve, at the boundary
    params: { filters: [{ contractIds: [POOL] }], pagination: { cursor: "zzz" } },
  });
  assert.equal(r.result, undefined);
  assert.equal(r.error.code, RETENTION_HANDOFF_CODE);
  assert.equal(r.error.data.reason, "retention_threshold");
});
