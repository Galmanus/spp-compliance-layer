import { test } from "node:test";
import assert from "node:assert/strict";
import { openStore } from "../lib/store.mjs";

test("coverage merges adjacent spans and reports gaps honestly", () => {
  const s = openStore(":memory:");
  s.registerPool("P", 100, "t");
  s.ingestBatch("P", { fromLedger: 100, toLedger: 200 });
  s.ingestBatch("P", { fromLedger: 201, toLedger: 300 }); // adjacent → merges
  assert.deepEqual(s.coverage("P"), [{ from_ledger: 100, to_ledger: 300 }]);
  assert.deepEqual(s.gaps("P", 300), []);

  s.ingestBatch("P", { fromLedger: 400, toLedger: 500 }); // leaves a gap
  assert.deepEqual(s.gaps("P", 500), [{ from: 301, to: 399 }]);
});

test("a gap before genesis is not invented", () => {
  const s = openStore(":memory:");
  s.registerPool("P", 100, "t");
  s.ingestBatch("P", { fromLedger: 100, toLedger: 250 });
  // asking through 250 with full coverage from genesis: no gaps
  assert.deepEqual(s.gaps("P", 250), []);
});

test("ASP root steps come back in tree order", () => {
  const s = openStore(":memory:");
  s.registerPool("P", 1, "t");
  // insert out of order; query must sort by leaf_index
  s.ingestAspRoot("P", { leaf: "0x3", leafIndex: 2, root: "0xc", ledger: 12, eventId: "e2" });
  s.ingestAspRoot("P", { leaf: "0x1", leafIndex: 0, root: "0xa", ledger: 10, eventId: "e0" });
  s.ingestAspRoot("P", { leaf: "0x2", leafIndex: 1, root: "0xb", ledger: 11, eventId: "e1" });
  assert.deepEqual(
    s.aspRootSteps("P").map((r) => [r.index, r.root]),
    [[0, "0xa"], [1, "0xb"], [2, "0xc"]]
  );
});

test("idempotent ingest: the same event twice is one row", () => {
  const s = openStore(":memory:");
  s.registerPool("P", 1, "t");
  const ev = { leaf: "0x1", leafIndex: 0, root: "0xa", ledger: 10, eventId: "dup" };
  assert.equal(s.ingestAspRoot("P", ev), 1);
  assert.equal(s.ingestAspRoot("P", ev), 0); // ignored
  assert.equal(s.aspRootSteps("P").length, 1);
});

test("state persists across a reopen — it is an index, not a cache", async () => {
  const path = `/tmp/persist-test-${process.pid}.db`;
  const a = openStore(path);
  a.registerPool("P", 100, "t");
  a.ingestBatch("P", { fromLedger: 100, toLedger: 5000 });
  a.close();

  const b = openStore(path); // fresh handle, as a restarted process would open
  assert.deepEqual(b.coverage("P"), [{ from_ledger: 100, to_ledger: 5000 }]);
  b.close();

  for (const ext of ["", "-wal", "-shm"]) {
    try { (await import("node:fs")).unlinkSync(path + ext); } catch {}
  }
});

test("contiguous batches coalesce into one span with no gap (the cursor-page path)", () => {
  const s = openStore(":memory:");
  s.registerPool("P", 100, "t");
  // page 1 covers [100,150]; page 2 (cursor) covers [151,200] — the ingest fix
  // records the second range instead of dropping it. Contiguous → one span.
  s.ingestBatch("P", { fromLedger: 100, toLedger: 150 });
  s.ingestBatch("P", { fromLedger: 151, toLedger: 200 });
  assert.deepEqual(s.coverage("P"), [{ from_ledger: 100, to_ledger: 200 }]);
  assert.deepEqual(s.gaps("P", 200), []);
});

test("commitmentsFrom returns commitments in tree order, filtered by cursor", () => {
  const s = openStore(":memory:");
  s.registerPool("P", 1, "t");
  s.ingestBatch("P", {
    fromLedger: 1, toLedger: 30,
    commitments: [
      { commitment: "c2", leafIndex: 2, ledger: 30, eventId: "e2" },
      { commitment: "c0", leafIndex: 0, ledger: 10, eventId: "e0" },
      { commitment: "c1", leafIndex: 1, ledger: 20, eventId: "e1" },
    ],
  });
  const all = s.commitmentsFrom("P", -1, 100);
  assert.deepEqual(all.map((c) => c.leafIndex), [0, 1, 2], "ordered by leaf index");
  const after0 = s.commitmentsFrom("P", 0, 100);
  assert.deepEqual(after0.map((c) => c.leafIndex), [1, 2], "cursor skips already-seen");
});

test("isSpent and nullifiersFrom track spends", () => {
  const s = openStore(":memory:");
  s.registerPool("P", 1, "t");
  s.ingestBatch("P", {
    fromLedger: 1, toLedger: 10,
    nullifiers: [{ nullifier: "n1", ledger: 5, eventId: "x1" }],
  });
  assert.equal(s.isSpent("P", "n1"), true);
  assert.equal(s.isSpent("P", "n2"), false);
  assert.equal(s.nullifiersFrom("P", 0, 10).length, 1);
});

test("eventsInRange paginates by the paging token without dropping across a boundary", () => {
  const s = openStore(":memory:");
  s.registerPool("P", 1, "t");
  // event ids are the Soroban paging tokens, monotone in ledger order
  s.ingestAspRoot("P", { leaf: "1", leafIndex: 0, root: "a", ledger: 10, eventId: "e001" });
  s.ingestAspRoot("P", { leaf: "2", leafIndex: 1, root: "b", ledger: 11, eventId: "e002" });
  s.ingestAspRoot("P", { leaf: "3", leafIndex: 2, root: "c", ledger: 12, eventId: "e003" });
  const page1 = s.eventsInRange("P", 0, 1000, "", 2);
  assert.deepEqual(page1.map((r) => r.eventId), ["e001", "e002"]);
  const page2 = s.eventsInRange("P", 0, 1000, page1[page1.length - 1].eventId, 2);
  assert.deepEqual(page2.map((r) => r.eventId), ["e003"], "third event not dropped at the page boundary");
});
