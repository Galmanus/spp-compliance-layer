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
